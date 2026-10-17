import type { AudioAnalysis } from "./audio.js";
import type { FlashEvent, Shot } from "./cuts.js";
import { frameTime } from "./cuts.js";
import type { MotionSample } from "./motion.js";
import { round } from "./stats.js";

export type EnergyEventType = "cut" | "flash" | "camera_move" | "shake" | "punch" | "hit";

export interface EnergyEvent {
  type: EnergyEventType;
  startSec: number;
  endSec: number;
  /** Event-specific intensity, normalized so that ~1 is strong. */
  intensity: number;
  /** Camera direction for camera_move (pan_left, tilt_up, zoom_in, roll_cw, …) and punch (in/out). */
  direction?: string;
  shotIndex?: number;
}

export interface EnergySecond {
  second: number;
  cuts: number;
  flashes: number;
  hits: number;
  beats: number;
  /** Mean camera speed in frame-widths per second. */
  cameraSpeed: number;
  /** RMS of high-frequency camera jitter, frame-widths per second. */
  shake: number;
}

export interface EnergyMap {
  durationSec: number;
  events: EnergyEvent[];
  seconds: EnergySecond[];
  summary: {
    cutsPerSecond: number;
    meanShotSec: number;
    flashesPerSecond: number;
    shakeSeconds: number;
    cameraMoveSeconds: number;
    hitsPerSecond: number;
    /** Share of cuts that land within 1.5 frames of a beat or strong onset. */
    cutsOnBeatShare: number;
  };
}

const PAN_SPEED = 0.08;
const ZOOM_SPEED = 0.05;
const ROLL_SPEED = 0.08;
const MIN_MOVE_SEC = 0.25;
const SHAKE_RMS = 0.35;
const PUNCH_ZOOM = 0.025;
const HIT_STRENGTH = 0.45;

interface Segment {
  start: number;
  end: number;
  peak: number;
}

function segments(values: number[], threshold: number, minLen: number): Segment[] {
  const out: Segment[] = [];
  let start = -1;
  let peak = 0;
  for (let i = 0; i <= values.length; i++) {
    const v = i < values.length ? values[i]! : 0;
    if (Math.abs(v) > threshold) {
      if (start < 0) {
        start = i;
        peak = 0;
      }
      peak = Math.max(peak, Math.abs(v));
    } else if (start >= 0) {
      if (i - start >= minLen) out.push({ start, end: i, peak });
      start = -1;
    }
  }
  return out;
}

function smoothWithin(values: number[], from: number, to: number, radius: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(from, i - radius); j <= Math.min(to - 1, i + radius); j++) {
      s += values[j]!;
      n++;
    }
    out.push(s / n);
  }
  return out;
}

export function buildEnergyMap(input: {
  shots: Shot[];
  flashes: FlashEvent[];
  motion: MotionSample[];
  pts: number[];
  fps: number;
  durationSec: number;
  audio?: AudioAnalysis;
}): EnergyMap {
  const { shots, flashes, motion, pts, fps, durationSec, audio } = input;
  const t = (i: number) => round(frameTime(pts, fps, i));
  const events: EnergyEvent[] = [];
  const jitter: number[] = new Array(motion.length).fill(0);
  const speed: number[] = new Array(motion.length).fill(0);

  for (const shot of shots.slice(1)) {
    events.push({ type: "cut", startSec: shot.startSec, endSec: shot.startSec, intensity: shot.boundaryScore, shotIndex: shot.index });
  }
  for (const f of flashes) {
    events.push({ type: "flash", startSec: f.startSec, endSec: f.endSec, intensity: f.intensity, direction: f.kind });
  }

  const minMove = Math.max(2, Math.round(MIN_MOVE_SEC * fps));
  const radius = Math.max(1, Math.round(0.12 * fps));
  for (const shot of shots) {
    const from = shot.startFrame + 1;
    const to = shot.endFrame;
    if (to - from < 2) continue;
    const pick = (k: keyof MotionSample) => motion.map((m) => (m.confidence > 0.2 ? (m[k] as number) : 0));
    const tx = smoothWithin(pick("tx"), from, to, radius);
    const ty = smoothWithin(pick("ty"), from, to, radius);
    const zoom = smoothWithin(pick("zoom"), from, to, radius);
    const rot = smoothWithin(pick("rot"), from, to, radius);
    const rawTx = pick("tx");
    const rawTy = pick("ty");
    for (let i = from; i < to; i++) {
      const k = i - from;
      jitter[i] = Math.hypot(rawTx[i]! - tx[k]!, rawTy[i]! - ty[k]!) * fps;
      speed[i] = Math.hypot(tx[k]!, ty[k]!) * fps;
    }
    // Content moving left means the camera pans right, and so on.
    const moves: [number[], number, (v: number) => string][] = [
      [tx.map((v) => v * fps), PAN_SPEED, (v) => (v < 0 ? "pan_right" : "pan_left")],
      [ty.map((v) => v * fps), PAN_SPEED, (v) => (v < 0 ? "tilt_down" : "tilt_up")],
      [zoom.map((v) => v * fps), ZOOM_SPEED, (v) => (v > 0 ? "zoom_in" : "zoom_out")],
      [rot.map((v) => v * fps), ROLL_SPEED, (v) => (v > 0 ? "roll_ccw" : "roll_cw")],
    ];
    for (const [series, threshold, name] of moves) {
      for (const seg of segments(series, threshold, minMove)) {
        const avg = series.slice(seg.start, seg.end).reduce((a, b) => a + b, 0) / (seg.end - seg.start);
        events.push({
          type: "camera_move",
          startSec: t(from + seg.start),
          endSec: t(from + seg.end),
          intensity: round(seg.peak / threshold / 4),
          direction: name(avg),
          shotIndex: shot.index,
        });
      }
    }
    // A punch is a one- or two-frame jump in scale, e.g. a zoom punch-in on a beat.
    const rawZoom = pick("zoom");
    for (let i = from; i < to; i++) {
      if (Math.abs(rawZoom[i]!) > PUNCH_ZOOM && Math.abs(rawZoom[i]!) > 3 * Math.abs(zoom[i - from]!)) {
        events.push({
          type: "punch",
          startSec: t(i),
          endSec: t(i + 1),
          intensity: round(Math.abs(rawZoom[i]!) / PUNCH_ZOOM / 4),
          direction: rawZoom[i]! > 0 ? "in" : "out",
          shotIndex: shot.index,
        });
      }
    }
  }

  // Shake: windowed RMS of jitter above a threshold.
  const win = Math.max(2, Math.round(0.25 * fps));
  const shakeRms = jitter.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - (win >> 1)); j < Math.min(jitter.length, i + (win >> 1) + 1); j++) {
      s += jitter[j]! ** 2;
      n++;
    }
    return Math.sqrt(s / n);
  });
  for (const seg of segments(shakeRms, SHAKE_RMS, Math.max(2, win >> 1))) {
    events.push({ type: "shake", startSec: t(seg.start), endSec: t(seg.end), intensity: round(seg.peak / SHAKE_RMS / 3) });
  }

  const hits = (audio?.onsets ?? []).filter((o) => o.strength >= HIT_STRENGTH);
  for (const h of hits) events.push({ type: "hit", startSec: h.timeSec, endSec: h.timeSec, intensity: h.strength });

  events.sort((a, b) => a.startSec - b.startSec || a.type.localeCompare(b.type));

  const nSec = Math.max(1, Math.ceil(durationSec - 1e-6));
  const seconds: EnergySecond[] = Array.from({ length: nSec }, (_, second) => ({
    second, cuts: 0, flashes: 0, hits: 0, beats: 0, cameraSpeed: 0, shake: 0,
  }));
  const bucket = (sec: number) => seconds[Math.min(nSec - 1, Math.max(0, Math.floor(sec)))]!;
  for (const e of events) {
    if (e.type === "cut") bucket(e.startSec).cuts++;
    if (e.type === "flash") bucket(e.startSec).flashes++;
    if (e.type === "hit") bucket(e.startSec).hits++;
  }
  for (const b of audio?.beats ?? []) bucket(b).beats++;
  const perSecond = (series: number[]) => {
    const acc = seconds.map(() => ({ s: 0, n: 0 }));
    series.forEach((v, i) => {
      const a = acc[Math.min(nSec - 1, Math.floor(frameTime(pts, fps, i)))]!;
      a.s += v;
      a.n++;
    });
    return acc.map((a) => (a.n ? round(a.s / a.n) : 0));
  };
  const sp = perSecond(speed);
  const sh = perSecond(shakeRms);
  seconds.forEach((s, i) => {
    s.cameraSpeed = sp[i]!;
    s.shake = sh[i]!;
  });

  const anchors = [...(audio?.beats ?? []), ...hits.map((h) => h.timeSec)].sort((a, b) => a - b);
  const cutTimes = shots.slice(1).map((s) => s.startSec);
  const tolerance = 1.5 / fps;
  const onBeat = cutTimes.filter((c) => anchors.some((a) => Math.abs(a - c) <= tolerance)).length;
  const span = (type: EnergyEventType) =>
    round(events.filter((e) => e.type === type).reduce((s, e) => s + (e.endSec - e.startSec), 0));

  return {
    durationSec: round(durationSec),
    events,
    seconds,
    summary: {
      cutsPerSecond: round(cutTimes.length / Math.max(durationSec, 1e-6)),
      meanShotSec: round(durationSec / Math.max(1, shots.length)),
      flashesPerSecond: round(flashes.length / Math.max(durationSec, 1e-6)),
      shakeSeconds: span("shake"),
      cameraMoveSeconds: span("camera_move"),
      hitsPerSecond: round(hits.length / Math.max(durationSec, 1e-6)),
      cutsOnBeatShare: cutTimes.length && anchors.length ? round(onBeat / cutTimes.length) : 0,
    },
  };
}
