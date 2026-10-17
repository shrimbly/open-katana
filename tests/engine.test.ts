import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeReference, type ReferenceAnalysis } from "../src/engine/analyze.js";
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
