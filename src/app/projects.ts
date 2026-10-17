import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { probe } from "../engine/probe.js";
import { DECODE_BRIEF } from "../presets/brief.js";
import { NOT_TEMPLATABLE } from "../presets/derive.js";
import { listPresets, type PresetEntry } from "../presets/library.js";
import { edlBeats } from "../project/render-project.js";
import { type Project, Workspace } from "../project/workspace.js";
import { type Edl, EdlSchema, resolveTime } from "../render/edl.js";
import { run } from "../util/proc.js";
import { cutMapFromEdl } from "./cutmap.js";
import { noteNextExport, silentPath, sizeMB } from "./export.js";
import { isId, safeJoin, trashDir, trashName } from "./http.js";
import { isRunActive } from "./project-lock.js";
import { type AppCtx, HttpError } from "./router.js";
import { AppJsonSchema, RunRecordSchema, UserPicksFileSchema } from "./schemas.js";
import type { AppJson, CutMapData, DecodeState, ProjectCard, ProjectPageData, RunState, RunStatus, UserPick } from "./types.js";

// Projects as the app shows them: cards, the project page, posters, picks, delete and reveal (spec §7.6).

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` on a freshly opened workspace, one call per project id at a time, so the app's writes to
 * project.json never interleave. The id must already be validated. Not re-entrant: never nest two calls
 * for the same project.
 */
export async function withProject<T>(id: string, fn: (ws: Workspace) => Promise<T>): Promise<T> {
  const before = queues.get(id) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(async () => fn(await Workspace.open(id)));
  const settled = mine.catch(() => undefined);
  queues.set(id, settled);
  void settled.then(() => {
    if (queues.get(id) === settled) queues.delete(id);
  });
  return mine;
}

export async function readAppJson(ws: Workspace): Promise<AppJson | undefined> {
  try {
    return AppJsonSchema.parse(JSON.parse(await readFile(ws.path("app.json"), "utf8")));
  } catch {
    return undefined;
  }
}

/** The status of a run as saved on disk, for servers that don't run edits themselves. */
async function savedRunStatus(ws: Workspace, rid: string | undefined): Promise<RunStatus | undefined> {
  if (!rid || !isId("run", rid)) return undefined;
  try {
    return RunRecordSchema.parse(JSON.parse(await readFile(ws.path("runs", rid, "run.json"), "utf8"))).status;
  } catch {
    return undefined;
  }
}

const ASPECT = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/;
export function aspectValue(aspect: string): number | undefined {
  const m = ASPECT.exec(aspect);
  return m && Number(m[2]) > 0 ? Math.round((Number(m[1]) / Number(m[2])) * 1000) / 1000 : undefined;
}

async function readEdl(ws: Workspace): Promise<Edl | undefined> {
  return ws.readJson("render/edl.json", EdlSchema).catch(() => undefined);
}

async function readDecode(ws: Workspace, ctx: Pick<AppCtx, "decodes">): Promise<DecodeState | undefined> {
  try {
    const live = await ctx.decodes.get(ws);
    if (live) return live;
  } catch {
    // The decode service may not know this project; the saved state is enough.
  }
  return ws.readJson<DecodeState>("analysis/decode.json").catch(() => undefined);
}

/** Where a project's poster comes from: the latest delivery, then the master, preview, reference, first photo. */
export function posterSource(ws: Workspace): { file: string; durationSec?: number; still: boolean } | undefined {
  const latest = ws.project.versions.at(-1);
  const renders = [latest?.path, "render/master.mp4", "render/preview.mp4"].filter((p): p is string => Boolean(p));
  for (const rel of renders) {
    const file = ws.path(rel);
    if (existsSync(file)) return { file, still: false };
  }
  for (const id of ["ref", "s1"]) {
    const a = ws.project.assets.find((x) => x.id === id) ?? (id === "ref" ? ws.reference() : undefined);
    if (a && existsSync(ws.path(a.path))) return { file: ws.path(a.path), durationSec: a.durationSec, still: a.kind === "image" };
  }
  return undefined;
}

/** A JPEG poster `h` px tall (120–720), cached in render/thumbs by the source's mtime. */
export async function posterFile(ws: Workspace, h: number): Promise<string | undefined> {
  const src = posterSource(ws);
  if (!src) return undefined;
  const height = Math.round(Math.min(720, Math.max(120, Number.isFinite(h) ? h : 480)));
  const dir = ws.path("render", "thumbs");
  const out = join(dir, `poster-${Math.round(statSync(src.file).mtimeMs)}-${height}.jpg`);
  if (existsSync(out)) return out;
  await mkdir(dir, { recursive: true });
  let seek: string[] = [];
  if (!src.still) {
    const duration = src.durationSec ?? (await probe(src.file)).durationSec;
    seek = ["-ss", (duration * 0.4).toFixed(3)];
  }
  const tmp = `${out}.${randomBytes(3).toString("hex")}.jpg`;
  try {
    await run("ffmpeg", ["-v", "error", "-y", ...seek, "-i", src.file, "-frames:v", "1", "-vf", `scale=-2:${height}`, "-q:v", "4", tmp]);
    await rename(tmp, out);
  } finally {
    await rm(tmp, { force: true });
  }
  return out;
}

const urlOf = (ws: Workspace, rel: string) => `/media/${ws.project.id}/${rel.split(/[\\/]/).map(encodeURIComponent).join("/")}`;

function canvasAspect(ws: Workspace, edl: Edl | undefined, presets: Map<string, PresetEntry>): number | undefined {
  if (edl) return Math.round((edl.canvas.width / edl.canvas.height) * 1000) / 1000;
  const ref = ws.reference() ?? ws.project.assets.find((a) => a.id === "s1");
  if (ref?.width && ref.height) return Math.round((ref.width / ref.height) * 1000) / 1000;
  const preset = ws.project.preset ? presets.get(ws.project.preset) : undefined;
  return preset ? aspectValue(preset.format.aspect) : undefined;
}

const HOLDS_LOCK = new Set<RunStatus>(["queued", "starting", "running", "stopping", "paused"]);

/** The card state, first match wins (spec §3.5). */
export function cardState(o: { status?: RunStatus; versions: number; app?: AppJson; decoded: boolean }): ProjectCard["state"] {
  const { status } = o;
  if (status === "queued") return "queued";
  if (status === "starting" || status === "running" || status === "stopping") return "making";
  if (status === "paused") return "needs-you";
  if (o.versions > 0) return "ready";
  if (status === "cancelled" || status === "interrupted") return "stopped";
  if (status === "failed") return "failed";
  if (o.app?.origin.kind === "decode" && o.decoded) return "decoded";
  if (!o.app) return "chat";
  // An app project that matches nothing above: a decode still running (or one that failed), or a template
  // project whose run record is missing.
  return o.app.origin.kind === "decode" ? "decoded" : "stopped";
}

interface CardParts {
  card: ProjectCard;
  app?: AppJson;
  run?: RunState;
  edl?: Edl;
  decode?: DecodeState;
}

async function buildCard(ws: Workspace, ctx: Pick<AppCtx, "runs" | "decodes">, presets: Map<string, PresetEntry>): Promise<CardParts> {
  const p: Project = ws.project;
  const app = await readAppJson(ws);
  const run = app?.runs.length && ctx.runs ? await ctx.runs.latestFor(p.id).catch(() => undefined) : undefined;
  const status = run?.status ?? (await savedRunStatus(ws, app?.runs.at(-1)));
  const edl = await readEdl(ws);
  const decode = app?.origin.kind === "decode" ? await readDecode(ws, ctx) : undefined;
  const state = cardState({ status, versions: p.versions.length, app, decoded: decode?.status === "done" || decode?.status === "ready" });
  let cutMap: CutMapData | undefined = decode?.cutMap;
  if (edl && (p.versions.length || !cutMap)) cutMap = (await cutMapFromEdl(ws).catch(() => undefined)) ?? cutMap;
  const latest = p.versions.at(-1);
  const card: ProjectCard = {
    id: p.id,
    title: p.title,
    stage: p.stage,
    updatedAt: p.updatedAt,
    createdAt: app?.createdAt ?? p.createdAt,
    versions: p.versions.length,
    origin: app?.origin.kind ?? "chat",
    ...((app?.origin.template ?? p.preset) ? { template: app?.origin.template ?? p.preset } : {}),
    state,
    ...(run && (state === "making" || state === "queued" || state === "needs-you") ? { progress: { pct: run.pct, headline: run.headline } } : {}),
    ...(status && HOLDS_LOCK.has(status) && app?.runs.length ? { activeRun: app.runs.at(-1)! } : {}),
    ...(posterSource(ws) ? { poster: `/api/projects/${p.id}/poster?h=480` } : {}),
    ...(latest ? { latest: { url: urlOf(ws, latest.path), version: latest.version } } : {}),
    ...(() => {
      const aspect = canvasAspect(ws, edl, presets);
      return aspect ? { aspect } : {};
    })(),
    ...(cutMap ? { cutMap } : {}),
  };
  return { card, app, run, edl, decode };
}

async function presetMap(): Promise<Map<string, PresetEntry>> {
  return new Map((await listPresets().catch(() => [])).map((p) => [p.slug, p]));
}

/** Every project as a card, newest first; edits being made or needing the person first. */
export async function listProjectCards(ctx: Pick<AppCtx, "runs" | "decodes">): Promise<ProjectCard[]> {
  const presets = await presetMap();
  const cards: ProjectCard[] = [];
  for (const project of await Workspace.list()) {
    if (!isId("project", project.id)) continue;
    try {
      cards.push((await buildCard(await Workspace.open(project.id), ctx, presets)).card);
    } catch {
      // A project that can't be read is left out rather than failing the list.
    }
  }
  const pinned = (c: ProjectCard) => (c.state === "making" || c.state === "needs-you" || c.state === "queued" ? 0 : 1);
  return cards.sort((a, b) => pinned(a) - pinned(b) || b.updatedAt.localeCompare(a.updatedAt));
}

export async function projectCard(ws: Workspace, ctx: Pick<AppCtx, "runs" | "decodes">): Promise<ProjectCard> {
  return (await buildCard(ws, ctx, await presetMap())).card;
}

/**
 * Whether the edit can be saved as a template: the preconditions of deriveTemplate (spec §11.7 step 1), checked
 * cheaply for the result page. The first reason is shown.
 */
export function canSaveTemplate(ws: Workspace, app: AppJson | undefined, edl: Edl | undefined): ProjectPageData["canSaveTemplate"] {
  const latest = ws.project.versions.at(-1);
  if (app?.origin.kind !== "decode") return { ok: false, reason: NOT_TEMPLATABLE.notDecoded };
  if (!latest || !existsSync(ws.path(latest.path))) return { ok: false, reason: NOT_TEMPLATABLE.notDelivered };
  if (!edl) return { ok: false, reason: NOT_TEMPLATABLE.noCut };
  const find = (id: string) => ws.project.assets.find((a) => a.id === id) ?? (id === "ref" ? ws.reference() : undefined);
  // The reference, any reference-role asset, or a frame taken from one ("ref_f42").
  const showsReference = (id: string) => {
    const a = find(id);
    const base = /^(.+)_f\d+$/.exec(id)?.[1];
    return id === "ref" || a?.role === "reference" || (a?.role === "style" && base !== undefined && find(base)?.role === "reference");
  };
  const pictures = edl.shots.flatMap((s) => [s.source, ...(s.layers ?? []).map((l) => l.source)]).flatMap((src) => [src.asset, src.matte]);
  const ids = pictures.filter((id): id is string => Boolean(id) && !/^(black|white|#[0-9a-fA-F]{6})$/.test(id!));
  const missing = ids.find((id) => !find(id));
  if (missing) return { ok: false, reason: NOT_TEMPLATABLE.missing(missing) };
  if (ids.some(showsReference)) return { ok: false, reason: NOT_TEMPLATABLE.refFrames };
  const audio = edl.audio?.asset;
  const sound = audio && (audio === "ref" || find(audio)?.role === "reference" || (audio === "music" && find(audio)));
  if (!sound) return { ok: false, reason: NOT_TEMPLATABLE.sound };
  return { ok: true };
}

/** Everything the project page shows: card, latest run, decode, versions, words, and the draft for Make another. */
export async function projectPage(ws: Workspace, ctx: Pick<AppCtx, "runs" | "decodes">): Promise<ProjectPageData> {
  const { card, app, run, edl, decode } = await buildCard(ws, ctx, await presetMap());
  const id = ws.project.id;
  const versions: ProjectPageData["versions"] = [];
  for (const v of ws.project.versions) {
    const file = ws.path(v.path);
    versions.push({
      version: v.version,
      url: urlOf(ws, v.path),
      ...(existsSync(silentPath(file)) ? { silentUrl: silentPath(urlOf(ws, v.path)) } : {}),
      ...(await sizeMB(file).then((mb) => (mb === undefined ? {} : { sizeMB: mb }))),
      createdAt: v.createdAt,
      ...(v.note ? { note: v.note } : {}),
    });
  }
  let words: ProjectPageData["words"];
  if (edl?.text.length) {
    const beats = await edlBeats(ws, edl).catch(() => [] as number[]);
    words = edl.text.map((t, index) => {
      let startSec = 0;
      try {
        startSec = Math.round(resolveTime(t.start, { fps: edl.canvas.fps, beats }) * 1000) / 1000;
      } catch {
        // Beat times without a grid or tracked beats: keep 0.
      }
      return { index, text: t.text, startSec, font: t.font, weight: t.weight ?? 400, italic: t.italic, uppercase: t.uppercase };
    });
  }
  let draft = app?.draft;
  if (draft) {
    // Make another reuses this project's photos and track by reference.
    const photos = ws.subjects().map((a) => `${id}:${a.id}`);
    const music = ws.project.assets.some((a) => a.id === "music" && a.role === "audio") ? `${id}:music` : undefined;
    draft = { ...draft, photos: photos.length ? photos : draft.photos, ...(music ? { music } : {}) };
    if (!music) delete draft.music;
  }
  return {
    card,
    ...(run ? { run } : {}),
    ...(decode ? { decode } : {}),
    ...(app?.origin.kind === "decode" ? { brief: DECODE_BRIEF } : {}),
    versions,
    ...(words ? { words } : {}),
    canSaveTemplate: canSaveTemplate(ws, app, edl),
    ...(draft ? { draft } : {}),
    locked: isRunActive(ws.dir),
  };
}

/** Moves a project to ~/.open-katana/trash/<id>-<stamp>. 409 while a run holds it. */
export async function trashProject(id: string): Promise<void> {
  await withProject(id, async (ws) => {
    if (isRunActive(ws.dir)) throw new HttpError(409, "Stop the edit first.", "RUN_ACTIVE");
    await mkdir(trashDir(), { recursive: true });
    await rename(ws.dir, join(trashDir(), trashName(id)));
  });
}

/** The file manager command that shows a file (selected) or a folder. No shell. */
export function revealCommand(platform: NodeJS.Platform, target: { file?: string; dir: string }): [string, string[]] {
  if (platform === "darwin") return target.file ? ["open", ["-R", target.file]] : ["open", [target.dir]];
  if (platform === "win32") return target.file ? ["explorer", [`/select,${target.file}`]] : ["explorer", [target.dir]];
  return ["xdg-open", [target.file ? dirname(target.file) : target.dir]];
}

/** Shows the latest delivered video, or the project folder, in the file manager. */
export function revealProject(ws: Workspace, what: "latest" | "folder"): void {
  let file: string | undefined;
  if (what === "latest") {
    const latest = ws.project.versions.at(-1);
    if (!latest) throw new HttpError(409, "There's no finished video yet.", "NO_VERSION");
    file = safeJoin(ws.dir, latest.path.split(/[\\/]/).map(encodeURIComponent).join("/"));
    if (!existsSync(file)) throw new HttpError(404, "The finished video is missing from the project folder.", "NOT_FOUND");
  }
  const [cmd, args] = revealCommand(process.platform, { file, dir: ws.dir });
  if (process.env.OPEN_KATANA_REVEAL_DRY === "1") return;
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

/**
 * Records the person's pick for a line in qa/user-picks.json (the app is its only writer). With no run
 * holding the project it also swaps the pick into render/edl.json: every shot, layer or matte source taken
 * from that line now uses the pick, in-points kept.
 */
export async function applyPick(id: string, line: string, asset: string): Promise<{ picks: UserPick[]; edlChanged: boolean }> {
  return withProject(id, async (ws) => {
    const take = ws.project.assets.find((a) => a.id === asset);
    if (!take || take.lineId !== line) throw new HttpError(400, `"${asset}" isn't a take of line ${line}.`, "NOT_A_TAKE");
    const saved = await ws.readJson("qa/user-picks.json", UserPicksFileSchema).catch(() => undefined);
    const picks: UserPick[] = [...(saved?.picks ?? []).filter((p) => p.line !== line), { line, asset, at: new Date().toISOString() }];
    await ws.writeJson("qa/user-picks.json", { v: 1, picks });
    let edlChanged = false;
    const edl = isRunActive(ws.dir) ? undefined : await readEdl(ws);
    if (edl) {
      const fromLine = new Set(ws.project.assets.filter((a) => a.lineId === line && a.id !== asset).map((a) => a.id));
      for (const src of edl.shots.flatMap((s) => [s.source, ...(s.layers ?? []).map((l) => l.source)])) {
        if (fromLine.has(src.asset)) {
          src.asset = asset;
          edlChanged = true;
        }
        if (src.matte && fromLine.has(src.matte)) {
          src.matte = asset;
          edlChanged = true;
        }
      }
      if (edlChanged) {
        await ws.writeJson("render/edl.json", edl);
        noteNextExport(id, "pick applied in the app");
      }
    }
    return { picks, edlChanged };
  });
}
