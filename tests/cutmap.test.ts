import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cutMapFromAnalysis, cutMapFromEdl, cutMapFromPreset, recipeSketch } from "../src/app/cutmap.js";
import { analyzeReference } from "../src/engine/analyze.js";
import { getPreset } from "../src/presets/library.js";
import { renderProject } from "../src/project/render-project.js";
import { Workspace } from "../src/project/workspace.js";
import { EdlSchema } from "../src/render/edl.js";
import { run } from "../src/util/proc.js";
import { tempDir } from "./helpers/synth.js";

describe("cut maps from templates", () => {
  it("resolves the Hype Energy skeleton on its own grid", async () => {
    const map = cutMapFromPreset(await getPreset("hype-energy"));
    expect(map.shots).toHaveLength(49);
    expect(map.flashes).toHaveLength(7);
    expect(map.durationSec).toBe(16.433);
    expect(map.aspect).toBeCloseTo(9 / 16, 3);
    expect(map.approximate).toBeUndefined();
    expect(map.shots[0]).toEqual({ start: 0, end: 0.017, slot: "temple" });
    expect(map.shots.at(-1)!.end).toBe(16.433);
    // Beat 0 at 0.5 s, 144 BPM; every 4th beat is a downbeat; the drop is beat 18.
    expect(map.beats[0]).toBe(0.5);
    expect(map.beats[1]).toBeCloseTo(0.917, 3);
    expect(map.downbeats.slice(0, 2)).toEqual([0.5, map.beats[4]]);
    // The drop is beat 18.5, where the template's own track drops (8.21 s).
    expect(map.dropSec).toBeCloseTo(0.5 + (18.5 * 60) / 144, 3);
    expect(map.flashes[0]).toEqual({ t: 8.15, durationSec: 0.1, color: "#F3EACD" });
    expect(map.text.map((t) => t.text)).toEqual(["NOTHING NEW", "SAME OLD DAY", "IS THAT ALL?", "BORN", "DIFFERENT", "PERIOD", "CROWN ACCEPTED"]);
    expect(map.text[0]).toEqual({ index: 0, start: 1.033, end: 1.767, text: "NOTHING NEW" });
    // Cuts tile the timeline with no gaps.
    for (let i = 1; i < map.shots.length; i++) expect(map.shots[i]!.start).toBe(map.shots[i - 1]!.end);
  });

  it("follows a fitted track's grid and length", async () => {
    const hype = await getPreset("hype-energy");
    const map = cutMapFromPreset(hype, { grid: { bpm: 128, phase: 0.5 }, durationSec: 18.32 });
    expect(map.durationSec).toBe(18.32);
    expect(map.beats[1]! - map.beats[0]!).toBeCloseTo(60 / 128, 3);
    expect(map.text[0]!.start).toBeCloseTo(0.5 + (1.28 * 60) / 128, 2);
    expect(map.dropSec).toBeCloseTo(0.5 + (18.5 * 60) / 128, 2);
  });

  it("uses Iron Mindset's grid and the end of its last shot", async () => {
    const map = cutMapFromPreset(await getPreset("iron-mindset"));
    expect(map.aspect).toBeCloseTo(16 / 9, 3);
    expect(map.beats[0]).toBe(0.046);
    expect(map.beats[1]! - map.beats[0]!).toBeCloseTo(60 / 94.8, 3);
    expect(map.durationSec).toBeCloseTo(27.417, 2);
    expect(map.shots.length).toBeGreaterThan(40);
    expect(map.text).toHaveLength(17);
    expect(map.flashes).toHaveLength(8);
    expect(map.approximate).toBeUndefined();
  });

  it("draws Night Stare on the grid of its bundled soundtrack", async () => {
    const map = cutMapFromPreset(await getPreset("night-stare"));
    expect(map.approximate).toBeFalsy();
    expect(map.beats[0]).toBeCloseTo(0.31, 2);
    expect(map.beats[1]! - map.beats[0]!).toBeCloseTo(60 / 119.78, 3);
    expect(map.shots.length).toBeGreaterThan(20);
    expect(map.text.map((t) => t.text)).toEqual(["BUILT", "IN", "THE", "DARK"]);
  });

  it("marks a gridless skeleton's map approximate: a nominal 120 BPM", async () => {
    const preset = structuredClone(await getPreset("night-stare"));
    delete (preset!.skeleton as { grid?: unknown }).grid;
    const map = cutMapFromPreset(preset!);
    expect(map.approximate).toBe(true);
    expect(map.beats.slice(0, 3)).toEqual([0, 0.5, 1]);
    expect(map.shots.length).toBeGreaterThan(20);
  });

  it("sketches freestyle templates from their recipe", async () => {
    const map = cutMapFromPreset(await getPreset("cold-stare"));
    expect(map.shots).toEqual([]);
    expect(map.sketch).toEqual([
      { start: 0, end: 3, label: "stare" },
      { start: 3, end: 8, label: "ladder" },
      { start: 8, end: 10, label: "payoff" },
    ]);
    expect(map.durationSec).toBe(10);
    expect(map.approximate).toBe(true);
    expect(cutMapFromPreset(await getPreset("neon-rain")).sketch).toHaveLength(5);
    const structure = [
      { at: "0–0.95 s (to b1.08)", role: "teaser", guidance: "" },
      { at: "40-45%", role: "drop", guidance: "" },
      { at: "b7–b11", role: "skipped", guidance: "" },
      { at: "the end", role: "skipped", guidance: "" },
    ];
    expect(recipeSketch(structure, 20)).toEqual([
      { start: 0, end: 0.95, label: "teaser" },
      { start: 8, end: 9, label: "drop" },
    ]);
  });
});

describe("cut maps from a decoded video and from its EDL", () => {
  it("agree on the same cut: rendering an EDL and decoding it gives its shots, flash and colours back", async () => {
    const dir = await tempDir("ok-cutmap-");
    const ws = await Workspace.create({ title: "cutmap", root: dir });
    // Textured stills for two shots (a flash over a flat colour reads as a hidden cut), solid colours for the rest.
    for (const [id, src] of [["texa", "testsrc2=s=640x360"], ["texb", "mandelbrot=s=640x360"]] as const) {
      const file = join(dir, `${id}.png`);
      await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-frames:v", "1", file]);
      await ws.import(file, "style", { id });
    }
    const sources = ["#C0392B", "texa", "#27AE60", "#F1C40F", "texb"];
    const bounds = [0, 0.5, 1.25, 2, 3, 4];
    const edl = EdlSchema.parse({
      canvas: { width: 320, height: 180, fps: 24, durationSec: 4 },
      audio: null,
      shots: sources.map((asset, i) => ({ start: bounds[i], end: bounds[i + 1], source: { asset } })),
      flashes: [{ at: 3.5, duration: 0.084 }],
    });
    await ws.writeJson("render/edl.json", edl);
    const fromEdl = (await cutMapFromEdl(ws))!;
    expect(fromEdl.shots.map((s) => [s.start, s.end, s.color ?? s.label])).toEqual(sources.map((c, i) => [bounds[i], bounds[i + 1], c]));
    expect(fromEdl.shots[1]!.thumb).toBe(`/api/projects/${ws.project.id}/thumb?asset=texa&t=0.00&h=120`);
    expect(fromEdl.flashes).toEqual([{ t: 3.5, durationSec: 0.084, color: "#FFFFFF" }]);

    const render = await renderProject(ws, "master");
    const a = await analyzeReference(render.path, join(ws.dir, "check"), { seed: "cutmap", skipPages: true });
    const fromVideo = cutMapFromAnalysis({ breakdown: a.breakdown, energy: a.energy, audio: a.audio, shotColors: a.breakdown.shotColors });
    const frame = 1 / 24;
    expect(fromVideo.durationSec).toBeCloseTo(fromEdl.durationSec, 1);
    expect(fromVideo.aspect).toBeCloseTo(fromEdl.aspect, 3);
    expect(fromVideo.shots).toHaveLength(fromEdl.shots.length);
    const rgb = (hex: string) => [1, 3, 5].map((k) => Number.parseInt(hex.slice(k, k + 2), 16));
    for (const [i, s] of fromVideo.shots.entries()) {
      const want = fromEdl.shots[i]!;
      expect(Math.abs(s.start - want.start), `shot ${i} start`).toBeLessThanOrEqual(frame + 1e-6);
      expect(Math.abs(s.end - want.end), `shot ${i} end`).toBeLessThanOrEqual(frame + 1e-6);
      expect(s.color, `shot ${i} colour`).toMatch(/^#[0-9a-f]{6}$/);
      if (!want.color) continue;
      const got = rgb(s.color!);
      rgb(want.color).forEach((v, k) => expect(Math.abs(got[k]! - v), `shot ${i} colour`).toBeLessThan(16));
    }
    expect(fromVideo.flashes).toHaveLength(1);
    expect(Math.abs(fromVideo.flashes[0]!.t - 3.5)).toBeLessThanOrEqual(frame + 1e-6);
    expect(fromVideo.energy).toHaveLength(4);
    expect(fromVideo.beats).toEqual([]);
  }, 60_000);

  it("has nothing to show before the first edit", async () => {
    const ws = await Workspace.create({ title: "cutmap empty", root: await tempDir("ok-cutmap-") });
    expect(await cutMapFromEdl(ws)).toBeUndefined();
  });
});
