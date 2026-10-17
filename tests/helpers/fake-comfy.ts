import { createServer, type Server } from "node:http";
import { PROFILES } from "../../src/comfy/operations.js";

/**
 * A ComfyUI stand-in for tests (spec §14.1): /system_stats, /object_info (every node and model the
 * profiles use, so setup and estimates see a complete install), /prompt, /queue (GET and the POST
 * delete), /history/:id, /interrupt and /view. Every call is recorded. A client-chosen prompt_id is kept, as
 * ComfyUI does. Prompts finish after
 * `completeAfterMs` unless held; `outOfCredits` answers /prompt with 402.
 */
export interface FakeComfyCall {
  method: string;
  path: string;
  body?: unknown;
  at: number;
}

export interface FakeComfyOptions {
  /** Port to try first (another free one is used when it is taken). */
  port?: number;
  /** Delay before every answer (ms). */
  delayMs?: number;
  /** Delay before /prompt answers (ms), e.g. to hold a submit in flight. */
  promptDelayMs?: number;
  /** Prompts stay running until this many ms after submission; Infinity holds them. */
  completeAfterMs?: number;
  outOfCredits?: boolean;
  /** Leave models out of /object_info so profiles look unrunnable. */
  missingModels?: boolean;
}

export interface FakeComfy {
  url: string;
  calls: FakeComfyCall[];
  /** Prompt ids passed to POST /queue {delete}. */
  deleted: () => string[];
  interrupts: () => number;
  options: FakeComfyOptions;
  close(): Promise<void>;
}

function objectInfo(missingModels: boolean): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  for (const p of PROFILES) for (const n of p.nodes) info[n] = { input: { required: {} } };
  const models = missingModels ? [] : [...new Set(PROFILES.flatMap((p) => p.models.map((m) => m.name)))];
  info.UNETLoader = { input: { required: { unet_name: [models.length ? models : ["none.safetensors"]] } } };
  return info;
}

export async function startFakeComfy(options: FakeComfyOptions = {}): Promise<FakeComfy> {
  const calls: FakeComfyCall[] = [];
  const submitted = new Map<string, number>();
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const url = new URL(req.url ?? "/", "http://x");
    calls.push({ method: req.method ?? "GET", path: url.pathname, ...(body !== undefined ? { body } : {}), at: Date.now() });
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    const done = (id: string) => Date.now() - (submitted.get(id) ?? Date.now()) >= (options.completeAfterMs ?? 0);
    if (url.pathname === "/system_stats") return json(200, { system: { comfyui_version: "0.3.99" }, devices: [{ name: "Fake GPU", vram_total: 24 * 2 ** 30 }] });
    if (url.pathname === "/object_info") return json(200, objectInfo(Boolean(options.missingModels)));
    if (url.pathname === "/prompt" && req.method === "POST") {
      if (options.promptDelayMs) await new Promise((r) => setTimeout(r, options.promptDelayMs));
      if (options.outOfCredits) return json(402, { error: "payment required" });
      // Like ComfyUI, a client-chosen prompt_id is used as the job's id.
      const asked = (body as { prompt_id?: unknown })?.prompt_id;
      n++;
      const id = typeof asked === "string" && asked ? asked : `fake-${n}`;
      submitted.set(id, Date.now());
      return json(200, { prompt_id: id, number: n, node_errors: {} });
    }
    if (url.pathname === "/queue" && req.method === "GET") {
      const open = [...submitted.keys()].filter((id) => !done(id));
      return json(200, { queue_running: open.slice(0, 1).map((id, i) => [i, id]), queue_pending: open.slice(1).map((id, i) => [i + 1, id]) });
    }
    if (url.pathname === "/queue" && req.method === "POST") {
      for (const id of ((body as { delete?: string[] })?.delete ?? [])) submitted.delete(id);
      return json(200, {});
    }
    if (url.pathname === "/interrupt") return json(200, {});
    if (url.pathname.startsWith("/history/")) {
      const id = decodeURIComponent(url.pathname.slice("/history/".length));
      if (!submitted.has(id) || !done(id)) return json(200, {});
      return json(200, { [id]: { status: { status_str: "success", completed: true }, outputs: { "9": { images: [{ filename: `${id}.png`, subfolder: "", type: "output" }] } } } });
    }
    if (url.pathname === "/view") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(64));
    if (url.pathname === "/upload/image") return json(200, { name: "upload.png" });
    json(404, { error: "unknown" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? server.listen(0, "127.0.0.1", resolve) : reject(e)));
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    options,
    deleted: () => calls.filter((c) => c.method === "POST" && c.path === "/queue").flatMap((c) => (c.body as { delete?: string[] })?.delete ?? []),
    interrupts: () => calls.filter((c) => c.path === "/interrupt").length,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
