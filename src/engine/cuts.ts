import { correlation, type FrameFeatures, histDistance, pixelDistance } from "./frames.js";
import { localMedian, round } from "./stats.js";

export type TransitionIn = "start" | "cut" | "flash" | "dissolve";

export interface Shot {
  index: number;
  /** First frame of the shot (inclusive). */
  startFrame: number;
  /** One past the last frame of the shot. */
  endFrame: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  frames: number;
  transitionIn: TransitionIn;
  /** Detector confidence for the boundary that opens this shot (0 for the first shot). */
  boundaryScore: number;
}

export interface FlashEvent {
  startFrame: number;
  endFrame: number;
  peakFrame: number;
  startSec: number;
  endSec: number;
  /** white/black: a luma flash; pulse: a tonal change (glow, exposure, grade) on the same picture. */
  kind: "white" | "black" | "pulse";
  /** Luma deviation from the surrounding frames at the peak, 0–1. */
  intensity: number;
  /** True when the content after the flash differs from before it (a cut hidden by the flash). */
  hidesCut: boolean;
}

export interface CutDetection {
  shots: Shot[];
  flashes: FlashEvent[];
  /** Per-frame boundary score (index 0 is always 0). */
  scores: number[];
}

export interface CutOptions {
  /** Absolute minimum score for a boundary. */
  minScore?: number;
  /** A boundary must exceed this multiple of the local median score. */
  localFactor?: number;
}

const FLASH_DELTA = 0.22;
const BLACK_LEVEL = 0.08;
const MAX_FLASH_FRAMES = 8;
const SAME_CONTENT = 0.3;
/** Above this correlation, two frames show the same picture even if tone and colour changed. */
const SAME_STRUCTURE = 0.88;
/** Below this correlation, the frames either side of a flash show different pictures. */
const HIDDEN_CUT_STRUCTURE = 0.55;

/** Time (seconds) of frame `i`; falls back to i/fps past the end of the PTS list. */
export function frameTime(pts: number[], fps: number, i: number): number {
  if (i < pts.length) return pts[i]! - (pts[0] ?? 0);
  const last = pts.length ? pts[pts.length - 1]! - (pts[0] ?? 0) : 0;
  return last + (i - pts.length + 1) / fps;
}

export function boundaryScores(f: FrameFeatures): number[] {
  const scores = [0];
  for (let i = 1; i < f.count; i++) {
    const h = histDistance(f.hist[i - 1]!, f.hist[i]!);
    const p = pixelDistance(f.gray[i - 1]!, f.gray[i]!);
    scores.push(0.55 * h + 0.45 * Math.min(1, p * 2.5));
  }
  return scores;
}

function detectFlashes(f: FrameFeatures, pts: number[], fps: number): FlashEvent[] {
  const events: FlashEvent[] = [];
  let i = 0;
  while (i < f.count) {
    const base = localMedian(f.luma, i, 6);
    const white = f.luma[i]! - base > FLASH_DELTA;
    const black = base - f.luma[i]! > FLASH_DELTA && f.luma[i]! < BLACK_LEVEL;
    if (!white && !black) {
      i++;
      continue;
    }
    const kind = white ? "white" : "black";
    let end = i;
    let peak = i;
    let peakDev = Math.abs(f.luma[i]! - base);
    while (end + 1 < f.count && end + 1 - i < MAX_FLASH_FRAMES) {
      const dev = f.luma[end + 1]! - base;
      const still = kind === "white" ? dev > FLASH_DELTA * 0.6 : -dev > FLASH_DELTA * 0.6 && f.luma[end + 1]! < BLACK_LEVEL * 1.5;
      if (!still) break;
      end++;
      if (Math.abs(dev) > peakDev) {
        peakDev = Math.abs(dev);
        peak = end;
      }
    }
    const before = Math.max(0, i - 1);
    const after = Math.min(f.count - 1, end + 1);
    // A cut hides under the flash when the picture after it is different: other colours, or the
    // same grade but another composition.
    const hidesCut =
      i > 0 &&
      end + 1 < f.count &&
      (histDistance(f.hist[before]!, f.hist[after]!) > SAME_CONTENT || correlation(f.gray[before]!, f.gray[after]!) < HIDDEN_CUT_STRUCTURE);
    events.push({
      startFrame: i,
      endFrame: end + 1,
      peakFrame: peak,
      startSec: round(frameTime(pts, fps, i)),
      endSec: round(frameTime(pts, fps, end + 1)),
      kind,
      intensity: round(peakDev),
      hidesCut,
    });
    i = end + 1;
  }
  return events;
}

/**
 * Detects hard cuts, flash-hidden cuts, dissolves and one-frame inserts.
 * Automated boundaries are a starting point: the agent verifies them against contact sheets.
 */
export function detectCuts(f: FrameFeatures, pts: number[], fps: number, opts: CutOptions = {}): CutDetection {
  const minScore = opts.minScore ?? 0.2;
  const localFactor = opts.localFactor ?? 2.5;
  const scores = boundaryScores(f);
  const flashes = detectFlashes(f, pts, fps);

  // Flash frames spike the boundary score; leave them out of the local level so the frames around
  // a flash keep a normal threshold.
  const level = [...scores];
  for (const fl of flashes) for (let i = fl.startFrame; i <= Math.min(f.count - 1, fl.endFrame); i++) level[i] = 0;
  const candidates = new Set<number>();
  for (let i = 1; i < f.count; i++) {
    const threshold = Math.max(minScore, localFactor * localMedian(level, i, 8) + 0.06);
    if (scores[i]! > threshold) candidates.add(i);
  }

  const transition = new Map<number, TransitionIn>();
  for (const flash of flashes) {
    for (let i = flash.startFrame; i <= flash.endFrame; i++) candidates.delete(i);
    if (flash.hidesCut && flash.endFrame < f.count) {
      candidates.add(flash.endFrame);
      transition.set(flash.endFrame, "flash");
    }
  }

  // Tonal pulses: the picture keeps its structure across the boundary, only tone or colour jumps.
  for (const i of [...candidates].sort((a, b) => a - b)) {
    if (correlation(f.gray[i - 1]!, f.gray[i]!) < SAME_STRUCTURE) continue;
    candidates.delete(i);
    flashes.push({
      startFrame: i,
      endFrame: i + 1,
      peakFrame: i,
      startSec: round(frameTime(pts, fps, i)),
      endSec: round(frameTime(pts, fps, i + 1)),
      kind: "pulse",
      intensity: round(scores[i]!),
      hidesCut: false,
    });
  }
  flashes.sort((a, b) => a.startFrame - b.startFrame);

  // Runs of consecutive boundaries: a dissolve when every step is moderate and the run
  // changes the picture overall; otherwise they are genuine rapid inserts and stay separate.
  const sorted = [...candidates].sort((a, b) => a - b);
  for (let k = 0; k < sorted.length; ) {
    let j = k;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const start = sorted[k]!;
    const end = sorted[j]!;
    if (j - k >= 2) {
      const moderate = sorted.slice(k, j + 1).every((i) => scores[i]! < 0.4);
      const overall = histDistance(f.hist[start - 1]!, f.hist[Math.min(f.count - 1, end)]!);
      if (moderate && overall > 0.35) {
        for (let i = start; i <= end; i++) candidates.delete(i);
        const mid = Math.round((start + end) / 2);
        candidates.add(mid);
        transition.set(mid, "dissolve");
      }
    }
    k = j + 1;
  }

  const boundaries = [0, ...[...candidates].filter((i) => i > 0).sort((a, b) => a - b)];
  const shots: Shot[] = boundaries.map((startFrame, index) => {
    const endFrame = boundaries[index + 1] ?? f.count;
    const startSec = frameTime(pts, fps, startFrame);
    const endSec = frameTime(pts, fps, endFrame);
    return {
      index,
      startFrame,
      endFrame,
      startSec: round(startSec),
      endSec: round(endSec),
      durationSec: round(endSec - startSec),
      frames: endFrame - startFrame,
      transitionIn: index === 0 ? "start" : (transition.get(startFrame) ?? "cut"),
      boundaryScore: index === 0 ? 0 : round(scores[startFrame] ?? 0),
    };
  });

  return { shots, flashes, scores: scores.map((s) => round(s)) };
}
