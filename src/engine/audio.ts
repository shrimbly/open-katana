import { run } from "../util/proc.js";
import { mean, round, std } from "./stats.js";

export const AUDIO_RATE = 22050;
const FRAME = 1024;
const HOP = 256;

export interface Onset {
  timeSec: number;
  /** Normalized onset strength, 0–1 (1 = strongest onset in the clip). */
  strength: number;
}

export interface AudioAnalysis {
  durationSec: number;
  sampleRate: number;
  /** Seconds per onset-envelope sample. */
  envelopeStepSec: number;
  onsets: Onset[];
  tempoBpm: number;
  /** Confidence of the tempo estimate, 0–1. */
  tempoConfidence: number;
  beats: number[];
  /** Every 4th beat starting at the strongest phase; a heuristic, not a measured meter. */
  downbeats: number[];
  /** RMS loudness per 0.1 s window, dBFS. */
  loudnessDb: number[];
  /** Fraction of the clip that is effectively silent. */
  silentFraction: number;
  /** Where the tempo came from: the audio alone, or the audio checked against the edit's own cuts. */
  tempoSource?: "audio" | "cuts";
  /** The audio-only estimate, when the cuts chose a different grid. */
  audioTempoBpm?: number;
  /** Share of the edit's cuts within 1.5 frames of a beat (half beats count). */
  cutsOnBeat?: number;
}

export interface TempoHints {
  /** Cut times of the edit this audio belongs to (seconds, on the audio's timeline). */
  cuts: number[];
  fps: number;
}

/** Share of cuts within `tol` of a beat or half beat. */
export function cutsOnGrid(cuts: number[], beats: number[], tol: number): number {
  if (!cuts.length || beats.length < 2) return 0;
  const grid = beats.flatMap((b, i) => (i + 1 < beats.length ? [b, (b + beats[i + 1]!) / 2] : [b]));
  let hits = 0;
  for (const c of cuts) {
    let lo = 0;
    let hi = grid.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (grid[mid]! < c) lo = mid;
      else hi = mid;
    }
    if (Math.min(Math.abs(grid[lo]! - c), Math.abs(grid[hi]! - c)) <= tol) hits++;
  }
  return hits / cuts.length;
}

/**
 * Picks the beat grid an edit was cut to. Autocorrelation often locks onto a related pulse (3:4 or
 * 4:3 of the real tempo, from hats or triplets), so candidates around the audio tempo and its
 * simple ratios are scored by how many of the edit's cuts land on them beyond chance.
 */
export function gridFromCuts(cuts: number[], audioBpm: number, fps: number): { bpm: number; phase: number; z: number; hitRate: number } | undefined {
  const usable = cuts.filter((c) => c > 0.05);
  if (usable.length < 6 || !audioBpm) return undefined;
  const tol = 1.5 / fps;
  const ratios = [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75];
  let best: { bpm: number; phase: number; z: number; hitRate: number } | undefined;
  for (const r of ratios) {
    const centre = audioBpm * r;
    if (centre < 60 || centre > 200) continue;
    for (let bpm = centre * 0.97; bpm <= centre * 1.03; bpm += 0.05) {
      // Cuts sit on beats or half beats: score against the half-beat grid.
      const P = 60 / bpm / 2;
      const p = Math.min(1, (2 * tol) / P);
      let bestHits = 0;
      let bestPhase = 0;
      for (const anchor of usable) {
        const phase = anchor % P;
        let hits = 0;
        for (const c of usable) {
          const d = (((c - phase) % P) + P) % P;
          if (Math.min(d, P - d) <= tol) hits++;
        }
        if (hits > bestHits) {
          bestHits = hits;
          bestPhase = phase;
        }
      }
      const n = usable.length;
      const z = (bestHits - n * p) / Math.sqrt(n * p * (1 - p) + 1e-9);
      if (!best || z > best.z) best = { bpm, phase: bestPhase, z, hitRate: bestHits / n };
    }
  }
  if (!best) return undefined;
  // Cuts on the half beats of B are the same as cuts on the beats of 2B, and cuts on the beats of B
  // are the half beats of B/2: among the tempos that explain the cuts equally, take the most
  // plausible one (closest to 120 BPM on a log scale, as the audio estimate does).
  const P = 60 / best.bpm;
  const onWhole = usable.filter((c) => {
    const d = (((c - best!.phase) % P) + P) % P;
    return Math.min(d, P - d) <= tol;
  }).length;
  const options = [best.bpm, best.bpm * 2];
  if (onWhole >= 0.95 * best.hitRate * usable.length) options.push(best.bpm / 2);
  const pick = options.filter((b) => b >= 60 && b <= 200).sort((a, b) => Math.abs(Math.log2(a / 120)) - Math.abs(Math.log2(b / 120)))[0] ?? best.bpm;
  return { ...best, bpm: round(pick, 2), phase: round(best.phase % (60 / pick), 4) };
}

export async function decodeMono(path: string, rate = AUDIO_RATE): Promise<Float32Array> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"]);
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4)).slice();
}

/** In-place iterative radix-2 complex FFT. `re` and `im` must have a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Spectral-flux onset envelope (log-magnitude, half-wave rectified), one value per hop. */
export function onsetEnvelope(samples: Float32Array): Float32Array {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const window = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const bins = FRAME / 2;
  let prev = new Float64Array(bins);
  const env = new Float32Array(frames);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[off + i]! * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(bins);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      const d = mag[k]! - prev[k]!;
      if (d > 0) flux += d;
    }
    env[f] = f === 0 ? 0 : flux;
    prev = mag;
  }
  // Remove slow trends so sustained loud sections do not swamp transients.
  const detrended = new Float32Array(frames);
  const r = 16;
  for (let i = 0; i < frames; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(frames - 1, i + r); j++) {
      s += env[j]!;
      n++;
    }
    detrended[i] = Math.max(0, env[i]! - s / n);
  }
  return detrended;
}

function pickOnsets(env: Float32Array, step: number): Onset[] {
  const max = env.reduce((m, v) => Math.max(m, v), 0) || 1;
  const out: Onset[] = [];
  const wait = Math.round(0.05 / step);
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    const lo = Math.max(0, i - 8);
    const hi = Math.min(env.length, i + 9);
    const local = env.subarray(lo, hi);
    const threshold = mean(local) + 1.2 * std(local);
    let isPeak = env[i]! >= threshold && env[i]! > 0.08 * max;
    for (let j = Math.max(0, i - 3); j <= Math.min(env.length - 1, i + 3) && isPeak; j++) {
      if (env[j]! > env[i]!) isPeak = false;
    }
    if (isPeak && i - last >= wait) {
      out.push({ timeSec: round(i * step), strength: round(env[i]! / max) });
      last = i;
    }
  }
  return out;
}

/** Tempo by onset autocorrelation with a log-normal prior around 120 BPM. */
export function estimateTempo(env: Float32Array, step: number): { bpm: number; confidence: number; periodSamples: number } {
  const minLag = Math.round(60 / 200 / step);
  const maxLag = Math.min(env.length - 1, Math.round(60 / 60 / step));
  const m = mean(env);
  let bestLag = 0;
  let best = -Infinity;
  let total = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = lag; i < env.length; i++) ac += (env[i]! - m) * (env[i - lag]! - m);
    ac /= env.length - lag;
    const bpm = 60 / (lag * step);
    const weighted = ac * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (weighted > 0) total += weighted;
    if (weighted > best) {
      best = weighted;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || best <= 0) return { bpm: 0, confidence: 0, periodSamples: 0 };
  return { bpm: round(60 / (bestLag * step), 1), confidence: round(Math.min(1, (best / total) * 8)), periodSamples: bestLag };
}

/** Dynamic-programming beat tracker (Ellis 2007). */
export function trackBeats(env: Float32Array, period: number, step: number, tightness = 100): number[] {
  if (!period || env.length < period * 2) return [];
  const sd = std(env) || 1;
  const norm = Float64Array.from(env, (v) => v / sd);
  const score = new Float64Array(norm.length);
  const backlink = new Int32Array(norm.length).fill(-1);
  for (let t = 0; t < norm.length; t++) {
    let best = 0;
    let arg = -1;
    for (let tau = t - Math.round(2 * period); tau <= t - Math.round(period / 2); tau++) {
      if (tau < 0) continue;
      const c = score[tau]! - tightness * Math.log((t - tau) / period) ** 2;
      if (c > best) {
        best = c;
        arg = tau;
      }
    }
    score[t] = norm[t]! + best;
    backlink[t] = arg;
  }
  // Start from the best-scoring frame in the final period.
  let t = norm.length - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, norm.length - period); i < norm.length; i++) {
    if (score[i]! > bestEnd) {
      bestEnd = score[i]!;
      t = i;
    }
  }
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(round(t * step));
    t = backlink[t]!;
  }
  return beats.reverse();
}

export function analyzeSamples(samples: Float32Array, rate = AUDIO_RATE, hints?: TempoHints): AudioAnalysis {
  const step = HOP / rate;
  const env = onsetEnvelope(samples);
  const tempo = estimateTempo(env, step);
  let beats = trackBeats(env, tempo.periodSamples, step);
  let tempoBpm = tempo.bpm;
  let tempoSource: AudioAnalysis["tempoSource"] = "audio";
  let audioTempoBpm: number | undefined;
  let cutsOnBeat: number | undefined;
  if (hints && hints.cuts.length) {
    const tol = 1.5 / hints.fps;
    cutsOnBeat = cutsOnGrid(hints.cuts, beats, tol);
    const grid = gridFromCuts(hints.cuts, tempo.bpm, hints.fps);
    // Switch only when the cuts clearly prefer another grid.
    if (grid && Math.abs(grid.bpm - tempo.bpm) / tempo.bpm > 0.04 && grid.hitRate > cutsOnBeat + 0.15) {
      const period = 60 / grid.bpm / step;
      const tracked = trackBeats(env, Math.round(period), step, 400);
      const rigid: number[] = [];
      for (let t = grid.phase; t < samples.length / rate; t += 60 / grid.bpm) rigid.push(round(t));
      const trackedHits = cutsOnGrid(hints.cuts, tracked, tol);
      const rigidHits = cutsOnGrid(hints.cuts, rigid, tol);
      beats = trackedHits >= rigidHits ? tracked : rigid;
      audioTempoBpm = tempo.bpm;
      tempoBpm = grid.bpm;
      tempoSource = "cuts";
      cutsOnBeat = Math.max(trackedHits, rigidHits);
    }
  }
  let downbeats: number[] = [];
  if (beats.length >= 8) {
    let bestPhase = 0;
    let bestEnergy = -1;
    for (let phase = 0; phase < 4; phase++) {
      let e = 0;
      for (let i = phase; i < beats.length; i += 4) e += env[Math.round(beats[i]! / step)] ?? 0;
      if (e > bestEnergy) {
        bestEnergy = e;
        bestPhase = phase;
      }
    }
    downbeats = beats.filter((_, i) => i % 4 === bestPhase % 4 && i >= bestPhase);
  }
  const win = Math.round(rate * 0.1);
  const loudnessDb: number[] = [];
  let silent = 0;
  for (let i = 0; i + win <= samples.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += samples[j]! ** 2;
    const db = 10 * Math.log10(s / win + 1e-12);
    loudnessDb.push(round(db, 1));
    if (db < -50) silent++;
  }
  return {
    durationSec: round(samples.length / rate),
    sampleRate: rate,
    envelopeStepSec: round(step, 6),
    onsets: pickOnsets(env, step),
    tempoBpm,
    tempoConfidence: tempo.confidence,
    beats,
    downbeats,
    loudnessDb,
    silentFraction: loudnessDb.length ? round(silent / loudnessDb.length) : 1,
    tempoSource,
    ...(audioTempoBpm !== undefined ? { audioTempoBpm } : {}),
    ...(cutsOnBeat !== undefined ? { cutsOnBeat: round(cutsOnBeat) } : {}),
  };
}

export async function analyzeAudio(path: string, hints?: TempoHints): Promise<AudioAnalysis> {
  return analyzeSamples(await decodeMono(path), AUDIO_RATE, hints);
}
