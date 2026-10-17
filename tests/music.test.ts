import { describe, expect, it } from "vitest";
import { fitTrack, loudnessRise } from "../src/app/music.js";
import { join } from "node:path";
import { AUDIO_RATE, analyzeAudio, analyzeSamples } from "../src/engine/audio.js";

/**
 * A click track: a short 1 kHz burst on every beat over a soft noise bed, `quiet` before `dropSec` and
 * full level after it (an 18 dB rise), so the beat tracker and the drop finder both have something real.
 */
function clickTrack(o: { bpm: number; durationSec: number; dropSec?: number; firstBeat?: number }): Float32Array {
  const n = Math.round(o.durationSec * AUDIO_RATE);
  const out = new Float32Array(n);
  const period = 60 / o.bpm;
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 30 - 1;
  };
  const level = (t: number) => (o.dropSec !== undefined && t < o.dropSec ? 0.1 : 0.8);
  for (let i = 0; i < n; i++) out[i] = 0.05 * noise() * level(i / AUDIO_RATE);
  for (let t = o.firstBeat ?? 0; t < o.durationSec; t += period) {
    const start = Math.round(t * AUDIO_RATE);
    for (let k = 0; k < 0.03 * AUDIO_RATE && start + k < n; k++) out[start + k]! += level(t) * Math.sin((2 * Math.PI * 1000 * k) / AUDIO_RATE) * Math.exp(-k / (0.006 * AUDIO_RATE));
  }
  return out;
}

const hype = { grid: { bpm: 144, phase: 0.5 }, dropBeat: 18, durationSec: 16.433 };

describe("fitTrack", () => {
  it("lines the track's drop up with the template's drop beat", () => {
    // Beats every 0.46875 s from 0, so 30 s is beat 64; the drop lands there.
    const track = analyzeSamples(clickTrack({ bpm: 128, durationSec: 60, dropSec: 30 }));
    const fit = fitTrack(track, hype, true);
    expect(fit.ok).toBe(true);
    expect(fit.bpm).toBeCloseTo(128, 0);
    expect(fit.aligned).toBe(true);
    expect(fit.dropSec!).toBeCloseTo(30, 1);
    // The template's beat 18 sits at 0.5 + 18 periods on the new grid; the track starts so its drop is there.
    const period = 60 / fit.bpm;
    expect(fit.offsetSec).toBeCloseTo(fit.dropSec! - (0.5 + 18 * period), 2);
    expect(fit.offsetSec).toBeCloseTo(21.06, 1);
    expect(fit.grid).toEqual({ bpm: fit.bpm, phase: 0.5 });
    expect(fit.note).toBe(`Your track: 128 BPM · drop found at 0:30. We'll start it at 0:${fit.offsetSec.toFixed(1)} so the drop hits the big moment.`);
  });

  it("retimes the edit's length to the track's tempo", () => {
    const track = analyzeSamples(clickTrack({ bpm: 128, durationSec: 60, dropSec: 30 }));
    const fit = fitTrack(track, hype, true);
    expect(fit.durationSec).toBeCloseTo(0.5 + ((16.433 - 0.5) * 144) / fit.bpm, 2);
    expect(fit.durationSec).toBeGreaterThan(18);
  });

  it("starts from the beginning when asked to, on a tracked beat near the template's first beat", () => {
    const track = analyzeSamples(clickTrack({ bpm: 128, durationSec: 60, dropSec: 30, firstBeat: 0.1 }));
    const fit = fitTrack(track, hype, false);
    expect(fit.aligned).toBe(false);
    expect(fit.offsetSec).toBe(0);
    // Tracked beats are 0.1, 0.569, …: the first one at or after half a period before 0.5.
    expect(fit.grid.phase).toBeCloseTo(0.569, 1);
    expect(fit.note).toBe("Your track: 128 BPM. The cut follows its beat from the start.");
  });

  it("falls back to the start when the drop comes too early to line up", () => {
    const track = analyzeSamples(clickTrack({ bpm: 128, durationSec: 40, dropSec: 3.75 }));
    const fit = fitTrack(track, hype, true);
    expect(fit.ok).toBe(true);
    expect(fit.aligned).toBe(false);
    expect(fit.offsetSec).toBe(0);
    expect(fit.note).toBe("Your track: 128 BPM. The cut follows its beat from the start. Its drop comes too early to line up.");
  });

  it("folds the track's tempo by halves or doubles toward the template's", () => {
    const track = analyzeSamples(clickTrack({ bpm: 128, durationSec: 40 }));
    const slow = fitTrack(track, { nominalBpm: 60, durationSec: 11 }, true);
    expect(slow.bpm).toBeCloseTo(64, 0);
    const same = fitTrack(track, { grid: { bpm: 94.8, phase: 0.046 }, durationSec: 27.4 }, true);
    expect(same.bpm).toBeCloseTo(128, 0);
    expect(fitTrack(track, { nominalBpm: 240, durationSec: 11 }, true).bpm).toBeCloseTo(256, 0);
  });

  it("keeps the template's timing when the track has no steady beat", () => {
    const track = analyzeSamples(clickTrack({ bpm: 128, durationSec: 40, dropSec: 30 }));
    const unsure = fitTrack({ ...track, tempoConfidence: 0.2 }, hype, true);
    expect(unsure).toMatchObject({ ok: false, aligned: false, offsetSec: 0, grid: hype.grid, durationSec: 16.433 });
    expect(unsure.note).toBe("We couldn't find a steady beat in this track. The cut keeps the template's timing.");
    // Too short for eight beats, and silence: the template's (or a nominal) grid stays.
    expect(fitTrack(analyzeSamples(clickTrack({ bpm: 128, durationSec: 3 })), hype, true).ok).toBe(false);
    const silent = fitTrack(analyzeSamples(new Float32Array(10 * AUDIO_RATE)), { nominalBpm: 120, durationSec: 11 }, true);
    expect(silent).toMatchObject({ ok: false, grid: { bpm: 120, phase: 0 } });
    // Noise has no beat, even when one lag of its envelope stands out by chance.
    let seed = 11;
    const noise = Float32Array.from({ length: 20 * AUDIO_RATE }, () => {
      // mulberry32: a long-period generator in 32-bit integer maths.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1) * 0.5;
    });
    const hiss = analyzeSamples(noise);
    expect(hiss.tempoConfidence).toBeLessThan(0.25);
    expect(fitTrack(hiss, hype, true).ok).toBe(false);
  });

  it("says when the track ends before the edit does", () => {
    const track = analyzeSamples(clickTrack({ bpm: 128, durationSec: 34, dropSec: 30 }));
    const fit = fitTrack(track, hype, true);
    expect(fit.aligned).toBe(true);
    expect(fit.note).toMatch(/Your track ends before the edit does\.$/);
  });
});

describe("loudnessRise", () => {
  it("finds the largest one-second rise of at least the threshold", () => {
    const db = [...Array(30).fill(-40), ...Array(30).fill(-30), ...Array(30).fill(-12)];
    expect(loudnessRise(db, 6)).toEqual({ timeSec: 6, riseDb: 18 });
    expect(loudnessRise(db, 20)).toBeUndefined();
  });
});

describe("drops and tempos the person's track gets wrong no more", () => {
  it("never reads a file's leading silence as a drop", () => {
    // One silent window (encoder priming) before a flat track: the old mean of raw dB saw a 10 dB "drop" at 1.0 s.
    const flat = [-120, ...Array(99).fill(-20)];
    expect(loudnessRise(flat, 6)).toBeUndefined();
    // A quarter second of silence before a real drop at 8 s still finds the real one.
    const db = [...Array(3).fill(-120), ...Array(77).fill(-24), ...Array(40).fill(-14)];
    expect(loudnessRise(db, 6)?.timeSec).toBeCloseTo(8, 1);
    const track = analyzeSamples(Float32Array.from([...new Float32Array(Math.round(0.1 * AUDIO_RATE)), ...clickTrack({ bpm: 128, durationSec: 40 })]));
    const fit = fitTrack(track, hype, true);
    expect(fit.dropSec).toBeUndefined();
    expect(fit.note).not.toContain("too early");
  });

  it("a freestyle template keeps its length whatever the track's tempo", () => {
    for (const bpm of [84, 86, 160, 170]) {
      const track = analyzeSamples(clickTrack({ bpm, durationSec: 30 }));
      const fit = fitTrack(track, { durationSec: 12 }, true);
      expect(fit.durationSec, `${bpm} BPM`).toBe(12);
      expect(fit.offsetSec).toBe(0);
      expect(fit.note).not.toContain("ends before");
    }
    // Folded toward the template's own tempo when it has one.
    expect(fitTrack(analyzeSamples(clickTrack({ bpm: 84, durationSec: 30 })), { nominalBpm: 160, durationSec: 12 }, true).bpm).toBeCloseTo(168, 0);
  });

  it("hype-energy's drop lands where its own track's drop does, on the person's beat", async () => {
    // The template's track used as "my track": its drop (8.21 s) is beat 18.5 of the skeleton's grid, so it
    // plays exactly as with the template track, a hair early tempo or not.
    const track = await analyzeAudio(join(process.cwd(), "presets", "hype-energy", "soundtrack.m4a"));
    const fit = fitTrack(track, { grid: { bpm: 144, phase: 0.5 }, dropBeat: 18.5, durationSec: 16.433 }, true);
    expect(fit.aligned).toBe(true);
    expect(fit.offsetSec).toBeLessThan(0.05);
    expect(fit.grid.phase + 18.5 * (60 / fit.bpm) + fit.offsetSec).toBeCloseTo(fit.dropSec!, 2);
    expect(Math.abs(fit.dropSec! - 8.21)).toBeLessThan(0.05);
  });
});

