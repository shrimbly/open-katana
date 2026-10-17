import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { type Backend, type BackendKind, createBackend, type ModelChoices } from "../comfy/backend.js";
import { chooseProfile } from "../comfy/jobs.js";
import { OPERATIONS, profile } from "../comfy/operations.js";
import { checkProfile } from "../comfy/resolve.js";
import { type Config, backendEnvOverrides, effectiveBackend, loadConfig, nextBackend, saveConfig } from "../config.js";
import { listPresets } from "../presets/library.js";
import { VERSION } from "../server/server.js";
import { HttpError } from "./router.js";
import { REQUIRED_FLAGS } from "./runs/args.js";
import { GpuSetupRequestSchema } from "./schemas.js";
import type { BackendWhere, ClaudeAuth, GpuSetupRequest, SetupCode, SetupStatus } from "./types.js";

/**
 * Preflight for making edits: the director (Claude Code), the GPU (ComfyUI) and ffmpeg (spec §9.1).
 * Each part is cached for 60 s; "Check again" and every spawn recheck. Nothing here returns a key, an
 * email or an account id.
 */

const TTL_MS = 60_000;

// ---------- small process helper ----------

interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

/** Runs a command without a shell; never throws. A timeout kills it and reports code null. */
export function exec(cmd: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<Exec> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: Exec) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < 1 << 20) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-8000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, error }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

// ---------- the director ----------

/** The `claude` executable: OPEN_KATANA_CLAUDE, else the first on PATH. Never from HTTP or settings. */
export function claudePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OPEN_KATANA_CLAUDE) {
    const p = resolve(env.OPEN_KATANA_CLAUDE);
    return existsSync(p) ? p : undefined;
  }
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const p = join(dir, name);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

/** How to run `path`: a .js/.mjs script (a test double) runs under this Node. */
export function claudeCommand(path: string, args: string[]): { cmd: string; args: string[] } {
  return /\.(c|m)?js$/i.test(path) ? { cmd: process.execPath, args: [path, ...args] } : { cmd: path, args };
}

const runClaude = (path: string, args: string[], timeoutMs: number) => {
  const c = claudeCommand(path, args);
  return exec(c.cmd, c.args, timeoutMs);
};

type ClaudeStatus = SetupStatus["claude"];
interface ClaudeStatic {
  path?: string;
  version?: string;
  missingFlags?: string[];
  error?: string;
}

const helpByVersion = new Map<string, string[]>();

/** Flags of REQUIRED_FLAGS (and the dontAsk permission mode) that `help` does not list. */
export function missingFlags(help: string): string[] {
  const missing = REQUIRED_FLAGS.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/[-]/g, "\\-")}(?![\\w-])`, "m").test(help));
  if (!/dontAsk/.test(help)) missing.push('--permission-mode "dontAsk"');
  return missing;
}

async function claudeStatic(): Promise<ClaudeStatic> {
  const path = claudePath();
  if (!path) return {};
  const v = await runClaude(path, ["--version"], 10_000);
  const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1];
  if (!version) return { path, error: v.error?.message ?? (v.stderr.trim().split("\n").at(-1) || "claude --version gave no version") };
  let missing = helpByVersion.get(version);
  if (!missing) {
    const h = await runClaude(path, ["--help"], 10_000);
    missing = missingFlags(`${h.stdout}\n${h.stderr}`);
    helpByVersion.set(version, missing);
  }
  return { path, version, missingFlags: missing };
}

const PLAN_NAMES: Record<string, string> = { max: "Claude Max", pro: "Claude Pro" };

/** `claude auth status --json`: only loggedIn, authMethod and subscriptionType are read. */
async function claudeAuth(path: string): Promise<{ loggedIn?: boolean; auth: ClaudeAuth; plan?: string; error?: string }> {
  const r = await runClaude(path, ["auth", "status", "--json"], 5_000);
  let data: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } | undefined;
  try {
    const text = r.stdout.trim();
    data = JSON.parse(text.slice(text.indexOf("{")));
  } catch {
    return { auth: "unknown", error: r.code === null ? "claude auth status did not answer" : undefined };
  }
  const method = typeof data?.authMethod === "string" ? data.authMethod : "";
  const auth: ClaudeAuth = method === "claude.ai" ? "subscription" : /api/i.test(method) ? "api-key" : method ? "other" : "unknown";
  const sub = typeof data?.subscriptionType === "string" ? data.subscriptionType : undefined;
  return { loggedIn: data?.loggedIn === true, auth, ...(auth === "subscription" ? { plan: (sub && PLAN_NAMES[sub]) ?? "Claude plan" } : {}) };
}

// ---------- the GPU ----------

type GpuStatus = SetupStatus["gpu"];

export interface CatalogCache {
  kind: BackendKind;
  target: string;
  onDemandModels: boolean;
  catalog?: { nodes: Set<string>; models: ModelChoices };
}

let catalogCache: CatalogCache | undefined;

/** The backend catalog from the last GPU check (for estimates, which must not wait on the network). */
export function cachedCatalog(): CatalogCache | undefined {
  return catalogCache;
}

/** Where a backend runs, for copy: Comfy Cloud, this computer, or another one. */
export function whereOf(kind: BackendKind, target: string): BackendWhere {
  if (kind === "cloud" || target === "comfy-cli (cloud)") return "cloud";
  if (kind === "comfy-cli") return "local";
  try {
    const host = new URL(target).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" ? "local" : "remote";
  } catch {
    return "local";
  }
}

/** The backend the app (and the director, via config.json) would use, without touching the network. */
export function currentBackend(cfg: Config): { backend?: Backend; error?: string } {
  try {
    return { backend: createBackend(effectiveBackend(cfg)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref())]);

async function gpuStatus(): Promise<GpuStatus> {
  const cfg = await loadConfig();
  const env = process.env;
  const keySaved = Boolean(cfg.backend?.apiKey);
  const configured = Boolean(cfg.backend) || backendEnvOverrides(env).length > 0;
  const { backend, error } = currentBackend(cfg);
  if (!backend) return { state: "not-configured", detail: error, keySaved, profiles: [] };
  const base = { kind: backend.kind, where: whereOf(backend.kind, backend.target), target: backend.target, onDemandModels: Boolean(backend.onDemandModels), keySaved };
  const check = await withTimeout(backend.check(), 3_000, { ok: false, kind: backend.kind, target: backend.target, detail: "No answer within 3 s" });
  // Never pass on an account email from a backend's sign-in check.
  const detail = check.detail.replace(/\s*(signed in )?as \S+@\S+/i, (_m, s: string | undefined) => (s ? "signed in" : ""));
  const envSecret = Boolean((env.COMFY_CLOUD_API_KEY && backend.kind === "cloud") || (env.COMFYUI_TOKEN && backend.kind === "http")) && !keySaved;
  if (!check.ok) {
    catalogCache = undefined;
    return { ...base, state: configured ? "unreachable" : "not-configured", detail, profiles: [] };
  }
  const catalog = await withTimeout(backend.catalog().catch(() => undefined), 5_000, undefined);
  catalogCache = { kind: backend.kind, target: backend.target, onDemandModels: Boolean(backend.onDemandModels), catalog };
  const profiles: GpuStatus["profiles"] = [];
  for (const operation of OPERATIONS) {
    let id: string;
    try {
      id = chooseProfile({ operation }, { tier: cfg.tier, overrides: cfg.profiles, commercial: cfg.commercial, catalog, onDemandModels: backend.onDemandModels });
    } catch {
      continue;
    }
    const p = profile(id);
    const a = catalog ? checkProfile(p, catalog) : undefined;
    const missing = a ? (backend.onDemandModels ? a.missingNodes : [...a.missingModels, ...a.missingNodes]) : [];
    const links = a && !backend.onDemandModels ? p.models.filter((m) => a.missingModels.includes(`${m.folder}/${m.name}`)).map((m) => m.url) : [];
    const neededBy = missing.length ? (await templatesByOperation().catch(() => new Map<string, string[]>())).get(operation) : undefined;
    profiles.push({ id, operation, title: p.title, ready: !missing.length, missing, links, ...(neededBy?.length ? { neededBy } : {}) });
  }
  return { ...base, state: envSecret ? "env-secret" : "ok", detail, profiles };
}

/**
 * Which templates use each GPU operation, by title, for "needed by Hype Energy, Iron Mindset". A
 * shot-for-shot template uses the face crop plus what its slots name; a freestyle one plans keyframes
 * and image-to-video clips.
 */
async function templatesByOperation(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const add = (op: string, title: string) => out.set(op, [...new Set([...(out.get(op) ?? []), title])]);
  for (const p of await listPresets()) {
    if (!p.skeleton || !p.slots.length) {
      add("still.compose", p.title);
      add("clip.i2v", p.title);
      continue;
    }
    add("still.face", p.title);
    for (const slot of p.slots) {
      const op = slot.operation ?? "";
      const still = /still\.generate/.test(op) ? "still.generate" : "still.compose";
      if (/[-_]matte$/.test(slot.id)) add("matte", p.title);
      else if (slot.kind === "clip") {
        add(still, p.title);
        add(/clip\.r2v/.test(op) ? "clip.r2v" : /clip\.flf/.test(op) ? "clip.flf" : "clip.i2v", p.title);
      } else if (slot.kind === "still" || slot.kind === "graphic") add(still, p.title);
    }
  }
  return out;
}

// ---------- ffmpeg ----------

async function ffmpegStatus(): Promise<SetupStatus["ffmpeg"]> {
  const r = await exec("ffmpeg", ["-version"], 5_000);
  const version = /ffmpeg version (\S+)/.exec(r.stdout)?.[1];
  return r.code === 0 ? { state: "ok", ...(version ? { version } : {}) } : { state: "missing" };
}

// ---------- the whole status ----------

interface Cached<T> {
  at: number;
  value: T;
}
const cache: { static?: Cached<ClaudeStatic>; auth?: Cached<Awaited<ReturnType<typeof claudeAuth>>>; gpu?: Cached<GpuStatus>; ffmpeg?: Cached<SetupStatus["ffmpeg"]> } = {};
let inflight: Promise<SetupStatus> | undefined;

const fresh = <T>(c: Cached<T> | undefined, now: number) => (c && now - c.at < TTL_MS ? c.value : undefined);

export const BLOCKER_COPY: Record<SetupCode, string> = {
  CLAUDE_MISSING: "Finish setup to make edits: sign in to Claude Code. Browsing and decoding work now.",
  CLAUDE_TOO_OLD: "Update Claude Code to make edits: this version can't run edits headlessly.",
  CLAUDE_LOGGED_OUT: "Finish setup to make edits: sign in to Claude Code. Browsing and decoding work now.",
  GPU_NOT_CONFIGURED: "Finish setup to make edits: connect a GPU. Browsing and decoding work now.",
  GPU_UNREACHABLE: "Finish setup to make edits: connect a GPU. Browsing and decoding work now.",
  GPU_ENV_SECRET: "Your Comfy Cloud key is set in this terminal only. Save it so the director can use it.",
  FFMPEG_MISSING: "Install ffmpeg to decode and render edits.",
  MODELS_MISSING: "This template needs models your ComfyUI doesn't have.",
};

async function compute(opts: { fresh?: boolean | "gpu" }): Promise<SetupStatus> {
  const now = Date.now();
  const all = opts.fresh === true;
  const some = Boolean(opts.fresh);
  const st = (!all && fresh(cache.static, now)) || (cache.static = { at: now, value: await claudeStatic() }).value;
  const [authValue, gpu, ffmpeg] = await Promise.all([
    st.path && st.version ? ((!some && fresh(cache.auth, now)) || claudeAuth(st.path).then((v) => (cache.auth = { at: Date.now(), value: v }).value)) : Promise.resolve(undefined),
    (!some && fresh(cache.gpu, now)) || gpuStatus().then((v) => (cache.gpu = { at: Date.now(), value: v }).value),
    (!all && fresh(cache.ffmpeg, now)) || ffmpegStatus().then((v) => (cache.ffmpeg = { at: Date.now(), value: v }).value),
  ]);

  let claude: ClaudeStatus;
  if (!st.path) claude = { state: "missing" };
  else if (!st.version) claude = { state: "error", message: st.error };
  else if (st.missingFlags?.length) claude = { state: "too-old", version: st.version, missingFlags: st.missingFlags };
  else if (authValue?.loggedIn === false) claude = { state: "logged-out", version: st.version, auth: authValue.auth };
  else claude = { state: "ok", version: st.version, auth: authValue?.auth ?? "unknown", ...(authValue?.plan ? { plan: authValue.plan } : {}) };

  const blockers: SetupStatus["blockers"] = [];
  const block = (code: SetupCode, message = BLOCKER_COPY[code]) => blockers.push({ code, message });
  if (claude.state === "missing" || claude.state === "error") block("CLAUDE_MISSING");
  if (claude.state === "too-old") block("CLAUDE_TOO_OLD");
  if (claude.state === "logged-out") block("CLAUDE_LOGGED_OUT");
  if (gpu.state === "not-configured") block("GPU_NOT_CONFIGURED");
  if (gpu.state === "unreachable") block("GPU_UNREACHABLE", `Can't reach your GPU at ${gpu.target}. Start ComfyUI, then check again.`);
  if (gpu.state === "env-secret") block("GPU_ENV_SECRET", gpu.kind === "http" ? "Your ComfyUI token is set in this terminal only. Save it so the director can use it." : BLOCKER_COPY.GPU_ENV_SECRET);
  if (ffmpeg.state === "missing") block("FFMPEG_MISSING");

  return {
    version: VERSION,
    checkedAt: new Date().toISOString(),
    claude,
    gpu,
    ffmpeg,
    ready: { browse: true, decode: ffmpeg.state === "ok", make: claude.state === "ok" && gpu.state === "ok" && ffmpeg.state === "ok" },
    blockers,
  };
}

/** Cached 60 s; `fresh: true` rechecks everything, `"gpu"` rechecks the GPU and the Claude sign-in. */
export async function setupStatus(opts: { fresh?: boolean | "gpu" } = {}): Promise<SetupStatus> {
  // Callers arriving while a check runs share it, unless they asked for a fresher one.
  if (inflight && !opts.fresh) return inflight;
  const p = compute(opts);
  inflight = p;
  try {
    return await p;
  } finally {
    if (inflight === p) inflight = undefined;
  }
}

/** The claude binary and what it is signed in with, for a run record (from the cache). */
export function claudeIdentity(): { path?: string; version?: string; auth: ClaudeAuth; plan?: string } {
  return { path: cache.static?.value.path, version: cache.static?.value.version, auth: cache.auth?.value.auth ?? "unknown", ...(cache.auth?.value.plan ? { plan: cache.auth.value.plan } : {}) };
}

/** Forgets every cached check (tests, and after the GPU is saved). */
export function resetSetupCache(part?: "gpu"): void {
  cache.gpu = undefined;
  catalogCache = undefined;
  if (part === "gpu") return;
  cache.static = undefined;
  cache.auth = undefined;
  cache.ffmpeg = undefined;
  helpByVersion.clear();
}

/** Saves the GPU backend to config.json (keys are write-only), then rechecks. */
export async function saveGpu(req: GpuSetupRequest): Promise<SetupStatus> {
  const parsed = GpuSetupRequestSchema.safeParse(req);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "BAD_REQUEST");
  const r = parsed.data;
  const cfg = await loadConfig();
  let url: string | undefined;
  let apiKey = r.apiKey?.trim() || undefined;
  if (r.kind === "http") {
    url = (r.url?.trim() || "http://127.0.0.1:8188").replace(/\/+$/, "");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new HttpError(400, "Use a URL like http://127.0.0.1:8188.", "BAD_URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "Use a URL that starts with http:// or https://.", "BAD_URL");
    if (r.saveEnvSecret) apiKey = process.env.COMFYUI_TOKEN || apiKey;
  } else if (r.kind === "cloud") {
    if (r.saveEnvSecret) apiKey = process.env.COMFY_CLOUD_API_KEY || apiKey;
    const carried = cfg.backend?.kind === "cloud" ? cfg.backend.apiKey : undefined;
    if (!apiKey && !carried) throw new HttpError(400, "Paste your Comfy Cloud API key, or use your comfy CLI sign-in.", "NO_KEY");
  }
  const next = nextBackend(cfg.backend, { kind: r.kind, url, apiKey });
  if (r.kind === "comfy-cli") next.where = "cloud";
  await saveConfig({ ...cfg, backend: next });
  resetSetupCache("gpu");
  return setupStatus({ fresh: "gpu" });
}
