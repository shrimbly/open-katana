import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { CutMapData, DecodeState } from "../app/types.js";
import { profile } from "../comfy/operations.js";
import type { EnergyMap } from "../engine/energy.js";
import { probe, rationalValue } from "../engine/probe.js";
import { edlBeats } from "../project/render-project.js";
import type { Asset, Workspace } from "../project/workspace.js";
import { checkEdl, type Edl, EdlSchema, resolveTime, type TimeContext } from "../render/edl.js";
import { BUILTIN_SFX } from "../render/sfx.js";
import { run } from "../util/proc.js";
import { listPresets, type Preset, type PresetEntry, PresetSchema, savePreset } from "./library.js";

// Save as template (spec §11.7): a delivered edit of a decoded video becomes a local template. No agent and no
// GPU: the generated shots become slots, the words become the brief's defaults and the timing stays as cut.

/** Why an edit can't become a template (shown in the Save as template sheet). */
export const NOT_TEMPLATABLE = {
  notDecoded: "Only edits made from a decoded video can be saved as templates.",
  notDelivered: "Make your edit first. Saving it as a template is instant and free.",
  noCut: "This edit has no saved cut yet.",
  refFrames: "This edit shows frames of the original video, so it can't become a template yet.",
  sound: "Templates keep the edit's sound: use the original sound or your own track.",
  missing: (id: string) => `This edit uses a shot that is no longer in the project (${id}).`,
};

/** The slug already names a template (built-in or yours). The templates route answers 409 SLUG_TAKEN. */
export class SlugTakenError extends Error {
  readonly code = "SLUG_TAKEN";
  constructor(readonly slug: string) {
    super(`A template called "${slug}" already exists. Pick another name.`);
  }
}

/** Size budgets of bundled template media (spec §14.2), in bytes. */
export const MEDIA_BUDGET = { example: 3.5 * 2 ** 20, poster: 200 * 1024, soundtrack: 2 ** 20, cutmap: 20 * 1024, total: 30 * 2 ** 20 };

const COLOR = /^(black|white|#[0-9a-fA-F]{6})$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BEAT = /^b\d+(\.\d+)?$/;
/** Keys whose values are timeline times in an EDL (shots, layers, text, flashes, sfx, punches, shake). */
const TIME_KEYS = new Set(["start", "end", "at", "from", "to"]);
const GROUP_GAP_SEC = 1.5;
const MAX_FIELDS = 16;
const VISIBLE_FIELDS = 4;

interface RawSource {
  asset?: string;
  matte?: string;
}
interface RawShot {
  source?: RawSource;
  layers?: { source?: RawSource }[];
}
interface PlanFile {
  concept?: string;
  shots?: { at?: string; role?: string; description?: string; lines?: string[] }[];
  jobs?: JobLike["spec"][];
}
interface JobLike {
  id: string;
  line: string;
  profile: string;
  state?: string;
  outputs?: string[];
  spec: { line: string; operation: string; prompt: string; start?: string; profile?: string };
}

/**
 * Saves a delivered edit of a decoded video as a local template: generated shots become slots, the words
 * become the brief's defaults and the timing stays exactly as cut (spec §11.7). Returns the reasons when the
 * edit can't become one; throws SlugTakenError when the slug is in use.
 */
export async function deriveTemplate(ws: Workspace, meta: { title: string; slug: string; description: string }): Promise<{ ok: true; entry: PresetEntry } | { ok: false; reasons: string[] }> {
  const reasons: string[] = [];
  const app = await ws.readJson<{ origin?: { kind?: string; sourceName?: string } }>("app.json").catch(() => undefined);
  if (app?.origin?.kind !== "decode") reasons.push(NOT_TEMPLATABLE.notDecoded);
  const version = ws.project.versions.at(-1);
  const delivered = version && existsSync(ws.path(version.path)) ? ws.path(version.path) : undefined;
  if (!delivered) reasons.push(NOT_TEMPLATABLE.notDelivered);
  const raw = await ws.readJson<Record<string, unknown>>("render/edl.json").catch(() => undefined);
  const parsed = raw ? EdlSchema.safeParse(raw) : undefined;
  if (!raw || !parsed?.success) {
    reasons.push(NOT_TEMPLATABLE.noCut);
    return { ok: false, reasons };
  }
  const edl = parsed.data;
  const pictures = [...new Set(pictureIds(edl))];
  for (const id of pictures) if (!findAsset(ws, id)) reasons.push(NOT_TEMPLATABLE.missing(id));
  if (pictures.some((id) => isReferencePicture(ws, id))) reasons.push(NOT_TEMPLATABLE.refFrames);
  const sound = soundOf(ws, edl);
  if (!sound) reasons.push(NOT_TEMPLATABLE.sound);
  if (reasons.length || !delivered || !sound) return { ok: false, reasons };

  if (!SLUG.test(meta.slug) || meta.slug.length > 64) throw new Error(`"${meta.slug}" isn't a template slug: use lowercase words joined by hyphens`);
  if ((await listPresets()).some((p) => p.slug === meta.slug)) throw new SlugTakenError(meta.slug);

  const plan = (await ws.readJson<PlanFile>("plan/plan.json").catch(() => undefined)) ?? {};
  const jobs = (await ws.readJson<JobLike[]>("plan/jobs.json").catch(() => undefined)) ?? [];
  const decode = await ws.readJson<DecodeState>("analysis/decode.json").catch(() => undefined);
  const energy = await ws.readJson<EnergyMap>("analysis/energy.json").catch(() => undefined);
  const ctx: TimeContext = { fps: edl.canvas.fps, beats: await edlBeats(ws, edl) };
  const check = checkEdl(edl, ctx);
  const durationSec = round(check.durationSec, 4);

  const slots = makeSlots(ws, pictures, plan, jobs);
  const skeleton = makeSkeleton(raw, edl, slots.slotOf, ctx, durationSec);
  const words = edl.text.map((t, index) => ({ index, text: t.text, start: resolveTime(t.start, ctx) })).sort((a, b) => a.start - b.start);
  const first = words[0] && edl.text[words[0].index]!;
  const grid = edl.grid;
  const offset = edl.audio?.offset ?? 0;
  const decodeDrop = sound === "ref" && decode?.cutMap?.dropSec !== undefined ? decode.cutMap.dropSec - offset : undefined;
  const dropBeat = grid && decodeDrop !== undefined && decodeDrop >= grid.phase ? Math.round((decodeDrop - grid.phase) / (60 / grid.bpm)) : undefined;
  const sourceName = app?.origin?.sourceName ?? ws.project.title;
  const used = usedJobs(slots.lines, plan, jobs);

  const tmp = await mkdtemp(join(tmpdir(), "ok-derive-"));
  try {
    const files = { "example.mp4": join(tmp, "example.mp4"), "poster.jpg": join(tmp, "poster.jpg"), "soundtrack.m4a": join(tmp, "soundtrack.m4a"), "cutmap.json": join(tmp, "cutmap.json") };
    await encodeExample(delivered, files["example.mp4"], { preset: "medium" });
    await extractPoster(delivered, files["poster.jpg"], { at: durationSec * 0.4 });
    await run("ffmpeg", [
      "-v", "error", "-y", "-ss", String(offset), "-t", String(round(durationSec + 1, 3)), "-i", ws.assetPath(edl.audio!.asset),
      "-vn", "-c:a", "aac", "-b:a", "160k", "-map_metadata", "-1", files["soundtrack.m4a"],
    ]);
    const cutmap = await templateCutMap(ws, check.shots.map((s) => ({ start: s.startSec, end: s.endSec, slot: slots.slotOf.get(s.shot.source.asset) })), files["example.mp4"], edl.canvas.fps);
    if (cutmap) await writeFile(files["cutmap.json"], JSON.stringify(cutmap));

    const preset: Preset = {
      slug: meta.slug,
      title: meta.title,
      description: (meta.description ?? "").trim() || `Your cut of ${sourceName}, saved as a template.`,
      category: "personalized_edits",
      format: { aspect: aspectLabel(edl.canvas.width, edl.canvas.height), durationSec, fps: edl.canvas.fps },
      inputs: { images: { min: 1, max: 5, title: "Your character: face and full outfit" }, music: "optional", instructionsMaxChars: 2000 },
      recipe: {
        look: describeFinish(edl.finish),
        fonts: [...new Set(edl.text.map((t) => t.font))],
        palette: palette(decode),
        energy: energy ? describeEnergy(energy) : undefined,
        structure: (plan.shots ?? []).map((s) => ({ at: s.at ?? "", role: s.role ?? "", guidance: s.description ?? "" })),
      },
      slots: slots.list,
      skeleton,
      prompt: (plan.concept ?? "").slice(0, 4000),
      author: "you",
      display: first ? { font: first.font, weight: first.weight ?? 400, italic: first.italic, case: first.uppercase ? "upper" : "as-typed", color: first.color.toUpperCase() } : undefined,
      timing: grid ? { nominalBpm: Math.min(240, Math.max(40, grid.bpm)), ...(dropBeat !== undefined ? { dropBeat } : {}) } : undefined,
      example: { video: "example.mp4", poster: "poster.jpg", credit: credit(used, sound), models: [...new Set(used.map((j) => j.profile))] },
      soundtrack: {
        file: "soundtrack.m4a",
        title: sound === "ref" ? "Original sound" : trackTitle(ws, edl.audio!.asset),
        licence: sound === "ref" ? "third-party: from the original video, not yours to publish" : "yours",
        ...soundtrackTempo(grid, sound === "ref" ? decode : undefined),
        ...(decodeDrop !== undefined && decodeDrop >= 0 && decodeDrop < durationSec ? { dropSec: round(decodeDrop, 3) } : {}),
      },
      cutmap: cutmap ? "cutmap.json" : undefined,
      brief: briefFields(words),
      origin: { kind: "decoded", project: ws.project.id, createdAt: new Date().toISOString() },
    };
    validate(preset);
    const extra: Record<string, string> = Object.fromEntries(Object.entries(files).filter(([name]) => name !== "cutmap.json" || cutmap));
    return { ok: true, entry: await savePreset(preset, { extra }) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------- sources and slots ----------

function eachSource(edl: { shots: RawShot[] }, fn: (src: RawSource) => void): void {
  for (const shot of edl.shots) {
    if (shot.source) fn(shot.source);
    for (const layer of shot.layers ?? []) if (layer.source) fn(layer.source);
  }
}

/** Every picture asset the cut shows: shot and layer sources and their mattes (colours excluded). */
function pictureIds(edl: Edl): string[] {
  const out: string[] = [];
  eachSource(edl, (src) => {
    for (const id of [src.asset, src.matte]) if (id && !COLOR.test(id)) out.push(id);
  });
  return out;
}

function findAsset(ws: Workspace, id: string): Asset | undefined {
  try {
    return ws.asset(id);
  } catch {
    return undefined;
  }
}

/** The reference itself, any reference-role asset, or a frame taken from one ("ref_f42", made by "ref@f42"). */
function isReferencePicture(ws: Workspace, id: string): boolean {
  const a = findAsset(ws, id);
  if (id === "ref" || a?.role === "reference") return true;
  const base = /^(.+)_f\d+$/.exec(id)?.[1];
  return Boolean(a?.role === "style" && base && findAsset(ws, base)?.role === "reference");
}

/** "ref" for the original video's sound, "music" for the person's track; undefined otherwise. */
function soundOf(ws: Workspace, edl: Edl): "ref" | "music" | undefined {
  const asset = edl.audio?.asset;
  if (!asset) return undefined;
  if (asset === "ref" || findAsset(ws, asset)?.role === "reference") return "ref";
  return asset === "music" && findAsset(ws, asset) ? "music" : undefined;
}

const slotId = (line: string) =>
  line
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "shot";

function firstSentence(text: string): string {
  const m = /^.*?[.!?](?=\s|$)/s.exec(text.trim());
  return (m ? m[0] : text.trim()).slice(0, 300);
}

/** The spec a line was planned with (its "@line" references intact), else the one it was submitted with. */
function lineSpec(line: string, plan: PlanFile, jobs: JobLike[]): JobLike["spec"] | undefined {
  return plan.jobs?.find((j) => j.line === line) ?? jobs.find((j) => j.line === line)?.spec;
}

/** The line a clip started from ("@temple-key", or the asset id it resolved to). */
function startLine(ws: Workspace, start: string | undefined): string | undefined {
  if (!start) return undefined;
  if (start.startsWith("@")) return start.slice(1);
  return findAsset(ws, start)?.lineId;
}

function makeSlots(ws: Workspace, pictures: string[], plan: PlanFile, jobs: JobLike[]) {
  const slotOf = new Map<string, string>();
  const list: Preset["slots"] = [];
  const lines: string[] = [];
  const add = (asset: string, slot: Preset["slots"][number]) => {
    slotOf.set(asset, slot.id);
    if (!list.some((s) => s.id === slot.id)) list.push(slot);
  };
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; list.some((s) => s.id === id); n++) id = `${base.slice(0, 29)}-${n}`;
    return id;
  };
  // Several takes of one line share its slot: a new run makes one output per line.
  const slotOfLine = new Map<string, string>();
  for (const id of pictures) {
    const a = findAsset(ws, id)!;
    if (a.role === "generated") {
      const line = a.lineId ?? jobs.find((j) => j.id === a.jobId)?.line ?? a.id;
      const known = slotOfLine.get(line);
      if (known) {
        slotOf.set(id, known);
        continue;
      }
      const sid = unique(slotId(line));
      slotOfLine.set(line, sid);
      lines.push(line);
      const spec = lineSpec(line, plan, jobs);
      const job = jobs.find((j) => j.outputs?.includes(id)) ?? jobs.find((j) => j.line === line);
      const prof = job?.profile ?? spec?.profile;
      const keyLine = spec?.operation.startsWith("clip.") ? startLine(ws, spec.start) : undefined;
      const keySpec = keyLine ? lineSpec(keyLine, plan, jobs) : undefined;
      const fromKey = keySpec?.operation.startsWith("still.") ? keySpec : undefined;
      if (fromKey && keyLine) lines.push(keyLine);
      const described = (plan.shots ?? []).filter((s) => s.lines?.includes(line) && s.description).map((s) => s.description!.trim());
      const description = [...new Set(described)].join(" ").slice(0, 300) || (spec ? firstSentence(spec.prompt) : "") || `Generated ${a.kind === "video" ? "clip" : "still"} "${line}".`;
      add(id, {
        id: sid,
        kind: a.kind === "video" ? "clip" : "still",
        description,
        operation: spec ? `${fromKey ? `${fromKey.operation} → ` : ""}${spec.operation}${prof ? ` (${prof})` : ""}` : undefined,
        guidance: spec ? (fromKey ? `${fromKey.prompt} Motion: ${spec.prompt}` : spec.prompt) : undefined,
      });
    } else if (a.role === "subject") {
      add(id, { id: unique("photo"), kind: "still", description: "The person's photo, shown as is" });
    } else if (a.role === "footage") {
      add(id, { id: unique("footage"), kind: "footage", description: "Your own footage, shown as is" });
    } else {
      add(id, { id: unique(slotId(a.id)), kind: a.kind === "video" ? "clip" : "still", description: a.label ?? "A picture shown as is" });
    }
  }
  return { slotOf, list, lines };
}

/** Jobs whose outputs the template's slots came from (clips and the keyframes they started from). */
function usedJobs(lines: string[], plan: PlanFile, jobs: JobLike[]): { operation: string; profile: string }[] {
  const out: { operation: string; profile: string }[] = [];
  for (const line of lines) {
    const job = jobs.find((j) => j.line === line && j.state === "completed") ?? jobs.find((j) => j.line === line);
    const operation = job?.spec.operation ?? lineSpec(line, plan, jobs)?.operation;
    if (job && operation) out.push({ operation, profile: job.profile });
  }
  return out;
}

// ---------- skeleton ----------

/** Resolves beat times ("b12.5") to seconds in place, under the EDL's time keys. */
function freezeBeats(v: unknown, ctx: TimeContext, key?: string): unknown {
  if (typeof v === "string") return key && TIME_KEYS.has(key) && BEAT.test(v) ? round(resolveTime(v, ctx), 4) : v;
  if (Array.isArray(v)) return v.map((x) => freezeBeats(x, ctx, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, freezeBeats(x, ctx, k)]));
  return v;
}

/**
 * The EDL as authored, with its generated and photo sources replaced by "slot:<id>" and the sound pointed at
 * the template's soundtrack. Without a grid, beat times follow the tracked beats of this edit's sound, so they
 * are frozen to seconds: the timing stays exactly as cut.
 */
function makeSkeleton(raw: Record<string, unknown>, edl: Edl, slotOf: Map<string, string>, ctx: TimeContext, durationSec: number): Record<string, unknown> {
  let sk = structuredClone(raw) as Record<string, unknown> & { shots: RawShot[]; sfx?: { sound: string }[] };
  eachSource(sk, (src) => {
    if (src.asset && slotOf.has(src.asset)) src.asset = `slot:${slotOf.get(src.asset)}`;
    if (src.matte && slotOf.has(src.matte)) src.matte = `slot:${slotOf.get(src.matte)}`;
  });
  // Sound effects taken from project assets can't travel with the template; the built-in ones can.
  if (sk.sfx) sk.sfx = sk.sfx.filter((s) => s.sound in BUILTIN_SFX);
  if (!edl.grid) sk = freezeBeats(sk, ctx) as typeof sk;
  // The soundtrack is cut from the offset, so it starts at 0; the mix settings carry over as authored.
  const { gainDb, fadeOut } = (raw.audio ?? {}) as { gainDb?: number; fadeOut?: number };
  sk.audio = { asset: "music", offset: 0, ...(gainDb !== undefined ? { gainDb } : {}), ...(fadeOut !== undefined ? { fadeOut } : {}) };
  sk.canvas = { ...(sk.canvas as object), durationSec };
  return sk;
}

// ---------- brief, recipe, credit ----------

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const roomFor = (texts: string[]) => {
  const len = Math.max(...texts.map((t) => t.length));
  return len > 200 ? undefined : Math.min(200, Math.max(len + 3, Math.ceil(len * 1.25)));
};

/** One text field per card, or one words field per run of cards less than 1.5 s apart, defaulting to the cut's words. */
function briefFields(words: { index: number; text: string; start: number }[]): Preset["brief"] {
  const groups: (typeof words)[] = [];
  for (const w of words) {
    const last = groups.at(-1);
    if (last && w.start - last.at(-1)!.start < GROUP_GAP_SEC) last.push(w);
    else groups.push([w]);
  }
  while (groups.length > MAX_FIELDS) groups.splice(MAX_FIELDS - 1, 2, [...groups[MAX_FIELDS - 1]!, ...groups[MAX_FIELDS]!]);
  return groups.map((g, i) => {
    const from = clock(g[0]!.start);
    const to = clock(g.at(-1)!.start);
    const common = { id: `card${i + 1}`, required: false, allowOther: false, suggestions: [], maxChars: roomFor(g.map((w) => w.text)), binds: g.map((w) => ({ index: w.index })), verbatim: false, collapsed: i >= VISIBLE_FIELDS };
    return g.length === 1
      ? { ...common, label: `Card at ${from}`, kind: "text" as const, default: g[0]!.text }
      : { ...common, label: from === to ? `Cards at ${from}` : `Cards at ${from}–${to}`, kind: "words" as const, default: g.map((w) => w.text) };
  });
}

function describeFinish(f: Edl["finish"]): string {
  const parts = [f.look === "none" ? "no overall grade" : `${f.look} grade`];
  if (f.grain) parts.push(`grain ${f.grain}`);
  if (f.vignette) parts.push(`vignette ${f.vignette}`);
  if (f.letterbox) parts.push(`letterbox ${f.letterbox}`);
  return parts.join(", ");
}

/** Up to 6 of the decoded shot colours, spread over the edit. */
function palette(decode: DecodeState | undefined): string[] {
  const colors = [...new Set((decode?.shots ?? []).map((s) => s.color.toUpperCase()).filter((c) => /^#[0-9A-F]{6}$/.test(c)))];
  if (colors.length <= 6) return colors;
  return Array.from({ length: 6 }, (_, i) => colors[Math.round((i * (colors.length - 1)) / 5)]!);
}

function describeEnergy(e: EnergyMap): string {
  const s = e.summary;
  const parts = [`${s.cutsPerSecond.toFixed(1)} cuts per second (mean shot ${s.meanShotSec.toFixed(2)} s)`, `${Math.round(s.cutsOnBeatShare * 100)}% of cuts on the beat`];
  if (s.flashesPerSecond > 0) parts.push(`${s.flashesPerSecond.toFixed(2)} flashes per second`);
  if (s.shakeSeconds > 0) parts.push(`${s.shakeSeconds.toFixed(1)} s of shake`);
  return `Measured on the original: ${parts.join(", ")}.`;
}

const ROLE_WORDS: [RegExp, string][] = [[/^still\.face/, "Face crop"], [/^still\./, "Keyframes"], [/^clip\./, "Clips"], [/^matte/, "Cut-outs"]];

/** "Made from your edit. Keyframes: Qwen-Image 2.1. Clips: Wan 2.2 I2V A14B. Sound: …" (model names without their notes). */
function credit(used: { operation: string; profile: string }[], sound: "ref" | "music"): string {
  const byRole = new Map<string, Set<string>>();
  for (const j of used) {
    const role = ROLE_WORDS.find(([re]) => re.test(j.operation))?.[1];
    if (!role) continue;
    let name = j.profile;
    try {
      name = profile(j.profile).title.replace(/\s*\(.*$/, "").replace(/\s*\+.*$/, "");
    } catch {
      // An unknown profile keeps its id.
    }
    byRole.set(role, (byRole.get(role) ?? new Set()).add(name));
  }
  const order = ROLE_WORDS.map(([, role]) => role);
  const parts = [...byRole].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([role, names]) => `${role}: ${[...names].join(", ")}.`);
  const music = sound === "ref" ? "Sound: from the original video." : "Sound: your track.";
  return ["Made from your edit.", ...parts, music].join(" ").slice(0, 240);
}

function trackTitle(ws: Workspace, asset: string): string {
  const label = findAsset(ws, asset)?.label;
  return (label ? basename(label, extname(label)) : "Your track").slice(0, 60) || "Your track";
}

function soundtrackTempo(grid: Edl["grid"], decode: DecodeState | undefined): { bpm?: number } {
  const bpm = grid?.bpm ?? decode?.stats?.bpm;
  return bpm && bpm > 0 ? { bpm: round(bpm, 1) } : {};
}

function aspectLabel(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/** Checks the invariants every template keeps: schema, slots used and declared, and a valid skeleton. */
function validate(preset: Preset): void {
  const p = PresetSchema.parse(preset);
  const text = JSON.stringify(p.skeleton);
  const used = new Set([...text.matchAll(/"slot:([a-z0-9_-]+)"/g)].map((m) => m[1]!));
  const declared = new Set(p.slots.map((s) => s.id));
  for (const id of used) if (!declared.has(id)) throw new Error(`The template uses slot "${id}" but doesn't declare it`);
  for (const id of declared) if (!used.has(id)) throw new Error(`The template declares slot "${id}" but never uses it`);
  EdlSchema.parse(JSON.parse(text.replace(/"slot:[a-z0-9_-]+"/g, '"black"')));
}

// ---------- media (shared with scripts/build-examples.mjs) ----------

/**
 * A web-size H.264 copy of an edit: `height` px tall (720 by default, never upscaled), the given CRF, fast
 * start and no metadata. The sound is kept (AAC 128k).
 */
export async function encodeExample(input: string, out: string, o: { height?: number; crf?: number; preset?: string } = {}): Promise<void> {
  const h = o.height ?? 720;
  await run("ffmpeg", [
    "-v", "error", "-y", "-i", input,
    "-vf", `scale=-2:'min(${h},ih)'`, "-c:v", "libx264", "-crf", String(o.crf ?? 26), "-preset", o.preset ?? "slow", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-map_metadata", "-1", out,
  ]);
}

/** One JPEG frame at `at` seconds, `height` px tall, at the best quality that fits the poster budget. */
/**
 * The poster's moment: near `target` (the drop), on a frame that shows as little of the edit's own words as
 * possible and no flash, so the tile's title isn't doubled by a word baked into the frame. Each candidate
 * costs the cap height of the words on screen (`size`, a fraction of the frame height, as in the EDL) plus
 * 0.02 per second away from the target: a big word costs more than moving a few seconds, while a small
 * corner caption that runs the whole edit doesn't send the poster to the end card. Frames within two frames
 * of a cut are skipped too (a flash frame, a whip or a one-frame shot reads as a blank tile). Seconds.
 */
export function posterTime(o: { target: number; durationSec: number; fps: number; text: { start: number; end: number; size?: number }[]; flashes: { start: number; end: number }[]; cuts?: number[] }): number {
  const frame = 1 / o.fps;
  const margin = 2 * frame;
  const last = Math.max(0, o.durationSec - frame);
  const ink = (t: number) => o.text.filter((x) => t >= x.start - margin && t <= x.end + margin).reduce((s, x) => s + (x.size ?? 0.1), 0);
  const flashed = (t: number) => o.flashes.some((f) => t >= f.start - margin && t <= f.end + margin) || (o.cuts ?? []).some((c) => Math.abs(t - c) <= margin + 1e-6);
  let best: { t: number; cost: number } | undefined;
  for (let i = 0; i * frame <= last + 1e-9; i++) {
    const t = i * frame;
    if (flashed(t)) continue;
    // Just after the target beats just before it: the drop's own action.
    const away = Math.abs(t - o.target) + (t < o.target ? frame / 2 : 0);
    const cost = ink(t) + 0.02 * away;
    if (!best || cost < best.cost) best = { t, cost };
  }
  return +(best?.t ?? Math.min(Math.max(0, o.target), last)).toFixed(3);
}

export async function extractPoster(input: string, out: string, o: { at: number; height?: number }): Promise<void> {
  const h = o.height ?? 720;
  for (const q of [3, 5, 8, 12]) {
    await run("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, o.at)), "-i", input, "-frames:v", "1", "-vf", `scale=-2:'min(${h},ih)'`, "-q:v", String(q), out]);
    if ((await stat(out)).size <= MEDIA_BUDGET.poster) return;
  }
}

/** Mean colour (#RRGGBB) of the frame at each time, in one decoding pass. */
export async function meanColors(video: string, times: number[]): Promise<(string | undefined)[]> {
  const info = await probe(video);
  const fps = info.video ? rationalValue(info.video.fps) : 0;
  if (!times.length || !fps) return times.map(() => undefined);
  const last = Math.max(0, (info.video?.frameCount ?? 1) - 1);
  const frameOf = (t: number) => Math.min(last, Math.max(0, Math.round(t * fps)));
  const frames = [...new Set(times.map(frameOf))].sort((a, b) => a - b);
  const SIDE = 8;
  const size = SIDE * SIDE * 3;
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-i", video, "-vf", `select='${frames.map((f) => `eq(n,${f})`).join("+")}',scale=${SIDE}:${SIDE}:flags=area`,
    "-fps_mode", "passthrough", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  const color = new Map<number, string>();
  frames.forEach((f, i) => {
    if ((i + 1) * size > stdout.length) return;
    const sum = [0, 0, 0];
    for (let p = 0; p < SIDE * SIDE; p++) for (let c = 0; c < 3; c++) sum[c]! += stdout[i * size + p * 3 + c]!;
    color.set(f, `#${sum.map((s) => Math.round(s / (SIDE * SIDE)).toString(16).padStart(2, "0")).join("").toUpperCase()}`);
  });
  return times.map((t) => color.get(frameOf(t)));
}

/**
 * The cut map stored with a template: the project's cut (cutMapFromEdl) without project-bound thumbnails,
 * each shot labelled with its slot and coloured from the example. Undefined when the cut map can't be built;
 * the template's map then comes from its skeleton, which holds the same cut.
 */
export async function templateCutMap(ws: Workspace, shots: { start: number; end: number; slot?: string }[], example: string, fps: number): Promise<CutMapData | undefined> {
  let map: CutMapData | undefined;
  try {
    const { cutMapFromEdl } = await import("../app/cutmap.js");
    map = await cutMapFromEdl(ws);
  } catch {
    return undefined;
  }
  if (!map) return undefined;
  const colors = await meanColors(example, map.shots.map((s) => (s.start + s.end) / 2));
  return {
    ...map,
    // Thumbnails and labels name the project's assets, which the template doesn't carry.
    shots: map.shots.map(({ thumb: _thumb, state: _state, yours: _yours, label: _label, slot: lineSlot, ...s }, i) => {
      const slot = shots.find((x) => Math.abs(x.start - s.start) < 1 / fps)?.slot ?? lineSlot;
      const color = s.color ?? colors[i];
      return { ...s, ...(slot ? { slot } : {}), ...(color ? { color } : {}) };
    }),
  };
}
