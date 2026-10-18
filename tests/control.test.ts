import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clipSeconds, JobSpecSchema, makeControlClip } from "../src/comfy/jobs.js";
import { clipFrames, profile } from "../src/comfy/operations.js";
import { run } from "../src/util/proc.js";
import { tempDir } from "./helpers/synth.js";

/** Frames stored in an animated WebP: one ANMF chunk each. */
async function webpFrames(file: string): Promise<number> {
  const b = await readFile(file);
  let n = 0;
  for (let i = b.indexOf("ANMF"); i >= 0; i = b.indexOf("ANMF", i + 4)) n++;
  return n;
}

describe("control clips for motion transfer", () => {
  it("keep the reference's speed: a realtime clip is exactly the model's frame count, filled back and forth", async () => {
    const dir = await tempDir();
    const src = join(dir, "move.mp4");
    // 2 s of a moving box at 24 fps, then a still second: the kind of shot a motion job re-performs.
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=3", "-pix_fmt", "yuv420p", src]);
    const motion = JobSpecSchema.parse({ line: "box", operation: "clip.motion", prompt: "p", start: "s1", motion: { startSec: 0.5, endSec: 1.58, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } }).motion!;
    expect(motion.fit).toBe("realtime");
    // 1.08 s of source at 24 fps is 26 frames; H3 needs 17n+5, so 39 frames, never a slowed-down 26.
    const sec = clipSeconds({ operation: "clip.motion", motion });
    expect(clipFrames(profile("minimax-h3-motion"), Math.round(sec * 24))).toBe(39);
    expect(clipFrames(profile("wan-animate2"), Math.round(sec * 24))).toBe(29);
    for (const frames of [39, 56]) {
      const out = join(dir, `c${frames}.webp`);
      await makeControlClip(src, out, { ...motion, fps: 24, frames, width: 256, height: 192, control: "raw" });
      expect(await webpFrames(out), `${frames} frames`).toBe(frames);
    }
  });

  it("hold the last frame without losing frames to the WebP encoder's merging", async () => {
    const dir = await tempDir();
    const src = join(dir, "still.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:size=160x120:rate=24:duration=1", "-pix_fmt", "yuv420p", src]);
    const out = join(dir, "hold.webp");
    await makeControlClip(src, out, { startSec: 0, endSec: 0.5, fps: 24, frames: 33, width: 160, height: 120, control: "raw", fit: "hold" });
    expect(await webpFrames(out)).toBe(33);
  });

  it("use the job's own duration unless a realtime motion sets it", () => {
    expect(clipSeconds({ operation: "clip.i2v", durationSec: 3 })).toBe(3);
    expect(clipSeconds({ operation: "clip.i2v" })).toBe(2);
    expect(clipSeconds({ operation: "clip.motion", durationSec: 4, motion: { asset: "ref", startSec: 1, endSec: 2.5, control: "pose", fit: "stretch" } })).toBe(4);
    expect(clipSeconds({ operation: "clip.motion", durationSec: 4, motion: { asset: "ref", startSec: 1, endSec: 2.5, control: "pose", fit: "realtime" } })).toBeCloseTo(1.5);
  });
});
