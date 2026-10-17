import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeReference, type ReferenceAnalysis } from "../src/engine/analyze.js";
import { detectCuts } from "../src/engine/cuts.js";
import { type FrameFeatures, HIST_BINS } from "../src/engine/frames.js";
import { chooseGrid } from "../src/engine/sheets.js";
import { makeReferenceEdit, tempDir, TRUTH } from "./helpers/synth.js";

describe("reference analysis on a synthetic edit", () => {
  let result: ReferenceAnalysis;
  let dir: string;

  beforeAll(async () => {
    dir = await tempDir();
    const ref = await makeReferenceEdit(dir);
    result = await analyzeReference(ref, join(dir, "analysis"), { seed: "test" });
  }, 120_000);

  it("measures the source format", () => {
    const f = result.breakdown.format;
    expect(f.width).toBe(640);
    expect(f.height).toBe(360);
    expect(f.fpsValue).toBeCloseTo(24, 1);
    expect(f.frameCount).toBe(TRUTH.frameCount);
    expect(f.hasAudio).toBe(true);
  });

  it("finds every cut, including the one-frame insert", () => {
    const starts = result.breakdown.shots.slice(1).map((s) => s.startFrame);
    expect(starts).toEqual(TRUTH.cutFrames);
    const insert = result.breakdown.shots.find((s) => s.startFrame === 36);
    expect(insert?.frames).toBe(1);
  });

  it("reports the white flash without treating it as a cut", () => {
    const flash = result.breakdown.flashes.find((f) => f.kind === "white");
    expect(flash).toBeDefined();
    expect(flash!.startFrame).toBe(TRUTH.flashFrames[0]);
    expect(flash!.endFrame).toBe(TRUTH.flashFrames[1]! + 1);
    expect(flash!.hidesCut).toBe(false);
  });

  it("detects the camera pan direction in the first shot", () => {
    const pans = result.energy.events.filter((e) => e.type === "camera_move" && e.shotIndex === TRUTH.panShot);
    expect(pans.map((p) => p.direction)).toContain("pan_right");
  });

  it("detects shake in the last shot and not in the static shots", () => {
    const shakes = result.energy.events.filter((e) => e.type === "shake");
    const last = result.breakdown.shots[TRUTH.shakeShot]!;
    expect(shakes.some((s) => s.endSec > last.startSec && s.startSec < last.endSec)).toBe(true);
    const bars = result.breakdown.shots[1]!;
    expect(shakes.some((s) => s.startSec >= bars.startSec && s.endSec <= bars.endSec)).toBe(false);
  });

  it("recovers the 120 BPM click grid", () => {
    const audio = result.audio!;
    expect(audio.tempoBpm).toBeGreaterThan(115);
    expect(audio.tempoBpm).toBeLessThan(125);
    const gaps = audio.beats.slice(1).map((b, i) => b - audio.beats[i]!);
    for (const g of gaps) expect(Math.abs(g - TRUTH.beatPeriodSec)).toBeLessThan(0.04);
    expect(audio.onsets.length).toBeGreaterThanOrEqual(6);
  });

  it("writes one stamped contact-sheet page per second plus an overview", () => {
    expect(result.pages.length).toBe(Math.ceil(TRUTH.frameCount / 24));
    expect(result.pages[0]!.startFrame).toBe(0);
    expect(result.pages.at(-1)!.endFrame).toBe(TRUTH.frameCount);
    for (const p of result.pages) {
      expect(existsSync(p.path)).toBe(true);
      expect(p.code).toMatch(/^[A-Z2-9]{4}$/);
    }
    expect(existsSync(result.overviewPath)).toBe(true);
  });
});

describe("contact sheet grid", () => {
  it("keeps pages near 3:2 for landscape and portrait sources", () => {
    const land = chooseGrid(24, 16 / 9);
    const port = chooseGrid(24, 9 / 16);
    expect(land.cols * land.rows).toBeGreaterThanOrEqual(24);
    expect(port.cols * port.rows).toBeGreaterThanOrEqual(24);
    expect(port.cols).toBeGreaterThan(land.cols);
  });
});

describe("flashes over flat frames", () => {
  /** Synthetic features: one flat grey level per frame. */
  const flat = (levels: number[]): FrameFeatures => {
    const w = 16;
    const h = 16;
    const bin = (v: number) => Math.min(HIST_BINS - 1, Math.floor((v / 256) * HIST_BINS));
    return {
      width: w,
      height: h,
      count: levels.length,
      gray: levels.map((v) => new Uint8Array(w * h).fill(v)),
      luma: Float32Array.from(levels.map((v) => v / 255)),
      saturation: new Float32Array(levels.length),
      hist: levels.map((v) => {
        const hist = new Float32Array(HIST_BINS ** 3);
        hist[(bin(v) * HIST_BINS + bin(v)) * HIST_BINS + bin(v)] = 1;
        return hist;
      }),
      meanRgb: Float32Array.from(levels.flatMap((v) => [v, v, v])),
    };
  };
  const run = (levels: number[]) => detectCuts(flat(levels), levels.map((_, i) => i / 24), 24);

  it("doesn't call a flash on a solid colour a hidden cut", () => {
    const levels = [...Array(12).fill(70), 250, 250, ...Array(12).fill(70)];
    const r = run(levels);
    expect(r.flashes.filter((f) => f.kind === "white")).toHaveLength(1);
    expect(r.flashes[0]!.hidesCut).toBe(false);
    expect(r.shots).toHaveLength(1);
  });

  it("still finds a cut hidden by a flash between two different solid colours", () => {
    const levels = [...Array(12).fill(40), 250, 250, ...Array(12).fill(130)];
    const r = run(levels);
    expect(r.flashes.find((f) => f.kind === "white")?.hidesCut).toBe(true);
    expect(r.shots).toHaveLength(2);
  });
});

describe("cuts and flashes on the bundled examples (the edits' own cut maps are the truth)", () => {
  const detect = async (slug: string) => {
    const { readFileSync } = await import("node:fs");
    const { extractFeatures } = await import("../src/engine/frames.js");
    const { framePts, probe, rationalValue } = await import("../src/engine/probe.js");
    const input = join(process.cwd(), "presets", slug, "example.mp4");
    const media = await probe(input);
    const fps = rationalValue(media.video!.fps);
    const f = await extractFeatures(input, media.video!.displayWidth, media.video!.displayHeight, 128);
    const truth = JSON.parse(readFileSync(join(process.cwd(), "presets", slug, "cutmap.json"), "utf8")) as { shots: { start: number }[]; flashes: { t: number }[] };
    return { d: detectCuts(f, await framePts(input), fps), fps, truth };
  };

  it("finds hard cuts in dark night footage (neon-rain)", async () => {
    const { d, fps, truth } = await detect("neon-rain");
    const found = d.shots.slice(1).map((s) => s.startFrame);
    const cuts = [...new Set(truth.shots.slice(1).map((s) => Math.round(s.start * fps)))];
    // Hard cuts scoring 0.14–0.2 between frames scoring 0.00–0.02; flash-hidden cuts start after their flash.
    const hit = cuts.filter((t) => found.some((g) => Math.abs(g - t) <= 1)).length;
    expect(hit).toBeGreaterThanOrEqual(16);
    expect(found.filter((g) => !cuts.some((t) => Math.abs(g - t) <= 2)).length).toBeLessThanOrEqual(3);
    // Every flash hiding a cut keeps it, and no frame after a flash counts as a flash of its own.
    expect(d.flashes.filter((x) => x.kind === "pulse")).toHaveLength(0);
    expect(d.flashes).toHaveLength(truth.flashes.length);
    for (const fl of d.flashes.filter((x) => x.hidesCut)) expect(found).toContain(fl.endFrame);
  }, 60_000);

  it("counts a glow over several frames once (golden-hour)", async () => {
    const { d, truth } = await detect("golden-hour");
    expect(d.flashes).toHaveLength(truth.flashes.length);
  }, 60_000);
});

describe("the edit's tempo", () => {
  it("keeps the music's tempo when a few cuts only fit another grid by chance (night-stare)", async () => {
    const { analyzeSamples, decodeMono } = await import("../src/engine/audio.js");
    const samples = await decodeMono(join(process.cwd(), "presets", "night-stare", "example.mp4"));
    // The 8 cuts the detector used to find in this example: they fit a 90.5 BPM grid at z ≈ 2.9.
    const cuts = [1.958, 3.083, 4.333, 5.792, 6.875, 8.042, 9.208, 10.25];
    const a = analyzeSamples(samples, undefined, { cuts, fps: 24 });
    expect(a.tempoSource).toBe("audio");
    expect(a.tempoBpm).toBeCloseTo(120, 0);
    // Random cut times never move the tempo either.
    let seed = 5;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let k = 0; k < 10; k++) {
      const random = Array.from({ length: 20 }, () => 0.3 + rnd() * 10.4).sort((x, y) => x - y);
      expect(analyzeSamples(samples, undefined, { cuts: random, fps: 24 }).tempoSource).toBe("audio");
    }
  }, 60_000);
});
