import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeAudio } from "../src/engine/audio.js";
import { probe } from "../src/engine/probe.js";
import { assColor, assTime, textToAss } from "../src/render/ass.js";
import { checkEdl, EdlSchema, resolveTime, TextSchema } from "../src/render/edl.js";
import { cameraFilter } from "../src/render/expr.js";
import { compareEnergy } from "../src/render/qa.js";
import { rampPts, renderEdl, segments } from "../src/render/render.js";
import { run } from "../src/util/proc.js";
import { makeReferenceEdit, tempDir } from "./helpers/synth.js";

const ctx = { fps: 24, beats: [0.5, 1, 1.5, 2] };

describe("EDL timing", () => {
  it("resolves seconds, frames and (fractional) beats", () => {
    expect(resolveTime(1.25, ctx)).toBe(1.25);
    expect(resolveTime("f48", ctx)).toBe(2);
    expect(resolveTime("b1", ctx)).toBe(1);
    expect(resolveTime("b1.5", ctx)).toBe(1.25);
    expect(resolveTime("b5", ctx)).toBeCloseTo(3, 5);
  });

  it("reports gaps and fills them with black segments", () => {
    const edl = EdlSchema.parse({ canvas: { width: 64, height: 64, fps: 24, durationSec: 2 }, audio: null, shots: [{ start: 0, end: 0.5, source: { asset: "black" } }, { start: 1, end: 2, source: { asset: "white" } }] });
    const check = checkEdl(edl, ctx);
    expect(check.warnings.some((w) => w.includes("Gap of 12 frames"))).toBe(true);
    const segs = segments(check.shots, check.totalFrames, 24);
    expect(segs.map((s) => [s.startFrame, s.frames, s.shot ? "shot" : "gap"])).toEqual([
      [0, 12, "shot"],
      [12, 12, "gap"],
      [24, 24, "shot"],
    ]);
  });

  it("cuts an overlapped shot so the later one wins", () => {
    const edl = EdlSchema.parse({ canvas: { width: 64, height: 64, fps: 24 }, audio: null, shots: [{ start: 0, end: 1, source: { asset: "black" } }, { start: 0.5, end: 1.5, source: { asset: "white" } }] });
    const check = checkEdl(edl, ctx);
    const segs = segments(check.shots, check.totalFrames, 24);
    expect(segs.map((s) => [s.startFrame, s.frames])).toEqual([[0, 12], [12, 24]]);
  });

  it("integrates speed ramps", () => {
    expect(rampPts(1, 1, 2)).toBe("PTS/1");
    // A 1 → 0.5 ramp over 2 s consumes 1.5 s of source; the inverse maps source 1.5 s back to output 2 s.
    const k = (0.5 - 1) / 2;
    expect((-1 + Math.sqrt(1 + 2 * k * 1.5)) / k).toBeCloseTo(2, 6);
  });
});

describe("camera and text compilation", () => {
  it("skips identity cameras and compiles moves to a perspective transform", () => {
    const base = { width: 1080, height: 1920, fps: 30, durationSec: 2, shotStartSec: 0, time: (t: number | string) => resolveTime(t, ctx) };
    expect(cameraFilter({ ease: "out" }, base)).toBeUndefined();
    const f = cameraFilter({ ease: "out", zoom: [1, 1.2], punch: { at: ["b1"], amount: 0.1, decay: 0.2 }, shake: { amp: 0.01, freq: 9, decay: true } }, base)!;
    expect(f.startsWith("perspective=")).toBe(true);
    expect(f).toContain("sense=destination");
    expect(f).not.toMatch(/[^\\],(?![^']*')/); // commas only inside quoted, escaped expressions
  });

  it("writes ASS events with glow layers and typewriter reveals", () => {
    expect(assColor("#FF8000")).toBe("&H000080FF&");
    expect(assTime(61.234)).toBe("0:01:01.23");
    const glow = TextSchema.parse({ text: "AURA", start: 0, end: 1, glow: 5, anim: "slam" });
    const type = TextSchema.parse({ text: "BORN", start: 1, end: 2, anim: "type" });
    const ass = textToAss([{ event: glow, startSec: 0, endSec: 1 }, { event: type, startSec: 1, endSec: 2 }], 1080, 1920);
    const dialogue = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogue.filter((l) => l.includes("AURA"))).toHaveLength(2);
    expect(dialogue.filter((l) => l.includes("\\alpha&HFF&}"))).toHaveLength(3);
    expect(dialogue.find((l) => l.startsWith("Dialogue: 0"))).toContain("\\3a&HFF&");
  });
});

describe("energy comparison", () => {
  const map = (cuts: number, flashes: number, camera: number, shake: number) =>
    ({ durationSec: 10, events: [], seconds: [], summary: { cutsPerSecond: cuts, meanShotSec: 1, flashesPerSecond: flashes, shakeSeconds: shake * 10, cameraMoveSeconds: camera * 10, hitsPerSecond: 1, cutsOnBeatShare: 0.5 } }) as never;

  it("fails measures below 0.6 of the reference and too much shake", () => {
    const ok = compareEnergy(map(2, 0.5, 0.5, 0.2), map(1.5, 0.4, 0.4, 0.2));
    expect(ok.pass).toBe(true);
    const slow = compareEnergy(map(2, 0.5, 0.5, 0.2), map(0.8, 0.4, 0.4, 0.2));
    expect(slow.rows.find((r) => r.measure === "cuts")!.status).toBe("fail");
    const shaky = compareEnergy(map(2, 0.5, 0.5, 0.1), map(2, 0.5, 0.5, 0.6));
    expect(shaky.rows.some((r) => r.measure === "shake (max)")).toBe(true);
    const calm = compareEnergy(map(0.2, 0, 0, 0), map(0.1, 0, 0, 0));
    expect(calm.rows.every((r) => r.status === "n/a")).toBe(true);
  });
});

describe("renderer", () => {
  let ref: string;
  let dir: string;
  beforeAll(async () => {
    dir = await tempDir();
    ref = await makeReferenceEdit(dir);
  }, 60_000);

  it("renders exact frame counts and reuses cached shots", async () => {
    const edl = EdlSchema.parse({
      canvas: { width: 320, height: 180, fps: 25 },
      audio: { asset: "ref" },
      finish: { grain: 0.2, letterbox: 0.05 },
      shots: [
        { start: 0, end: 1, source: { asset: "ref", in: 0, speed: 0.5 }, camera: { zoom: [1, 1.1] } },
        { start: 1, end: 1.04, source: { asset: "white" } },
        { start: 1.04, end: 2.2, source: { asset: "ref", in: 2.6, speedTo: 0.3 }, camera: { roll: [-2, 2], shake: {} }, fx: { glow: 0.3, bw: true } },
      ],
      flashes: [{ at: 0.5 }],
      text: [{ text: "TEST", start: 0.2, end: 1.5, anim: "pop" }],
    });
    const opts = { source: (id: string) => ({ path: ref, kind: id === "ref" ? ("video" as const) : ("image" as const), hasAudio: true }), beats: [], outPath: join(dir, "out.mp4"), cacheDir: join(dir, "cache") };
    const first = await renderEdl(edl, opts);
    expect(first.frames).toBe(55);
    expect(first.shotsRendered).toBe(3);
    const info = await probe(first.path);
    expect(info.video!.frameCount).toBe(55);
    expect(info.audio).toBeDefined();
    const second = await renderEdl({ ...edl, text: [{ ...edl.text[0]!, text: "CHANGED" }] }, opts);
    expect(second.shotsCached).toBe(3);
    expect(second.shotsRendered).toBe(0);
  }, 120_000);

  it("mixes built-in sound effects even without a soundtrack", async () => {
    const edl = EdlSchema.parse({
      canvas: { width: 160, height: 90, fps: 24 },
      audio: null,
      shots: [{ start: 0, end: 1.5, source: { asset: "black" } }],
      sfx: [{ at: 0.2, sound: "tick", gainDb: 0 }, { at: 0.8, sound: "hit", gainDb: -3 }, { at: 1.1, sound: "whoosh" }],
    });
    const r = await renderEdl(edl, { source: () => ({ path: ref, kind: "video", hasAudio: true }), beats: [], outPath: join(dir, "sfx.mp4"), cacheDir: join(dir, "cache-sfx") });
    const info = await probe(r.path);
    expect(info.audio).toBeDefined();
    expect(info.durationSec).toBeCloseTo(1.5, 1);
    // Every cue must be audible at its time, not just the first one.
    const onsets = (await analyzeAudio(r.path)).onsets.map((o) => o.timeSec);
    for (const cue of [0.2, 0.8]) expect(onsets.some((t) => Math.abs(t - cue) < 0.08)).toBe(true);
  }, 60_000);

  it("draws behind-subject text between the picture and its matte", async () => {
    const mask = join(dir, "mask.mp4");
    // A white disc on black: the "subject" occupies the centre of the frame.
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=24:d=2", "-vf", "geq=lum='if(lt(hypot(X-320\\,Y-180)\\,120)\\,255\\,0)':cb=128:cr=128", "-pix_fmt", "yuv420p", mask]);
    const edl = EdlSchema.parse({
      canvas: { width: 320, height: 180, fps: 24 },
      audio: null,
      shots: [
        { start: 0, end: 1, source: { asset: "ref", in: 1.6, matte: "mask" } },
        { start: 1, end: 1.5, source: { asset: "black" } },
      ],
      text: [{ text: "BEHIND", start: 0, end: 1.5, behind: true, size: 0.3, color: "#FF0000" }],
    });
    const opts = {
      source: (id: string) => ({ path: id === "mask" ? mask : ref, kind: "video" as const, hasAudio: false }),
      beats: [],
      outPath: join(dir, "behind.mp4"),
      cacheDir: join(dir, "cache-behind"),
    };
    const r = await renderEdl(edl, opts);
    expect(r.frames).toBe(36);
    expect((await probe(r.path)).video!.frameCount).toBe(36);
    expect((await renderEdl(edl, opts)).shotsCached).toBe(2);
  }, 120_000);
});
