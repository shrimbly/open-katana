import type { Edl, ShotT, TextT } from "./api.js";
import { type Time, toSec } from "./time.js";

/** Pure edit operations on an EDL draft, shared by the timeline, the inspector and keyboard shortcuts. */

export interface Ctx {
  fps: number;
  beats: number[];
}

export const sec = (t: Time, c: Ctx) => toSec(t, c.fps, c.beats);
const frameOf = (s: number, c: Ctx) => Math.round(s * c.fps);

export function editDuration(edl: Edl, c: Ctx): number {
  return edl.canvas.durationSec ?? Math.max(0, ...edl.shots.map((s) => sec(s.end, c)));
}

/** The shot visible at time t (when shots overlap, the later-starting one wins, as in the renderer). */
export function shotAt(edl: Edl, t: number, c: Ctx): number {
  let best = -1;
  let bestStart = -1;
  edl.shots.forEach((s, i) => {
    const a = sec(s.start, c);
    if (a <= t + 1e-6 && t < sec(s.end, c) - 1e-6 && a >= bestStart) {
      best = i;
      bestStart = a;
    }
  });
  return best;
}

/** Sorted, de-duplicated cut times (every shot start and end). */
export function cutTimes(edl: Edl, c: Ctx): number[] {
  const set = new Set<number>();
  for (const s of edl.shots) {
    set.add(+sec(s.start, c).toFixed(4));
    set.add(+sec(s.end, c).toFixed(4));
  }
  return [...set].sort((a, b) => a - b);
}

/** Source seconds consumed after `tau` timeline seconds into a shot, following its speed ramp. */
export function sourceAdvance(shot: ShotT, tau: number, durSec: number): number {
  const v0 = shot.source.speed;
  const v1 = shot.source.speedTo ?? v0;
  return v0 * tau + ((v1 - v0) * tau * tau) / (2 * Math.max(durSec, 1e-6));
}

/**
 * Moves one edge of a shot. A neighbour sharing that edge moves with it (a roll edit), and content
 * stays anchored to the timeline: moving a start edge shifts that shot's source in-point. Moves
 * past a limit (a shot can't drop below one frame) stop at the limit. Returns false if nothing moved.
 */
export function moveShotEdge(edl: Edl, index: number, edge: "start" | "end", value: Time, c: Ctx): boolean {
  const shot = edl.shots[index];
  if (!shot) return false;
  const oldSec = sec(edge === "start" ? shot.start : shot.end, c);
  const oldFrame = frameOf(oldSec, c);
  const neighbour = edl.shots.findIndex((s, i) => i !== index && frameOf(sec(edge === "start" ? s.end : s.start, c), c) === oldFrame);
  const other = neighbour >= 0 ? edl.shots[neighbour]! : undefined;
  const [lo, hi] =
    edge === "start"
      ? [other ? frameOf(sec(other.start, c), c) + 1 : 0, frameOf(sec(shot.end, c), c) - 1]
      : [frameOf(sec(shot.start, c), c) + 1, other ? frameOf(sec(other.end, c), c) - 1 : Number.POSITIVE_INFINITY];
  if (lo > hi) return false;
  let newFrame = frameOf(sec(value, c), c);
  if (newFrame < lo || newFrame > hi) {
    newFrame = Math.min(hi, Math.max(lo, newFrame));
    value = +(newFrame / c.fps).toFixed(4);
  }
  if (newFrame === oldFrame) return false;
  const newSec = sec(value, c);
  const anchor = (s: ShotT) => (s.source.in = Math.max(0, +(s.source.in + (newSec - oldSec) * s.source.speed).toFixed(4)));
  if (edge === "start") {
    anchor(shot);
    shot.start = value;
    if (other) other.end = value;
  } else {
    shot.end = value;
    if (other) {
      anchor(other);
      other.start = value;
    }
  }
  return true;
}

function easeAt(kind: string | undefined, u: number): number {
  switch (kind) {
    case "linear":
      return u;
    case "in":
      return u * u;
    case "inout":
      return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
    default:
      return 1 - (1 - u) * (1 - u);
  }
}

/** Splits a shot at a time; the second half continues the source where the first stops. */
export function splitShot(edl: Edl, index: number, value: Time, c: Ctx): number | null {
  const shot = edl.shots[index];
  if (!shot) return null;
  const a = sec(shot.start, c);
  const b = sec(shot.end, c);
  const at = sec(value, c);
  if (frameOf(at, c) <= frameOf(a, c) || frameOf(at, c) >= frameOf(b, c)) return null;
  const dur = b - a;
  const f = (at - a) / dur;
  const first = structuredClone(shot);
  const second = structuredClone(shot);
  first.end = value;
  second.start = value;
  second.id = shot.id ? `${shot.id}-b` : undefined;
  if (!shot.source.reverse) second.source.in = +(shot.source.in + sourceAdvance(shot, at - a, dur)).toFixed(4);
  if (shot.source.speedTo !== undefined) {
    const mid = +(shot.source.speed + (shot.source.speedTo - shot.source.speed) * f).toFixed(3);
    first.source.speedTo = Math.max(0.05, mid);
    second.source.speed = mid;
  }
  const cam = shot.camera;
  if (cam) {
    const e = easeAt(cam.ease, f);
    const splitPair = <P extends number | [number, number]>(p: P): [P, P] => {
      if (!Array.isArray(p)) return [p, p];
      const m = +(p[0] + (p[1] - p[0]) * e).toFixed(4);
      return [[p[0], m] as P, [m, p[1]] as P];
    };
    if (cam.zoom !== undefined) [first.camera!.zoom, second.camera!.zoom] = splitPair(cam.zoom);
    if (cam.roll !== undefined) [first.camera!.roll, second.camera!.roll] = splitPair(cam.roll);
    if (cam.pan) {
      first.camera!.pan = [+(cam.pan[0] * e).toFixed(4), +(cam.pan[1] * e).toFixed(4)];
      second.camera!.pan = [+(cam.pan[0] * (1 - e)).toFixed(4), +(cam.pan[1] * (1 - e)).toFixed(4)];
    }
  }
  if (shot.fx) {
    delete first.fx!.flashOut;
    delete first.fx!.dipOut;
    delete second.fx!.flashIn;
    delete second.fx!.dipIn;
  }
  edl.shots.splice(index, 1, first, second);
  return index + 1;
}

const STYLE_KEYS = ["font", "size", "weight", "opacity", "color", "outline", "shadow", "glow", "align", "tracking", "anim", "exit", "uppercase", "italic"] as const;

/** Copies the typographic style of one text layer to every other one. */
export function applyStyleToAll(edl: Edl, from: number): void {
  const src = edl.text[from];
  if (!src) return;
  for (const t of edl.text) {
    if (t === src) continue;
    for (const k of STYLE_KEYS) {
      const v = structuredClone(src[k]);
      if (v === undefined) delete (t as Record<string, unknown>)[k];
      else (t as Record<string, unknown>)[k] = v;
    }
  }
}

/** Adds a text layer at a time, styled like the nearest earlier layer so new words match the edit. */
export function addText(edl: Edl, value: Time, c: Ctx): number {
  const at = sec(value, c);
  const before = edl.text.filter((t) => sec(t.start, c) <= at).sort((x, y) => sec(y.start, c) - sec(x.start, c))[0] ?? edl.text[0];
  const end: Time = typeof value === "string" && value.startsWith("b") ? `b${+(Number(value.slice(1)) + 2).toFixed(2)}` : +(at + 1).toFixed(4);
  const base: TextT = before
    ? { ...structuredClone(before), text: "NEW TEXT", start: value, end, behind: false }
    : { text: "NEW TEXT", start: value, end, font: "Anton", size: 0.1, opacity: 1, color: "#FFFFFF", position: "center", align: "center", tracking: 0, anim: "pop", exit: "none", uppercase: false, italic: false, behind: false };
  edl.text.push(base);
  edl.text.sort((x, y) => sec(x.start, c) - sec(y.start, c));
  return edl.text.indexOf(base);
}

export function addFlash(edl: Edl, value: Time, c: Ctx): number {
  const flash = { at: value, duration: 0.08, color: "white" as string, intensity: 1, overText: false };
  edl.flashes.push(flash);
  edl.flashes.sort((x, y) => sec(x.at, c) - sec(y.at, c));
  return edl.flashes.indexOf(flash);
}

export function addSfx(edl: Edl, value: Time, sound: string, c: Ctx): number {
  const cue = { at: value, sound, gainDb: -6 };
  edl.sfx.push(cue);
  edl.sfx.sort((x, y) => sec(x.at, c) - sec(y.at, c));
  return edl.sfx.indexOf(cue);
}

/** Sets an optional property, removing it when the value equals its neutral default. */
export function setOpt<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined, neutral?: T[K]): void {
  if (value === undefined || value === neutral || (typeof value === "number" && Number.isNaN(value))) delete obj[key];
  else obj[key] = value;
}

/** Stacks overlapping intervals into rows; returns the row of each item. */
export function stackRows(items: { a: number; b: number }[]): { rows: number[]; count: number } {
  const ends: number[] = [];
  const order = items.map((it, i) => ({ ...it, i })).sort((x, y) => x.a - y.a);
  const rows = new Array<number>(items.length).fill(0);
  for (const it of order) {
    let r = ends.findIndex((e) => e <= it.a + 1e-6);
    if (r < 0) {
      r = ends.length;
      ends.push(it.b);
    } else ends[r] = it.b;
    rows[it.i] = r;
  }
  return { rows, count: Math.max(1, ends.length) };
}
