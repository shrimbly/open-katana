import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type CommandError, run } from "../util/proc.js";
import type { ApiPrompt } from "./graph.js";

export type BackendKind = "http" | "cloud" | "comfy-cli";

export interface BackendConfig {
  kind: BackendKind;
  /** ComfyUI base URL for http/cloud (default http://127.0.0.1:8188 or https://cloud.comfy.org). */
  url?: string;
  /** Comfy Cloud API key (cloud) or a bearer token for a protected remote ComfyUI (http). */
  apiKey?: string;
  /** Extra request headers for http backends behind a proxy. */
  headers?: Record<string, string>;
  /** comfy-cli routing target. */
  where?: "cloud" | "local";
}

export interface OutputFile {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
  /** Direct download URL when the backend already resolved one. */
  url?: string;
  /** Job that produced the file (needed by backends that download per job). */
  promptId?: string;
}

export type JobState = "pending" | "running" | "completed" | "error" | "cancelled";

export interface JobPoll {
  state: JobState;
  outputs: OutputFile[];
  error?: string;
}

export interface BackendCheck {
  ok: boolean;
  kind: BackendKind;
  target: string;
  detail: string;
  version?: string;
}

/** Input choices per loader input name, e.g. `unet_name` → available diffusion models. */
export type ModelChoices = Map<string, Set<string>>;

export interface Backend {
  readonly kind: BackendKind;
  readonly target: string;
  /** The server fetches model files it does not list in object_info (Comfy Cloud). */
  readonly onDemandModels?: boolean;
  check(): Promise<BackendCheck>;
  /** Node class names and loader choices from /object_info. Undefined when the backend cannot list them. */
  catalog(): Promise<{ nodes: Set<string>; models: ModelChoices } | undefined>;
  upload(path: string): Promise<string>;
  /**
   * Queues a prompt and returns the id the backend gave it. `promptId` asks for that id (a canonical UUID);
   * backends that pick their own ignore it, so always use the returned one.
   */
  submit(prompt: ApiPrompt, opts?: { promptId?: string }): Promise<string>;
  poll(promptId: string): Promise<JobPoll>;
  download(file: OutputFile, dest: string): Promise<void>;
  /**
   * Stops a queued or running job. Resolves once the backend confirmed it (or the job is unknown or already
   * over); rejects when the cancel could not be confirmed, so the caller keeps the job open and says so.
   */
  cancel(promptId: string): Promise<void>;
}

interface ObjectInfoNode {
  input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> };
}

function parseCatalog(info: Record<string, ObjectInfoNode>): { nodes: Set<string>; models: ModelChoices } {
  const models: ModelChoices = new Map();
  for (const node of Object.values(info)) {
    for (const group of [node.input?.required, node.input?.optional]) {
      for (const [name, spec] of Object.entries(group ?? {})) {
        const choices = Array.isArray(spec) ? spec[0] : undefined;
        if (!Array.isArray(choices) || !choices.some((c) => typeof c === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(c))) continue;
        const set = models.get(name) ?? new Set<string>();
        for (const c of choices) if (typeof c === "string") set.add(c);
        models.set(name, set);
      }
    }
  }
  return { nodes: new Set(Object.keys(info)), models };
}

/** Collects every file-like entry from a ComfyUI history `outputs` record. */
export function collectOutputs(outputs: Record<string, Record<string, unknown>> | undefined): OutputFile[] {
  const files: OutputFile[] = [];
  for (const [nodeId, out] of Object.entries(outputs ?? {})) {
    for (const value of Object.values(out ?? {})) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === "object" && "filename" in item) {
          const f = item as { filename: string; subfolder?: string; type?: string };
          files.push({ nodeId, filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
        }
      }
    }
  }
  return files;
}

async function multipartUpload(url: string, path: string, headers: Record<string, string>): Promise<string> {
  const form = new FormData();
  const bytes = await readFile(path);
  form.append("image", new Blob([bytes]), basename(path));
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await fetch(url, { method: "POST", headers, body: form });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { name: string; subfolder?: string };
  return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
}

/** A local or remote ComfyUI server speaking the standard HTTP API. */
export class HttpBackend implements Backend {
  readonly kind = "http" as const;
  readonly target: string;
  private readonly headers: Record<string, string>;
  private catalogCache?: { nodes: Set<string>; models: ModelChoices };
  private readonly clientId = randomUUID();

  constructor(cfg: BackendConfig) {
    this.target = (cfg.url ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
    this.headers = { ...(cfg.headers ?? {}), ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) };
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.target}${path}`, { ...init, headers: { ...this.headers, ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return (await res.json()) as T;
  }

  async check(): Promise<BackendCheck> {
    try {
      const stats = await this.json<{ system?: { comfyui_version?: string }; devices?: { name: string; vram_total?: number }[] }>("/system_stats");
      const dev = stats.devices?.[0];
      const vram = dev?.vram_total ? `${Math.round(dev.vram_total / 2 ** 30)} GB` : "unknown VRAM";
      return { ok: true, kind: this.kind, target: this.target, version: stats.system?.comfyui_version, detail: `${dev?.name ?? "device"} (${vram})` };
    } catch (e) {
      return { ok: false, kind: this.kind, target: this.target, detail: `Not reachable: ${(e as Error).message}` };
    }
  }

  async catalog() {
    this.catalogCache ??= parseCatalog(await this.json<Record<string, ObjectInfoNode>>("/object_info"));
    return this.catalogCache;
  }

  upload(path: string): Promise<string> {
    return multipartUpload(`${this.target}/upload/image`, path, this.headers);
  }

  async submit(prompt: ApiPrompt, opts: { promptId?: string } = {}): Promise<string> {
    // ComfyUI takes a client-chosen prompt_id (a UUID), so a job recorded before the submit can be cancelled by it.
    const body = await this.json<{ prompt_id: string; node_errors?: Record<string, unknown> }>("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, client_id: this.clientId, ...(opts.promptId ? { prompt_id: opts.promptId } : {}) }),
    });
    return body.prompt_id;
  }

  async poll(promptId: string): Promise<JobPoll> {
    const history = await this.json<Record<string, { status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] }; outputs?: Record<string, Record<string, unknown>> }>>(`/history/${promptId}`);
    const record = history[promptId];
    if (!record) {
      const queue = await this.json<{ queue_running: unknown[][]; queue_pending: unknown[][] }>("/queue");
      const running = queue.queue_running.some((q) => q[1] === promptId);
      const pending = queue.queue_pending.some((q) => q[1] === promptId);
      return { state: running ? "running" : pending ? "pending" : "pending", outputs: [] };
    }
    const status = record.status?.status_str;
    if (status === "error") {
      const err = record.status?.messages?.find((m) => m[0] === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;
      return { state: "error", outputs: [], error: err ? `${err.node_type}: ${err.exception_message}` : "execution error" };
    }
    return { state: record.status?.completed ? "completed" : "running", outputs: collectOutputs(record.outputs) };
  }

  async download(file: OutputFile, dest: string): Promise<void> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const res = await fetch(`${this.target}/view?${q}`, { headers: this.headers });
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${file.filename}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }

  /**
   * Removes the prompt from the queue, and interrupts it only when it is the one running: a bare /interrupt
   * stops whatever ComfyUI is executing, which may be another project's job.
   */
  async cancel(promptId: string): Promise<void> {
    const queue = await this.json<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue");
    const running = (queue.queue_running ?? []).some((q) => q[1] === promptId);
    await this.json("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
    if (running) {
      const res = await fetch(`${this.target}/interrupt`, { method: "POST", headers: { ...this.headers, "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: promptId }) });
      if (!res.ok) throw new Error(`POST /interrupt → ${res.status}`);
    }
  }
}

const CLOUD_STATES: Record<string, JobState> = {
  pending: "pending", submitted: "pending", queued_waiting: "pending", preparing: "pending",
  in_progress: "running", executing: "running", running: "running",
  completed: "completed", success: "completed",
  failed: "error", error: "error", non_retryable_error: "error", retryable_error: "error", lost: "error",
  cancelled: "cancelled", canceled: "cancelled",
};

/** Comfy Cloud via its HTTP API and an API key (X-API-Key). */
export class CloudBackend implements Backend {
  readonly kind = "cloud" as const;
  readonly target: string;
  readonly onDemandModels = true;
  private readonly headers: Record<string, string>;
  private catalogCache?: { nodes: Set<string>; models: ModelChoices };

  constructor(cfg: BackendConfig) {
    if (!cfg.apiKey) throw new Error("Comfy Cloud needs an API key: set COMFY_CLOUD_API_KEY (platform.comfy.org) or use the comfy-cli backend.");
    this.target = (cfg.url ?? "https://cloud.comfy.org").replace(/\/+$/, "");
    this.headers = { "X-API-Key": cfg.apiKey };
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.target}/api${path}`, { ...init, headers: { ...this.headers, ...(init.headers ?? {}) } });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      if (res.status === 402) throw new Error(OUT_OF_CREDITS);
      const hint = res.status === 429 ? " (subscription inactive or rate limited)" : "";
      throw new Error(`${init.method ?? "GET"} /api${path} → ${res.status}${hint}: ${text}`);
    }
    return (await res.json()) as T;
  }

  async check(): Promise<BackendCheck> {
    try {
      const user = await this.json<{ email?: string; id?: string }>("/user");
      return { ok: true, kind: this.kind, target: this.target, detail: `signed in${user.email ? ` as ${user.email}` : ""}` };
    } catch (e) {
      return { ok: false, kind: this.kind, target: this.target, detail: (e as Error).message };
    }
  }

  async catalog() {
    this.catalogCache ??= parseCatalog(await this.json<Record<string, ObjectInfoNode>>("/object_info"));
    return this.catalogCache;
  }

  upload(path: string): Promise<string> {
    return multipartUpload(`${this.target}/api/upload/image`, path, this.headers);
  }

  async submit(prompt: ApiPrompt): Promise<string> {
    const body = await this.json<{ prompt_id: string }>("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    return body.prompt_id;
  }

  async poll(promptId: string): Promise<JobPoll> {
    const job = await this.json<{ status?: string; execution_error?: { node_type?: string; exception_message?: string }; error_message?: string }>(`/jobs/${promptId}`);
    const state = CLOUD_STATES[(job.status ?? "pending").toLowerCase()] ?? "pending";
    if (state === "error") {
      const e = job.execution_error;
      return { state, outputs: [], error: creditsError(e ? `${e.node_type}: ${e.exception_message}` : (job.error_message ?? "failed")) };
    }
    if (state !== "completed") return { state, outputs: [] };
    const history = await this.json<Record<string, { outputs?: Record<string, Record<string, unknown>> }>>(`/history_v2/${promptId}`);
    const record = history[promptId] ?? Object.values(history)[0];
    return { state, outputs: collectOutputs(record?.outputs) };
  }

  async download(file: OutputFile, dest: string): Promise<void> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    // /api/view redirects to a signed storage URL; never forward the API key to that host.
    const res = await fetch(`${this.target}/api/view?${q}`, { headers: this.headers, redirect: "manual" });
    const location = res.headers.get("location");
    const final = location ? await fetch(location) : res;
    if (!final.ok) throw new Error(`Download failed (${final.status}) for ${file.filename}`);
    await writeFile(dest, Buffer.from(await final.arrayBuffer()));
  }

  async cancel(promptId: string): Promise<void> {
    const res = await fetch(`${this.target}/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: "POST", headers: this.headers });
    // Unknown or already over: nothing left to stop.
    if (res.ok || res.status === 404 || res.status === 409) return;
    throw new Error(`POST /api/jobs/${promptId}/cancel → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

interface CliEnvelope<T> {
  ok: boolean;
  data: T;
  error?: { code: string; message: string; hint?: string; details?: unknown } | null;
}

/** The cloud workspace can't queue work until it has credits or a subscription again. */
export const OUT_OF_CREDITS =
  "Comfy Cloud refused the job: the workspace has no credits left (HTTP 402). Stop generating and tell the user to add credits at https://platform.comfy.org (or point katana_backend at another ComfyUI). Jobs already finished are kept.";

/** Job-level payment failures read the same as submission ones. */
function creditsError(message: string): string {
  return /payment required|insufficientfunds|insufficient credits/i.test(message) ? OUT_OF_CREDITS : message;
}

function parseEnvelope<T>(stdout: Buffer | undefined): CliEnvelope<T> | undefined {
  const text = stdout?.toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text.slice(text.indexOf("{"))) as CliEnvelope<T>;
  } catch {
    return undefined;
  }
}

/** True when a CLI pre-check failure is only about model files missing from its catalog. */
export function onlyUnlistedModels(e: Error & { code?: string }): boolean {
  if (e.code !== "workflow_unknown_nodes") return false;
  const issues = e.message.split(/node \d+:/).slice(1);
  // A model file the catalog doesn't list (Comfy Cloud loads many on demand), whatever the input is called:
  // unet_name, lora_name, ckpt_name, or ModelPatchLoader's plain "name". The pre-check also flags an
  // empty autogrow input (Qwen-Image 2.1's text encoder in text-to-image mode, as Comfy's own template
  // runs it); the server is the judge of that, and its error comes back if it disagrees.
  const unlisted = (i: string) => /'[^']+\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)' not in \d+ known options for \w+/.test(i);
  const emptyAutogrow = (i: string) => /required autogrow input '[^']+' has no connected slots/.test(i);
  return issues.length > 0 && issues.every((i) => unlisted(i) || emptyAutogrow(i));
}

/** Credentials for Comfy Cloud: COMFY_CLOUD_API_KEY, else the comfy CLI's stored API key or sign-in. */
function cloudCredentials(): Record<string, string> | undefined {
  if (process.env.COMFY_CLOUD_API_KEY) return { "X-API-Key": process.env.COMFY_CLOUD_API_KEY };
  const home = homedir();
  const dirs = [
    process.env.COMFY_CLI_CONFIG_DIR,
    join(home, "Library", "Application Support", "comfy-cli"),
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "comfy-cli"),
    process.env.APPDATA ? join(process.env.APPDATA, "comfy-cli") : undefined,
  ].filter(Boolean) as string[];
  for (const dir of dirs) {
    const file = join(dir, "secrets.json");
    if (!existsSync(file)) continue;
    try {
      const secrets = JSON.parse(readFileSync(file, "utf8")) as {
        providers?: Record<string, { key?: string }>;
        cloud_session?: { tokens?: { access_token?: string; expires_at?: number } };
      };
      const key = secrets.providers?.["comfy-cloud-api-key"]?.key;
      if (key) return { "X-API-Key": key };
      const t = secrets.cloud_session?.tokens;
      if (t?.access_token && (!t.expires_at || t.expires_at * 1000 > Date.now() + 60_000)) return { Authorization: `Bearer ${t.access_token}` };
    } catch {
      // Unreadable store: fall through.
    }
  }
  return undefined;
}

async function submitToCloudDirect(prompt: ApiPrompt): Promise<string> {
  const headers = cloudCredentials();
  if (!headers) throw new Error("This workflow uses models Comfy Cloud fetches on demand, which the comfy CLI cannot submit. Set COMFY_CLOUD_API_KEY (platform.comfy.org) and retry.");
  const res = await fetch(`${process.env.COMFY_CLOUD_URL ?? "https://cloud.comfy.org"}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ prompt }),
  });
  if (res.status === 402) throw new Error(OUT_OF_CREDITS);
  if (!res.ok) throw new Error(`Comfy Cloud rejected the workflow (${res.status}): ${(await res.text()).slice(0, 400)}`);
  return ((await res.json()) as { prompt_id: string }).prompt_id;
}

/** Bridges to the `comfy` CLI, reusing its sign-in for Comfy Cloud (or its local routing). */
export class ComfyCliBackend implements Backend {
  readonly kind = "comfy-cli" as const;
  readonly target: string;
  readonly onDemandModels: boolean;
  private readonly where: "cloud" | "local";

  constructor(cfg: BackendConfig) {
    this.where = cfg.where ?? "cloud";
    this.target = `comfy-cli (${this.where})`;
    this.onDemandModels = this.where === "cloud";
  }

  private async cli<T>(args: string[]): Promise<T> {
    const describe = (env: CliEnvelope<T>) => {
      const details = env.error?.details as { status?: number } | null | undefined;
      if (details?.status === 402) return OUT_OF_CREDITS;
      return `comfy ${args[0]}: ${env.error?.code} — ${env.error?.message}${env.error?.hint ? ` (${env.error.hint})` : ""}`;
    };
    const { stdout } = await run("comfy", ["--json", ...args, "--where", this.where]).catch((e: CommandError) => {
      // The CLI reports failures as a JSON envelope on stdout; surface its code, message and hint.
      const env = parseEnvelope<T>(e.stdout);
      const err = new Error(env ? describe(env) : `comfy ${args[0]} failed: ${e.message}`) as Error & { code?: string };
      err.code = env?.error?.code;
      throw err;
    });
    const env = JSON.parse(stdout.toString("utf8")) as CliEnvelope<T>;
    if (!env.ok) {
      const err = new Error(describe(env)) as Error & { code?: string };
      err.code = env.error?.code;
      throw err;
    }
    return env.data;
  }

  async check(): Promise<BackendCheck> {
    try {
      const { stdout } = await run("comfy", ["--json", "cloud", "whoami"]);
      const env = JSON.parse(stdout.toString("utf8")) as CliEnvelope<{ signed_in: boolean; base_url: string }>;
      const ok = this.where === "local" || Boolean(env.data?.signed_in);
      return { ok, kind: this.kind, target: this.target, detail: ok ? `comfy CLI routing to ${this.where}` : "comfy CLI is not signed in (run: comfy cloud login)" };
    } catch (e) {
      return { ok: false, kind: this.kind, target: this.target, detail: `comfy CLI unavailable: ${(e as Error).message}` };
    }
  }

  private catalogCache?: { nodes: Set<string>; models: ModelChoices };

  /** Builds a partial catalog from the loader nodes open-katana uses (the CLI has no full object_info dump). */
  async catalog() {
    if (this.catalogCache) return this.catalogCache;
    const loaders = ["UNETLoader", "CLIPLoader", "VAELoader", "LoraLoaderModelOnly", "LoadBackgroundRemovalModel", "CLIPVisionLoader", "CheckpointLoaderSimple", "LoadDA3Model"];
    const models: ModelChoices = new Map();
    const nodes = new Set<string>();
    for (const cls of loaders) {
      try {
        const data = await this.cli<{ id: string; inputs: { name: string; choices: string[] }[] }>(["nodes", "show", cls]);
        nodes.add(data.id);
        for (const input of data.inputs) {
          if (!input.choices?.length) continue;
          const set = models.get(input.name) ?? new Set<string>();
          for (const c of input.choices) set.add(c);
          models.set(input.name, set);
        }
      } catch {
        // A missing loader just means its models are unavailable.
      }
    }
    // An empty node set tells checkProfile to skip node checks it cannot verify.
    this.catalogCache = { nodes: new Set(), models };
    return this.catalogCache;
  }

  async upload(path: string): Promise<string> {
    const data = await this.cli<{ uploads: { cloud_name?: string; name?: string }[] }>(["upload", path]);
    const u = data.uploads[0];
    const name = u?.cloud_name ?? u?.name;
    if (!name) throw new Error(`comfy upload returned no name for ${path}`);
    return name;
  }

  /** Validates an API prompt against the routed server's object_info without submitting it. */
  async validate(prompt: ApiPrompt): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "ok-validate-"));
    try {
      const file = join(dir, "prompt.json");
      await writeFile(file, JSON.stringify(prompt));
      await this.cli(["workflow", "validate", "--workflow", file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async submit(prompt: ApiPrompt): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ok-submit-"));
    try {
      const file = join(dir, "prompt.json");
      await writeFile(file, JSON.stringify(prompt));
      try {
        const data = await this.cli<{ prompt_id: string }>(["run", "--workflow", file, "--no-notify"]);
        return data.prompt_id;
      } catch (e) {
        // The CLI checks models against its catalog, which lags what Comfy Cloud fetches on demand.
        if (this.where === "cloud" && onlyUnlistedModels(e as Error)) return await submitToCloudDirect(prompt);
        throw e;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async poll(promptId: string): Promise<JobPoll> {
    const data = await this.cli<{ status: string; outputs?: string[]; outputs_by_node?: Record<string, string[]>; error?: string; error_message?: string }>(["jobs", "status", promptId]);
    const state = CLOUD_STATES[data.status] ?? (data.status === "completed" ? "completed" : "pending");
    if (state === "error") return { state, outputs: [], error: creditsError(data.error_message ?? data.error ?? "failed") };
    const outputs: OutputFile[] = [];
    for (const [nodeId, urls] of Object.entries(data.outputs_by_node ?? {})) {
      for (const url of urls) {
        const q = new URL(url).searchParams;
        outputs.push({ nodeId, filename: q.get("filename") ?? basename(url), subfolder: q.get("subfolder") ?? "", type: q.get("type") ?? "output", url, promptId });
      }
    }
    return { state, outputs };
  }

  async download(file: OutputFile, dest: string): Promise<void> {
    if (!file.promptId) throw new Error("comfy-cli downloads need the producing promptId");
    const dir = await mkdtemp(join(tmpdir(), "ok-dl-"));
    try {
      // `comfy download` resolves the authenticated /api/view redirect for us.
      const data = await this.cli<{ files: { path: string; url?: string; node_id?: string }[] }>(["download", file.promptId, "--out-dir", dir]);
      const match = data.files.find((f) => f.url === file.url) ?? data.files.find((f) => f.node_id === file.nodeId) ?? data.files[0];
      if (!match) throw new Error(`comfy download produced no file for ${file.filename}`);
      await writeFile(dest, await readFile(match.path));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async cancel(promptId: string): Promise<void> {
    try {
      await this.cli(["jobs", "cancel", promptId]);
    } catch (e) {
      // Unknown or already over: nothing left to stop.
      if (/not[ _]found|already|finished|completed|cancell?ed/i.test(`${(e as Error & { code?: string }).code ?? ""} ${(e as Error).message}`)) return;
      throw e;
    }
  }
}

export function createBackend(cfg: BackendConfig): Backend {
  switch (cfg.kind) {
    case "http":
      return new HttpBackend(cfg);
    case "cloud":
      return new CloudBackend(cfg);
    case "comfy-cli":
      return new ComfyCliBackend(cfg);
  }
}

/**
 * Resolves backend settings from the environment, defaulting to a local ComfyUI. Each kind reads
 * only its own URL and credential variables: COMFYUI_URL means your own ComfyUI (unless
 * OPEN_KATANA_BACKEND says otherwise), so a Comfy Cloud key is never sent to a non-Cloud host.
 */
export function backendFromEnv(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const kind = (env.OPEN_KATANA_BACKEND as BackendKind | undefined) ?? (env.COMFYUI_URL ? "http" : env.COMFY_CLOUD_API_KEY ? "cloud" : "http");
  return {
    kind,
    url: kind === "cloud" ? env.COMFY_CLOUD_URL : kind === "http" ? env.COMFYUI_URL : undefined,
    apiKey: kind === "cloud" ? env.COMFY_CLOUD_API_KEY : kind === "http" ? env.COMFYUI_TOKEN : undefined,
    where: (env.OPEN_KATANA_CLI_WHERE as "cloud" | "local" | undefined) ?? "cloud",
  };
}
