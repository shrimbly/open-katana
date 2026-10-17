import { existsSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, relative, sep } from "node:path";
import { DecodeManager } from "../app/decode.js";
import { deliverVersion, isExporting, startExport } from "../app/export.js";
import { BASE_HEADERS, CACHE_IMMUTABLE, CSP, openProject, readJsonBody, relPosix, safeJoin, serveFile } from "../app/http.js";
import { Hub } from "../app/hub.js";
import { acquireAppLock, liveAppLock, releaseAppLock } from "../app/lock.js";
import { isRunActive } from "../app/project-lock.js";
import { type AppCtx, handleApp, HttpError, sendJson } from "../app/router.js";
import { RunManager } from "../app/runs/manager.js";
import type { Info, RunSummary } from "../app/types.js";
import { sweepInbox } from "../app/uploads.js";
import { decodeMono } from "../engine/audio.js";
import type { AudioAnalysis } from "../engine/audio.js";
import type { Breakdown } from "../engine/analyze.js";
import { edlBeats, type RenderMode, renderProject } from "../project/render-project.js";
import type { Workspace } from "../project/workspace.js";
import { checkEdl, EdlSchema } from "../render/edl.js";
import { FONTS, ensureFace, ensureFonts, faceFileName, fontFileName, fontMetrics, fontsDir } from "../render/fonts.js";
import type { RenderResult } from "../render/render.js";
import { BUILTIN_SFX } from "../render/sfx.js";
import { VERSION } from "../server/server.js";
import { packageRoot, securePrivateDirs } from "../util/paths.js";
import { run } from "../util/proc.js";

/** A caller waiting for a render to finish, optionally following its progress. */
interface Waiter {
  resolve: (r: RenderResult) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

interface RenderState {
  mode: RenderMode;
  running: boolean;
  /** Renders requested while one was running; each mode runs once more, picture-only first. */
  pending: Set<RenderMode>;
  /** Callers waiting for a pending mode's next render. */
  waiting: Map<RenderMode, Waiter[]>;
  /** Callers waiting for the render running now. */
  current: Waiter[];
  done: number;
  total: number;
  error?: string;
  finishedAt?: string;
}

export interface StudioOptions {
  /**
   * Take ~/.open-katana/app/app.lock and run edits (the RunManager). Only the `app` and `studio` commands
   * pass it; the studio an MCP server starts for itself never does, and answers run mutations with 503.
   */
  appOwner?: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** A local web editor over open-katana projects (timeline, text layers, clip sources, renders), and the app around it. */
export class Studio {
  private server?: Server;
  private readonly renders = new Map<string, RenderState>();
  private readonly watchers = new Map<string, FSWatcher>();
  /** The app's routes and services (src/app). */
  private app?: AppCtx;
  port = 0;

  url(project?: string): string {
    return `http://127.0.0.1:${this.port}/${project ? `?project=${encodeURIComponent(project)}` : ""}`;
  }

  /** True when this server holds app.lock and runs edits. */
  get owner(): boolean {
    return this.app?.owner ?? false;
  }

  /** Edits whose director is running now (they keep going when this server stops). */
  activeRuns(): RunSummary[] {
    return (this.app?.runs?.list({ active: true }) ?? []).filter((r) => r.status === "starting" || r.status === "running" || r.status === "stopping");
  }

  async start(port = 4310, opts: StudioOptions = {}): Promise<string> {
    if (this.server) return this.url();
    // The editor's own typefaces; edit fonts download when the font list is first opened.
    void ensureFonts(["Archivo", "JetBrains Mono"]).catch(() => undefined);
    const hub = new Hub();
    this.app = {
      port: 0,
      owner: false,
      version: VERSION,
      hub,
      decodes: new DecodeManager({ emit: (project, state) => hub.project(project, { type: "decode", state }) }),
    };
    this.server = createServer((req, res) => {
      for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
      this.route(req, res).catch((e: Error) => this.fail(res, e));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    }).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE") throw e;
      await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", () => resolve()));
    });
    this.port = (this.server.address() as { port: number }).port;
    this.app.port = this.port;
    // Photos, briefs and the director's transcript are this account's only.
    await securePrivateDirs();
    if (opts.appOwner && (await acquireAppLock(this.port))) {
      this.app.owner = true;
      this.app.runs = new RunManager({
        emit: (project, state) => hub.project(project, { type: "run", state }),
        emitRuns: (runs) => hub.global({ type: "runs", runs }),
      });
      await this.app.runs.reconcile().catch((e: Error) => process.stderr.write(`open-katana: couldn't restore edits in progress: ${e.message}\n`));
      void sweepInbox().catch(() => undefined);
    }
    return this.url();
  }

  /** Stops serving: closes watchers and event streams and releases the app lock. Never stops a director. */
  async stop(): Promise<void> {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.app?.hub.close();
    this.app?.runs?.close();
    if (this.app?.owner) await releaseAppLock();
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server.closeIdleConnections();
    });
    this.server = undefined;
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    sendJson(res, status, data);
  }

  private fail(res: ServerResponse, e: Error): void {
    if (res.headersSent) return void res.destroy();
    if (e instanceof HttpError) return this.json(res, e.status, { ...e.extra, error: e.message, ...(e.code ? { code: e.code } : {}) });
    this.json(res, 500, { error: e.message });
  }

  private broadcast(project: string, event: Record<string, unknown>): void {
    this.app?.hub.project(project, event);
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
    w.on("error", () => {
      w.close();
      this.watchers.delete(ws.project.id);
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
      locked: isRunActive(ws.dir),
    };
  }

  /**
   * Queues a render of the project's saved EDL; resolves when a render of that mode that started after this
   * call has finished. Renders of one project run one at a time; repeated requests for a mode collapse into one.
   */
  private startRender(ws: Workspace, mode: RenderMode, onProgress?: (done: number, total: number) => void): Promise<RenderResult> {
    const current = this.renders.get(ws.project.id);
    return new Promise<RenderResult>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, onProgress };
      if (current?.running) {
        current.pending.add(mode);
        current.waiting.set(mode, [...(current.waiting.get(mode) ?? []), waiter]);
        return;
      }
      void this.runRender(ws.project.id, mode, [waiter], current);
    });
  }

  private async runRender(id: string, mode: RenderMode, waiters: Waiter[], previous?: RenderState): Promise<void> {
    const state: RenderState = { mode, running: true, pending: previous?.pending ?? new Set(), waiting: previous?.waiting ?? new Map(), current: waiters, done: 0, total: 0 };
    this.renders.set(id, state);
    const publish = () => this.broadcast(id, { type: "render", mode: state.mode, running: state.running, done: state.done, total: state.total });
    publish();
    try {
      // A fresh read of the project, so assets added since the request are known.
      const r = await renderProject(await openProject(id), mode, undefined, (done, total) => {
        state.done = done;
        state.total = total;
        publish();
        for (const w of state.current) w.onProgress?.(done, total);
      });
      state.finishedAt = new Date().toISOString();
      this.broadcast(id, { type: "rendered", mode, frames: r.frames, warnings: r.warnings });
      for (const w of state.current) w.resolve(r);
    } catch (e) {
      state.error = (e as Error).message;
      this.broadcast(id, { type: "render-error", mode, error: state.error });
      for (const w of state.current) w.reject(e as Error);
    } finally {
      state.running = false;
      const next = (["notext", "preview", "master"] as const).find((m) => state.pending.has(m));
      if (next) {
        state.pending.delete(next);
        const queued = state.waiting.get(next) ?? [];
        state.waiting.delete(next);
        void this.runRender(id, next, queued, state);
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

  private assetOr404(ws: Workspace, id: string) {
    try {
      return ws.asset(id);
    } catch {
      throw new HttpError(404, `No asset "${id}" in this project.`, "NO_ASSET");
    }
  }

  /** The editor's write routes refuse while an app run is making the edit (spec D26). */
  private assertUnlocked(ws: Workspace): void {
    if (isRunActive(ws.dir)) throw new HttpError(409, "This edit is still being made. Editing opens when it's done.", "RUN_ACTIVE");
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowed(req)) return this.json(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let parts: string[];
    try {
      parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return this.json(res, 400, { error: "Bad path.", code: "BAD_PATH" });
    }
    if (this.app && (await handleApp(this.app, req, res, url, parts))) return;
    // The editor's own write routes need the intent header too (handleApp let them through to here).
    if (!SAFE_METHODS.has(req.method ?? "GET") && req.headers["x-katana"] !== "1") {
      return this.json(res, 403, { error: "This request needs the x-katana: 1 header.", code: "NO_INTENT" });
    }

    if (parts[0] === "api") {
      if (parts[1] === "fonts" && parts[2] === "face") {
        // A static weight/italic face, fetched on first use.
        const family = url.searchParams.get("family") ?? "";
        const weight = Number(url.searchParams.get("weight") ?? 400);
        const italic = url.searchParams.get("italic") === "1";
        if (!FONTS[family]) return this.json(res, 404, { error: "unknown font" });
        await ensureFonts([family]);
        const file = (w: number, i: boolean) => `/fonts/${w === 400 && !i ? fontFileName(family) : faceFileName(family, w, i)}`;
        if (await ensureFace(family, weight, italic).catch(() => false)) return this.json(res, 200, { url: file(weight, italic), italic });
        // A family without a real italic (League Gothic): the upright face, which the page slants itself,
        // as the renderer does. `italic: false` says the file is upright.
        if (italic && (await ensureFace(family, weight, false).catch(() => false))) return this.json(res, 200, { url: file(weight, false), italic: false });
        return this.json(res, 404, { error: "no such face" });
      }
      if (parts[1] === "fonts" && parts.length === 2) {
        await ensureFonts(Object.keys(FONTS)).catch(() => undefined);
        return this.json(res, 200, Object.fromEntries(Object.entries(FONTS).map(([family, f]) => [family, { url: `/fonts/${fontFileName(family)}`, style: f.style, metrics: fontMetrics(family) }])));
      }
      if (parts[1] === "sfx" && parts.length === 2) return this.json(res, 200, Object.fromEntries(Object.entries(BUILTIN_SFX).map(([k, v]) => [k, v.description])));
      if (parts[1] === "projects" && parts[2] && parts.length <= 4) {
        const ws = await openProject(parts[2]);
        this.watchProject(ws);
        const action = parts[3];
        if (!action && SAFE_METHODS.has(req.method ?? "GET")) return this.json(res, 200, await this.projectState(ws));
        if (action === "edl" && req.method === "PUT") {
          this.assertUnlocked(ws);
          const parsed = EdlSchema.safeParse(await readJsonBody(req));
          if (!parsed.success) return this.json(res, 400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
          const beats = await edlBeats(ws, parsed.data);
          await ws.writeJson("render/edl.json", parsed.data);
          return this.json(res, 200, { ok: true, edl: parsed.data, warnings: checkEdl(parsed.data, { fps: parsed.data.canvas.fps, beats }).warnings });
        }
        if (action === "render" && req.method === "POST") {
          this.assertUnlocked(ws);
          const { mode } = await readJsonBody<{ mode?: RenderMode }>(req);
          // Failures reach the editor as render-error events.
          this.startRender(ws, mode === "master" || mode === "notext" ? mode : "preview").catch(() => undefined);
          return this.json(res, 202, { ok: true });
        }
        if (action === "deliver" && req.method === "POST") {
          this.assertUnlocked(ws);
          const d = await deliverVersion(ws.project.id, "exported from the studio");
          this.app?.runs?.refresh(ws.project.id);
          return this.json(res, 200, { version: d.version, path: d.path, url: d.url, sizeMB: d.sizeMB });
        }
        if (action === "export" && req.method === "POST") {
          // Change the words / Use this take: render the master, deliver the next version (spec §11.6).
          this.assertUnlocked(ws);
          if (!existsSync(ws.path("render", "edl.json"))) throw new HttpError(409, "This project has no edit to render yet.", "NO_EDIT");
          if (!isExporting(ws.project.id)) startExport(ws, { render: (w, mode, onProgress) => this.startRender(w, mode, onProgress), hub: this.app!.hub, onDelivered: (id) => this.app?.runs?.refresh(id) });
          return this.json(res, 202, { ok: true });
        }
        if (action === "thumb" && SAFE_METHODS.has(req.method ?? "GET")) {
          const asset = this.assetOr404(ws, url.searchParams.get("asset") ?? "");
          const t = Math.max(0, Number(url.searchParams.get("t") ?? 0) || 0);
          const h = Math.min(360, Math.max(32, Number(url.searchParams.get("h") ?? 96) || 96));
          const dir = ws.path("render", "thumbs");
          await mkdir(dir, { recursive: true });
          const file = join(dir, `${asset.id}-${t.toFixed(2)}-${h}.jpg`);
          if (!existsSync(file)) {
            const seek = asset.kind === "video" ? ["-ss", String(Math.min(t, Math.max(0, (asset.durationSec ?? 0) - 0.05)))] : [];
            await run("ffmpeg", ["-v", "error", "-y", ...seek, "-i", ws.path(asset.path), "-frames:v", "1", "-vf", `scale=-2:${h}`, "-q:v", "5", file]);
          }
          return serveFile(req, res, file);
        }
        if (action === "waveform" && SAFE_METHODS.has(req.method ?? "GET")) {
          const asset = this.assetOr404(ws, url.searchParams.get("asset") ?? "ref");
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

    if (!SAFE_METHODS.has(req.method ?? "GET")) return this.json(res, 404, { error: "unknown endpoint" });

    if (parts[0] === "media" && parts[1]) {
      const ws = await openProject(parts[1]);
      const file = safeJoin(ws.dir, url.pathname.split("/").filter(Boolean).slice(2).join("/"));
      // Run folders (prompts, the director's stream) and app.json never leave the server.
      if (isPrivateFile(ws.dir, file)) throw new HttpError(404, "Not found.", "NOT_FOUND");
      return serveFile(req, res, file, { untrusted: true });
    }
    if (parts[0] === "fonts" && parts[1]) {
      return serveFile(req, res, safeJoin(fontsDir(), url.pathname.split("/").filter(Boolean).slice(1).join("/")), { cache: "public, max-age=86400" });
    }

    // The app and the editor: one single-page app with history routes.
    // OPEN_KATANA_UI_DIR serves another build of the client (the smoke test builds its own).
    const root = process.env.OPEN_KATANA_UI_DIR || join(packageRoot(), "dist", "studio-ui");
    if (url.pathname !== "/") {
      const file = safeJoin(root, url.pathname.slice(1));
      if (existsSync(file) && statSync(file).isFile()) {
        const immutable = relPosix(root, file).startsWith("assets/");
        return serveFile(req, res, file, { cache: immutable ? CACHE_IMMUTABLE : "no-cache", ...(extname(file) === ".html" ? { headers: { "content-security-policy": CSP } } : {}) });
      }
      // A missing script, style or image is a 404, not the app page.
      if (extname(url.pathname) && extname(url.pathname) !== ".html") throw new HttpError(404, "Not found.", "NOT_FOUND");
    }
    const index = join(root, "index.html");
    if (existsSync(index)) return serveFile(req, res, index, { headers: { "content-security-policy": CSP } });
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": CSP }).end("<p style='font:14px system-ui'>The studio is not built. Run <code>pnpm build</code>.</p>");
  }
}

/**
 * True for app.json and anything under runs/, however the path is spelled. macOS file systems fold case
 * and Unicode ("RUNS", "runſ" with a long s, decomposed accents all open runs/), so the check uses the
 * name on disk (realpath.native) and, as a backstop, compares the files themselves (device and inode).
 */
export function isPrivateFile(dir: string, file: string): boolean {
  const root = existsSync(dir) ? realpathSync.native(dir) : dir;
  const real = existsSync(file) ? realpathSync.native(file) : file;
  const rel = relative(root, real).split(sep).join("/").normalize("NFC").toLowerCase();
  if (rel === "app.json" || rel === "runs" || rel.startsWith("runs/")) return true;
  if (!existsSync(file)) return false;
  const id = (p: string) => {
    try {
      const st = statSync(p);
      return `${st.dev}:${st.ino}`;
    } catch {
      return undefined;
    }
  };
  const blocked = new Set([id(join(dir, "app.json")), id(join(dir, "runs"))].filter(Boolean));
  if (!blocked.size) return false;
  // The file and each folder above it, up to the project folder.
  for (let p = real; p.length > root.length && p.startsWith(root); p = dirname(p)) if (blocked.has(id(p))) return true;
  return false;
}

export const STUDIO_PORT = 4310;

/** The app's identity at a port, when an open-katana server with the app answers there. */
export async function appInfoAt(port: number, timeoutMs = 1500): Promise<Info | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const info = (await res.json()) as Partial<Info>;
    return info.name === "open-katana" && Array.isArray(info.features) && info.features.includes("app") ? (info as Info) : undefined;
  } catch {
    return undefined;
  }
}

async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * A studio that outlives this process: reuses the running app (the app lock's port, then the usual port)
 * when its /api/info lists "app", or starts a detached `open-katana studio` on the usual port, so links stay
 * valid after the agent session ends. When the usual port is held by something else (an older build), or
 * the detached studio doesn't come up, it falls back to an in-process studio on a random port.
 */
export async function ensureStandaloneStudio(project: string): Promise<string> {
  const link = (port: number) => `http://127.0.0.1:${port}/?project=${encodeURIComponent(project)}`;
  const find = async () => {
    for (const port of new Set([(await liveAppLock())?.port, STUDIO_PORT].filter((p): p is number => typeof p === "number" && p > 0))) {
      if (await appInfoAt(port)) return port;
    }
    return undefined;
  };
  const found = await find();
  if (found) return link(found);
  const entry = process.argv[1];
  if (entry && !(await answers(STUDIO_PORT))) {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [...process.execArgv, entry, "studio", "--port", String(STUDIO_PORT), "--no-open"], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => undefined);
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const port = await find();
      if (port) return link(port);
    }
  }
  return (await sharedStudio(0)).url(project);
}

let shared: Studio | undefined;

/** One studio per process, started on first use. It never takes the app lock. */
export async function sharedStudio(port?: number): Promise<Studio> {
  shared ??= new Studio();
  await shared.start(port);
  return shared;
}
