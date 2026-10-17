import type { AudioAnalysis } from "../engine/audio.js";
import { median, round } from "../engine/stats.js";
import type { TrackFit } from "./types.js";

/** Loudness windows per second in `AudioAnalysis.loudnessDb`. */
const WINDOWS_PER_SEC = 10;

/** Windows quieter than this count as silence: digital silence reads -120 dB, which would swamp a mean. */
const FLOOR_DB = -60;

/**
 * The largest one-second loudness rise in a track: mean of the next second minus mean of the one
 * before, over the 0.1 s loudness windows (each floored at -60 dB). The scan starts a second after the
 * sound does, so the silence a file starts with (encoder priming, a short gap) is never a "drop".
 * Returns the time (seconds, on the track's clock) and the rise in dB, or undefined when no rise
 * reaches `minDb`.
 */
export function loudnessRise(loudnessDb: number[], minDb: number): { timeSec: number; riseDb: number } | undefined {
  const w = WINDOWS_PER_SEC;
  const db = loudnessDb.map((v) => Math.max(FLOOR_DB, v));
  const firstSound = db.findIndex((v) => v > FLOOR_DB + 10);
  if (firstSound < 0) return undefined;
  let best: { timeSec: number; riseDb: number } | undefined;
  for (let i = Math.max(w, firstSound + w); i + w <= db.length; i++) {
    let before = 0;
    let after = 0;
    for (let k = 0; k < w; k++) {
      before += db[i - w + k]!;
      after += db[i + k]!;
    }
    const rise = (after - before) / w;
    if (rise >= minDb && (!best || rise > best.riseDb)) best = { timeSec: round(i / w, 3), riseDb: round(rise, 1) };
  }
  return best;
}

/** "0:47" for 47.3 s (to the nearest second). */
export function clockSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "0:38.9" for 38.94 s. */
export function clockTenths(sec: number): string {
  const tenths = Math.max(0, Math.round(sec * 10));
  const s = Math.floor(tenths / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${tenths % 10}`;
}

/**
 * The track's tempo from its tracked beats: a least-squares line through beat time against beat
 * number, numbering each gap by how many median gaps it spans (so a missed beat counts twice). Finer
 * than the tracker's hop size or the autocorrelation lag, which is its fallback.
 */
function trackTempo(track: AudioAnalysis): number {
  const beats = track.beats;
  if (beats.length < 4) return track.tempoBpm;
  const gap = median(beats.slice(1).map((b, i) => b - beats[i]!));
  if (!(gap > 0)) return track.tempoBpm;
  const index = [0];
  for (let i = 1; i < beats.length; i++) index.push(index[i - 1]! + Math.max(1, Math.round((beats[i]! - beats[i - 1]!) / gap)));
  const n = beats.length;
  const mx = index.reduce((a, b) => a + b, 0) / n;
  const my = beats.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (index[i]! - mx) * (beats[i]! - my);
    sxx += (index[i]! - mx) ** 2;
  }
  const period = sxx ? sxy / sxx : 0;
  return period > 0 ? 60 / period : track.tempoBpm;
}

/** Folds a tempo by ×2 or ×½ to the value closest to `target` on a log scale. */
function foldTempo(bpm: number, target: number): number {
  let best = bpm;
  for (const k of [0.25, 0.5, 1, 2, 4]) {
    const c = bpm * k;
    if (Math.abs(Math.log2(c / target)) < Math.abs(Math.log2(best / target))) best = c;
  }
  return best;
}

const nearest = (values: number[], t: number) => values.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), values[0] ?? t);

/**
 * Fits the person's track to a template's grid, lining its drop up with the big moment (spec §11.4).
 * `t.durationSec` is the template's length on its own grid; the result's `durationSec` is the edit's
 * length after retiming to the track's tempo. A template without a grid (freestyle) has no beats to
 * retime: its length stays, and the grid is the track's own beat (its tempo folded toward `nominalBpm`
 * when there is one).
 */
export function fitTrack(
  track: AudioAnalysis,
  t: { grid?: { bpm: number; phase: number }; nominalBpm?: number; dropBeat?: number; durationSec: number },
  alignDrop: boolean,
): TrackFit {
  const bpmT = t.grid?.bpm ?? t.nominalBpm ?? 120;
  const phaseT = t.grid?.phase ?? 0;
  if (track.tempoConfidence < 0.25 || track.beats.length < 8) {
    const grid = t.grid ?? { bpm: bpmT, phase: 0 };
    return {
      ok: false,
      bpm: grid.bpm,
      aligned: false,
      offsetSec: 0,
      durationSec: round(t.durationSec),
      grid,
      note: "We couldn't find a steady beat in this track. The cut keeps the template's timing.",
    };
  }
  const freestyle = !t.grid;
  const tempo = trackTempo(track);
  const bpm = round(freestyle && !t.nominalBpm ? tempo : foldTempo(tempo, bpmT), 2);
  const period = 60 / bpm;

  const rise = loudnessRise(track.loudnessDb, 6);
  const drop = rise ? nearest(track.beats, rise.timeSec) : undefined;

  if (freestyle) {
    // No skeleton to retime: the edit keeps the template's length and follows the track's own beat.
    const grid = { bpm, phase: round(track.beats[0] ?? 0, 4) };
    let note = `Your track: ${Math.round(bpm)} BPM${drop !== undefined ? ` · drop found at ${clockSec(drop)}` : ""}. The cut follows its beat from the start.`;
    if (t.durationSec > track.durationSec + 0.05) note += " Your track ends before the edit does.";
    return { ok: true, bpm, aligned: false, offsetSec: 0, ...(drop !== undefined ? { dropSec: round(drop) } : {}), durationSec: round(t.durationSec), grid, note };
  }

  let offset = 0;
  let grid: { bpm: number; phase: number } | undefined;
  let aligned = false;
  const lineUp = alignDrop && drop !== undefined && t.dropBeat !== undefined;
  if (lineUp) {
    const o = drop - (phaseT + t.dropBeat! * period);
    if (o >= 0) {
      offset = o;
      grid = { bpm, phase: phaseT };
      aligned = true;
    } else if (o >= -period / 2 && phaseT + o >= 0) {
      // A drop a fraction of a beat too early for the track to start before 0 (a tempo a hair faster than
      // the template's): the grid starts that much earlier instead, so the drop still lands on its beat.
      grid = { bpm, phase: round(phaseT + o, 4) };
      aligned = true;
    }
  }
  if (!grid) {
    // Beat 0 on a tracked beat near the template's own first beat, so shots timed before it keep their room.
    const first = track.beats.find((b) => b >= phaseT - period / 2) ?? track.beats[0]!;
    grid = { bpm, phase: round(first, 4) };
  }
  const durationSec = round(grid.phase + ((t.durationSec - phaseT) * bpmT) / bpm);
  const shown = Math.round(bpm);
  let note = aligned
    ? `Your track: ${shown} BPM · drop found at ${clockSec(drop!)}. We'll start it at ${clockTenths(offset)} so the drop hits the big moment.`
    : `Your track: ${shown} BPM. The cut follows its beat from the start.${lineUp ? " Its drop comes too early to line up." : ""}`;
  if (offset + durationSec > track.durationSec + 0.05) note += " Your track ends before the edit does.";
  return {
    ok: true,
    bpm,
    aligned,
    offsetSec: round(offset),
    ...(drop !== undefined ? { dropSec: round(drop) } : {}),
    durationSec,
    grid,
    note,
  };
}
