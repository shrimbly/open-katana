import { createReadStream, existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { decodeMono } from "../engine/audio.js";
import type { AudioAnalysis } from "../engine/audio.js";
import type { Breakdown } from "../engine/analyze.js";
import { edlBeats, type RenderMode, renderProject } from "../project/render-project.js";
import { slugify, Workspace } from "../project/workspace.js";
import { deliver } from "../render/deliver.js";
import { checkEdl, EdlSchema } from "../render/edl.js";
import { FONTS, ensureFace, ensureFonts, faceFileName, fontFileName, fontMetrics, fontsDir } from "../render/fonts.js";
import { BUILTIN_SFX } from "../render/sfx.js";
import { packageRoot } from "../util/paths.js";
import { run } from "../util/proc.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
};

interface RenderState {
  mode: RenderMode;
  running: boolean;
  /** Renders requested while one was running; each mode runs once more, picture-only first. */
  pending: Set<RenderMode>;
  done: number;
  total: number;
  error?: string;
  finishedAt?: string;
}

/** A local web editor over open-katana projects: timeline, text layers, clip sources and renders. */
export class Studio {
  private server?: Server;
  private readonly clients = new Map<string, Set<ServerResponse>>();
  private readonly renders = new Map<string, RenderState>();
  private readonly watchers = new Map<string, FSWatcher>();
  port = 0;

  url(project?: string): string {
    return `http://127.0.0.1:${this.port}/${project ? `?project=${encodeURIComponent(project)}` : ""}`;
  }

  async start(port = 4310): Promise<string> {
    if (this.server) return this.url();
    // The editor's own typefaces; edit fonts download when the font list is first opened.
    void ensureFonts(["Archivo", "JetBrains Mono"]).catch(() => undefined);
    this.server = createServer((req, res) => {
      this.route(req, res).catch((e: Error) => this.json(res, 500, { error: e.message }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    }).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE") throw e;
      await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", () => resolve()));
    });
    this.port = (this.server.address() as { port: number }).port;
    return this.url();
  }

  async stop(): Promise<void> {
    for (const w of this.watchers.values()) w.close();
    for (const set of this.clients.values()) for (const c of set) c.end();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(data));
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }

  /** Serves a file with HTTP range support so the browser can seek video and audio. */
  private serveFile(req: IncomingMessage, res: ServerResponse, file: string): void {
    if (!existsSync(file)) return void this.json(res, 404, { error: "not found" });
    const size = statSync(file).size;
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1, "cache-control": "no-cache" });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-cache" });
    createReadStream(file).pipe(res);
  }

  private broadcast(project: string, event: Record<string, unknown>): void {
    for (const c of this.clients.get(project) ?? []) c.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  /** Watches the project's EDL so edits made by the agent show up in open editors. */
  private watchProject(ws: Workspace): void {
    if (this.watchers.has(ws.project.id)) return;
    const dir = ws.path("render");
    if (!existsSync(dir)) return;
    let timer: NodeJS.Timeout | undefined;
    const w = watch(dir, (_e, name) => {
      if (name !== "edl.json") return;
      clearTimeout(timer);
      timer = setTimeout(() => this.broadcast(ws.project.id, { type: "edl" }), 150);
    });
    this.watchers.set(ws.project.id, w);
  }

  private async projectState(ws: Workspace) {
    const edl = await ws.readJson("render/edl.json", EdlSchema);
    const audio = await ws.readJson<AudioAnalysis>("analysis/audio.json");
    const breakdown = await ws.readJson<Breakdown>("analysis/breakdown.json");
    const beats = edl ? await edlBeats(ws, edl) : (audio?.beats ?? []);
    const renders: Record<string, { url: string; mtime: number } | undefined> = {};
    for (const [mode, file] of [["preview", "preview.mp4"], ["master", "master.mp4"], ["notext", "preview-notext.mp4"]] as const) {
      const path = ws.path("render", file);
      renders[mode] = existsSync(path) ? { url: `/media/${ws.project.id}/render/${file}`, mtime: statSync(path).mtimeMs } : undefined;
    }
    const verdicts = (await ws.readJson<{ asset: string; verdict: string; reason?: string }[]>("qa/verdicts.json")) ?? [];
    return {
      project: ws.project,
      edl,
      beats,
      reference: breakdown ? { format: breakdown.format, shots: breakdown.shots.map((s) => ({ startSec: s.startSec, endSec: s.endSec })) } : undefined,
      assets: ws.project.assets.map((a) => ({ ...a, url: `/media/${ws.project.id}/${a.path}`, verdict: verdicts.find((v) => v.asset === a.id)?.verdict })),
      renders,
      render: (() => {
        const r = this.renders.get(ws.project.id);
        return r && { mode: r.mode, running: r.running, done: r.done, total: r.total, error: r.error };
      })(),
      check: edl ? checkEdl(edl, { fps: edl.canvas.fps, beats }).warnings : [],
    };
  }

  private async startRender(ws: Workspace, mode: RenderMode): Promise<void> {
    const id = ws.project.id;
    const current = this.renders.get(id);
    if (current?.running) {
      current.pending.add(mode);
      return;
    }
    const state: RenderState = { mode, running: true, pending: current?.pending ?? new Set(), done: 0, total: 0 };
    this.renders.set(id, state);
    const publish = () => this.broadcast(id, { type: "render", mode: state.mode, running: state.running, done: state.done, total: state.total });
    publish();
    try {
      const r = await renderProject(ws, mode, undefined, (done, total) => {
        state.done = done;
        state.total = total;
        publish();
      });
      state.finishedAt = new Date().toISOString();
      this.broadcast(id, { type: "rendered", mode, frames: r.frames, warnings: r.warnings });
    } catch (e) {
      state.error = (e as Error).message;
      this.broadcast(id, { type: "render-error", mode, error: state.error });
    } finally {
      state.running = false;
      const next = (["notext", "preview", "master"] as const).find((m) => state.pending.has(m));
      if (next) {
        state.pending.delete(next);
        void this.startRender(ws, next);
      }
    }
  }

  /** Only this editor's own pages may call it: no other origin, and no other host name (DNS rebinding). */
  private allowed(req: IncomingMessage): boolean {
    const own = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!own.includes(req.headers.host ?? "")) return false;
    const origin = req.headers.origin;
    return !origin || own.some((h) => origin === `http://${h}`);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowed(req)) return this.json(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (parts[0] === "api") {
      if (parts[1] === "projects" && parts.length === 2) {
        const list = await Workspace.list();
        return this.json(res, 200, list.map((p) => ({ id: p.id, title: p.title, stage: p.stage, updatedAt: p.updatedAt, versions: p.versions.length })));
      }
      if (parts[1] === "fonts" && parts[2] === "face") {
        // A static weight/italic face, fetched on first use.
        const family = url.searchParams.get("family") ?? "";
        const weight = Number(url.searchParams.get("weight") ?? 400);
        const italic = url.searchParams.get("italic") === "1";
        if (!FONTS[family]) return this.json(res, 404, { error: "unknown font" });
        await ensureFonts([family]);
        const ok = await ensureFace(family, weight, italic).catch(() => false);
        return this.json(res, ok ? 200 : 404, ok ? { url: `/fonts/${weight === 400 && !italic ? fontFileName(family) : faceFileName(family, weight, italic)}` } : { error: "no such face" });
      }
      if (parts[1] === "fonts") {
        await ensureFonts(Object.keys(FONTS)).catch(() => undefined);
        return this.json(res, 200, Object.fromEntries(Object.entries(FONTS).map(([family, f]) => [family, { url: `/fonts/${fontFileName(family)}`, style: f.style, metrics: fontMetrics(family) }])));
      }
      if (parts[1] === "sfx") return this.json(res, 200, Object.fromEntries(Object.entries(BUILTIN_SFX).map(([k, v]) => [k, v.description])));
      if (parts[1] === "projects" && parts[2]) {
        const ws = await Workspace.open(parts[2]);
        this.watchProject(ws);
        const action = parts[3];
        if (!action && req.method === "GET") return this.json(res, 200, await this.projectState(ws));
        if (action === "edl" && req.method === "PUT") {
          const parsed = EdlSchema.safeParse(await this.body(req));
          if (!parsed.success) return this.json(res, 400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
          const beats = await edlBeats(ws, parsed.data);
          await ws.writeJson("render/edl.json", parsed.data);
          return this.json(res, 200, { ok: true, edl: parsed.data, warnings: checkEdl(parsed.data, { fps: parsed.data.canvas.fps, beats }).warnings });
        }
        if (action === "render" && req.method === "POST") {
          const { mode } = (await this.body(req)) as { mode?: RenderMode };
          void this.startRender(ws, mode === "master" || mode === "notext" ? mode : "preview");
          return this.json(res, 202, { ok: true });
        }
        if (action === "deliver" && req.method === "POST") {
          const master = ws.path("render", "master.mp4");
          if (!existsSync(master)) return this.json(res, 409, { error: "Render the final version first." });
          const version = ws.project.versions.length + 1;
          const out = ws.path("deliver", `${slugify(ws.project.title)}_v${version}.mp4`);
          const d = await deliver(master, out);
          ws.project.versions.push({ version, path: ws.rel(out), createdAt: new Date().toISOString(), note: "exported from the studio" });
          await ws.save();
          return this.json(res, 200, { version, path: out, url: `/media/${ws.project.id}/${ws.rel(out)}`, sizeMB: d.sizeMB });
        }
        if (action === "events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          res.write(": connected\n\n");
          const set = this.clients.get(ws.project.id) ?? new Set();
          set.add(res);
          this.clients.set(ws.project.id, set);
          req.on("close", () => set.delete(res));
          return;
        }
        if (action === "thumb") {
          const asset = ws.asset(url.searchParams.get("asset") ?? "");
          const t = Math.max(0, Number(url.searchParams.get("t") ?? 0));
          const h = Math.min(360, Math.max(32, Number(url.searchParams.get("h") ?? 96)));
          const dir = ws.path("render", "thumbs");
          await mkdir(dir, { recursive: true });
          const file = join(dir, `${asset.id}-${t.toFixed(2)}-${h}.jpg`);
          if (!existsSync(file)) {
            const seek = asset.kind === "video" ? ["-ss", String(Math.min(t, Math.max(0, (asset.durationSec ?? 0) - 0.05)))] : [];
            await run("ffmpeg", ["-v", "error", "-y", ...seek, "-i", ws.path(asset.path), "-frames:v", "1", "-vf", `scale=-2:${h}`, "-q:v", "5", file]);
          }
          return this.serveFile(req, res, file);
        }
        if (action === "waveform") {
          const asset = ws.asset(url.searchParams.get("asset") ?? "ref");
          const file = ws.path("render", `waveform-${asset.id}.json`);
          if (!existsSync(file)) {
            const samples = await decodeMono(ws.path(asset.path), 8000);
            const perSec = 100;
            const step = Math.floor(8000 / perSec);
            const peaks: number[] = [];
            for (let i = 0; i < samples.length; i += step) {
              let m = 0;
              for (let j = i; j < Math.min(samples.length, i + step); j++) m = Math.max(m, Math.abs(samples[j]!));
              peaks.push(Math.round(m * 1000) / 1000);
            }
            await writeFile(file, JSON.stringify({ perSec, peaks }));
          }
          return this.json(res, 200, JSON.parse(await readFile(file, "utf8")));
        }
      }
      return this.json(res, 404, { error: "unknown endpoint" });
    }

    if (parts[0] === "media" && parts[1]) {
      const ws = await Workspace.open(parts[1]);
      const rel = normalize(parts.slice(2).join("/"));
      if (rel.startsWith("..")) return this.json(res, 400, { error: "bad path" });
      return this.serveFile(req, res, ws.path(rel));
    }
    if (parts[0] === "fonts" && parts[1]) {
      const file = join(fontsDir(), normalize(parts[1]));
      if (!file.startsWith(fontsDir())) return this.json(res, 400, { error: "bad path" });
      return this.serveFile(req, res, file);
    }

    // The editor itself: a static single-page app.
    const root = join(packageRoot(), "dist", "studio-ui");
    const file = join(root, normalize(url.pathname === "/" ? "index.html" : url.pathname));
    if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return this.serveFile(req, res, file);
    const index = join(root, "index.html");
    if (existsSync(index)) return this.serveFile(req, res, index);
    res.writeHead(200, { "content-type": "text/html" }).end("<p style='font:14px system-ui'>The studio is not built. Run <code>pnpm build</code>.</p>");
  }
}

export const STUDIO_PORT = 4310;

/**
 * A studio that outlives this process: reuses one already serving this project on the usual port,
 * or starts a detached `open-katana studio` there, so links stay valid after the agent session ends.
 * Falls back to an in-process studio when that is not possible.
 */
export async function ensureStandaloneStudio(project: string): Promise<string> {
  const url = `http://127.0.0.1:${STUDIO_PORT}/?project=${encodeURIComponent(project)}`;
  const serves = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${STUDIO_PORT}/api/projects/${encodeURIComponent(project)}`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (await serves()) return url;
  const entry = process.argv[1];
  if (entry) {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [...process.execArgv, entry, "studio", "--port", String(STUDIO_PORT), "--no-open"], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await serves()) return url;
    }
  }
  return (await sharedStudio(0)).url(project);
}

let shared: Studio | undefined;

/** One studio per process, started on first use. */
export async function sharedStudio(port?: number): Promise<Studio> {
  shared ??= new Studio();
  await shared.start(port);
  return shared;
}
