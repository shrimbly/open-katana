import type { Breakdown } from "../engine/analyze.js";
import type { AudioAnalysis } from "../engine/audio.js";
import type { FlashEvent, Shot } from "../engine/cuts.js";
import type { EnergyEvent, EnergyMap } from "../engine/energy.js";
import type { Preset } from "../presets/library.js";
import type { Workspace } from "../project/workspace.js";
import { checkEdl, type Edl, EdlSchema, gridBeats, resolveTime, type Time, type TimeContext } from "../render/edl.js";
import { decodeDrop } from "./decode-copy.js";
import type { CutMapData, CutMapShot } from "./types.js";

// Cut maps: the barcode of an edit, from a template, a decoded video or a project's EDL (spec §11.3).

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const COLOR = /^(black|white|#[0-9a-fA-F]{6})$/;
const SOLID: Record<string, string> = { black: "#000000", white: "#FFFFFF" };
const solid = (c: string) => SOLID[c] ?? c;
/** Pulses (glow, exposure) read as the warm flash white rather than pure white. */
const FLASH_COLOR: Record<string, string> = { white: "#FFFFFF", black: "#000000", pulse: "#FFF6E6" };

/** "9:16" → 0.5625. */
function aspectOf(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  return w && h ? r4(w / h) : 0.5625;
}

const within = (beats: number[], durationSec: number) => beats.filter((b) => b >= 0 && b <= durationSec + 1e-6).map(r3);
const everyFourth = (beats: number[]) => beats.filter((_, i) => i % 4 === 0);

/** Shots, flashes and text of an EDL on its own timeline, with times snapped to frames as the renderer does. */
function edlLayers(edl: Edl, ctx: TimeContext): Pick<CutMapData, "durationSec" | "aspect" | "flashes" | "text"> & { shots: { shot: Edl["shots"][number]; start: number; end: number }[] } {
  const check = checkEdl(edl, ctx);
  const fps = edl.canvas.fps;
  const t = (x: Time) => r3(resolveTime(x, ctx));
  return {
    durationSec: r3(check.durationSec),
    aspect: r4(edl.canvas.width / edl.canvas.height),
    shots: check.shots.map((s) => ({ shot: s.shot, start: r3(s.startFrame / fps), end: r3((s.startFrame + s.frames) / fps) })),
    flashes: edl.flashes.map((f) => ({ t: t(f.at), durationSec: f.duration, color: solid(f.color) })),
    text: edl.text.map((x, index) => ({ index, start: t(x.start), end: t(x.end), text: x.text })),
  };
}

/** Recipe blocks of a freestyle template: "a–b%" of its length, or "a–b s"; anything else is skipped. */
export function recipeSketch(structure: Preset["recipe"]["structure"], durationSec: number): NonNullable<CutMapData["sketch"]> {
  const out: NonNullable<CutMapData["sketch"]> = [];
  for (const s of structure) {
    const m = s.at.match(/^\s*(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*(%|s\b)/);
    if (!m) continue;
    const scale = m[3] === "%" ? durationSec / 100 : 1;
    const start = r3(Number(m[1]) * scale);
    const end = r3(Math.min(durationSec, Number(m[2]) * scale));
    if (end > start) out.push({ start, end, label: s.role });
  }
  return out;
}

/**
 * A template's cut map. Shot-for-shot templates resolve their skeleton: beats from `grid` (a fitted
 * track), else the skeleton's grid, else the bundled cutmap.json, else a nominal grid
 * (`timing.nominalBpm` or 120 BPM, marked approximate). Slots come from "slot:<id>" sources and the
 * drop from `timing.dropBeat`. Freestyle templates get their recipe blocks as a sketch (on top of the
 * bundled example's real cut when there is one).
 */
export function cutMapFromPreset(p: Preset, opts: { grid?: { bpm: number; phase: number }; durationSec?: number; cutmapFile?: CutMapData } = {}): CutMapData {
  const parsed = p.skeleton ? EdlSchema.safeParse(p.skeleton) : undefined;
  if (!parsed?.success) {
    const durationSec = opts.durationSec ?? p.format.durationSec ?? opts.cutmapFile?.durationSec ?? 15;
    const sketch = recipeSketch(p.recipe.structure, durationSec);
    if (opts.cutmapFile) return { ...opts.cutmapFile, sketch };
    const beats = opts.grid ? within(gridBeats(opts.grid, durationSec), durationSec) : [];
    return { durationSec: r3(durationSec), aspect: aspectOf(p.format.aspect), shots: [], flashes: [], beats, downbeats: everyFourth(beats), text: [], sketch, approximate: !opts.grid };
  }
  const edl: Edl = { ...parsed.data, canvas: { ...parsed.data.canvas, ...(opts.durationSec ? { durationSec: opts.durationSec } : {}) } };
  const horizon = edl.canvas.durationSec ?? p.format.durationSec ?? 300;
  const grid = opts.grid ?? edl.grid;
  let approximate = false;
  let beats: number[];
  if (grid) beats = gridBeats(grid, horizon);
  else if (opts.cutmapFile?.beats.length) beats = opts.cutmapFile.beats;
  else {
    beats = gridBeats({ bpm: p.timing?.nominalBpm ?? 120, phase: 0 }, horizon);
    approximate = true;
  }
  const ctx = { fps: edl.canvas.fps, beats };
  const layers = edlLayers(edl, ctx);
  const shots: CutMapShot[] = layers.shots.map(({ shot, start, end }) => {
    const asset = shot.source.asset;
    if (asset.startsWith("slot:")) return { start, end, slot: asset.slice(5) };
    return COLOR.test(asset) ? { start, end, color: solid(asset) } : { start, end };
  });
  const inEdit = within(beats, layers.durationSec);
  const dropBeat = p.timing?.dropBeat;
  return {
    ...layers,
    shots,
    beats: inEdit,
    downbeats: everyFourth(inEdit),
    ...(dropBeat !== undefined ? { dropSec: r3(resolveTime(`b${dropBeat}`, ctx)) } : {}),
    ...(approximate ? { approximate } : {}),
  };
}

type CameraType = NonNullable<CutMapData["camera"]>[number]["type"];

function cameraType(e: EnergyEvent): CameraType | undefined {
  if (e.type === "punch") return "punch";
  if (e.type === "shake") return "shake";
  if (e.type !== "camera_move") return undefined;
  const d = e.direction ?? "";
  if (d === "zoom_in") return "zoom-in";
  if (d === "zoom_out") return "zoom-out";
  if (d.startsWith("pan")) return "pan";
  if (d.startsWith("tilt")) return "tilt";
  if (d.startsWith("roll")) return "roll";
  return undefined;
}

/**
 * Energy per second, 0..1: what the picture does (cuts, flashes, hits, camera speed, shake), blended
 * with the loudness of the sound when there is one.
 */
function energyCurve(energy: EnergyMap, audio: AudioAnalysis | undefined, offsetSec: number): number[] {
  const norm = (xs: number[]) => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : hi > 0 ? 1 : 0));
  };
  const picture = norm(energy.seconds.map((s) => s.cuts + s.flashes + 0.5 * s.hits + Math.min(2, 4 * s.cameraSpeed) + Math.min(2, 2 * s.shake)));
  if (!audio?.loudnessDb.length) return picture.map(r3);
  const loud = energy.seconds.map((s) => {
    const from = Math.max(0, Math.round((s.second - offsetSec) * 10));
    const slice = audio.loudnessDb.slice(from, from + 10);
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : -60;
  });
  const sound = norm(loud.map((db) => Math.max(-60, db)));
  return picture.map((v, i) => r3(0.6 * v + 0.4 * sound[i]!));
}

/** Detected shots (in their mean colour) and flashes as Cut Map cells; a flash lasts at least one frame. */
export function detectedLayers(a: { shots: Shot[]; flashes: FlashEvent[]; shotColors?: string[]; fps: number }): Pick<CutMapData, "shots" | "flashes"> {
  return {
    shots: a.shots.map((s, i) => ({ start: r3(s.startSec), end: r3(s.endSec), ...(a.shotColors?.[i] ? { color: a.shotColors[i] } : {}) })),
    flashes: a.flashes.map((fl) => ({ t: r3(fl.startSec), durationSec: r3(Math.max(fl.endSec - fl.startSec, 1 / Math.max(1, a.fps))), color: FLASH_COLOR[fl.kind] ?? "#FFFFFF" })),
  };
}

/** A decoded video's cut map: shots in their mean colour, flashes, beats, camera moves, energy and the drop. */
export function cutMapFromAnalysis(a: { breakdown: Breakdown; energy: EnergyMap; audio?: AudioAnalysis; shotColors?: string[] }): CutMapData {
  const { breakdown, energy, audio } = a;
  const f = breakdown.format;
  const offset = f.audioOffsetSec;
  const beats = within((audio?.beats ?? []).map((b) => b + offset), f.durationSec);
  const downbeats = within((audio?.downbeats ?? []).map((b) => b + offset), f.durationSec);
  const camera: NonNullable<CutMapData["camera"]> = [];
  for (const e of energy.events) {
    const type = cameraType(e);
    if (type) camera.push({ t: r3(e.startSec), end: r3(e.endSec), type, ...(e.direction ? { direction: e.direction } : {}) });
  }
  const drop = decodeDrop(breakdown, audio);
  return {
    durationSec: r3(f.durationSec),
    aspect: r4(f.aspect),
    ...detectedLayers({ shots: breakdown.shots, flashes: breakdown.flashes, shotColors: a.shotColors, fps: f.fpsValue }),
    beats,
    downbeats,
    text: [],
    camera,
    energy: energyCurve(energy, audio, offset),
    ...(drop !== undefined ? { dropSec: drop } : {}),
  };
}

/** Beats on the edit's timeline without analysing anything (the app reads, it never writes analysis files). */
async function knownBeats(ws: Workspace, edl: Edl): Promise<number[]> {
  if (edl.grid) return gridBeats(edl.grid, edl.canvas.durationSec ?? 300);
  const asset = edl.audio?.asset ?? "ref";
  const isRef = asset === "ref" || ws.project.assets.find((x) => x.id === asset)?.role === "reference";
  const audio = await ws.readJson<AudioAnalysis>(isRef ? "analysis/audio.json" : `analysis/audio-${asset}.json`).catch(() => undefined);
  const offset = edl.audio?.offset ?? 0;
  return (audio?.beats ?? []).map((b) => +(b - offset).toFixed(4)).filter((b) => b >= 0);
}

/**
 * The cut map of a project's saved edit (render/edl.json): its resolved shots with a mid-shot thumbnail
 * of each source, flashes, text and beats. Undefined when there is no edit or it can't be resolved yet.
 */
export async function cutMapFromEdl(ws: Workspace): Promise<CutMapData | undefined> {
  const edl = await ws.readJson("render/edl.json", EdlSchema).catch(() => undefined);
  if (!edl) return undefined;
  // Generation lines are named after the template's slots ("<slot>-key" for its keyframe).
  const slots = new Set(((await ws.readJson<{ slots?: { id: string }[] }>("plan/preset.json").catch(() => undefined))?.slots ?? []).map((x) => x.id));
  const slotOf = (line: string) => (slots.has(line) ? line : slots.has(line.replace(/-key$/, "")) ? line.replace(/-key$/, "") : line);
  try {
    const beats = await knownBeats(ws, edl);
    const ctx = { fps: edl.canvas.fps, beats };
    const layers = edlLayers(edl, ctx);
    const shots: CutMapShot[] = layers.shots.map(({ shot, start, end }) => {
      const id = shot.source.asset;
      if (COLOR.test(id)) return { start, end, color: solid(id) };
      const asset = id === "ref" ? ws.reference() : ws.project.assets.find((x) => x.id === id);
      if (!asset) return { start, end, label: id };
      const span = (end - start) * (shot.source.speed === 0 ? 0 : (shot.source.speed + (shot.source.speedTo ?? shot.source.speed)) / 2);
      const t = asset.kind === "video" ? Math.min(Math.max(0, (asset.durationSec ?? Infinity) - 0.05), shot.source.in + span / 2) : 0;
      return {
        start,
        end,
        label: asset.id,
        ...(asset.lineId ? { slot: slotOf(asset.lineId) } : {}),
        thumb: `/api/projects/${encodeURIComponent(ws.project.id)}/thumb?asset=${encodeURIComponent(id)}&t=${t.toFixed(2)}&h=120`,
      };
    });
    const inEdit = within(beats, layers.durationSec);
    return { ...layers, shots, beats: inEdit, downbeats: everyFourth(inEdit) };
  } catch {
    return undefined;
  }
}
