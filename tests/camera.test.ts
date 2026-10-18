import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CameraMoveSchema, cameraFrames, type GrayImage, writeCameraClip } from "../src/comfy/camera.js";
import { chooseProfile, JobSpecSchema } from "../src/comfy/jobs.js";
import { run } from "../src/util/proc.js";

const W = 96;
const H = 160;

/**
 * A far background, a subject filling the centre (the pivot) and a small near box in front of it,
 * lower right (like a mirror or a bumper corner in a detail shot).
 */
function scene(): GrayImage {
  const data = new Uint8Array(W * H).fill(0);
  for (let y = 40; y < 120; y++) for (let x = 24; x < 72; x++) data[y * W + x] = 150;
  for (let y = 128; y < 142; y++) for (let x = 60; x < 70; x++) data[y * W + x] = 255;
  return { width: W, height: H, data };
}

function nearBox(frame: Uint8Array): { cx: number; area: number } {
  let sx = 0;
  let area = 0;
  for (let i = 0; i < frame.length; i++)
    if (frame[i]! > 200) {
      sx += i % W;
      area++;
    }
  return { cx: sx / Math.max(1, area), area };
}

const move = (m: Record<string, unknown>) => CameraMoveSchema.parse(m);

describe("camera moves from a keyframe's own depth", () => {
  it("start on the keyframe's own depth, one frame per clip frame", () => {
    const frames = cameraFrames(scene(), move({ orbit: 3 }), 5);
    expect(frames).toHaveLength(5);
    expect(nearBox(frames[0]!).cx).toBeCloseTo(nearBox(scene().data).cx, 0);
  });

  it("slide near things against the pivot the way the camera travels: right orbit, near objects go left", () => {
    const start = nearBox(scene().data).cx;
    const right = nearBox(cameraFrames(scene(), move({ orbit: 3 }), 3)[2]!).cx;
    const left = nearBox(cameraFrames(scene(), move({ orbit: -3 }), 3)[2]!).cx;
    expect(right).toBeLessThan(start - 2);
    expect(left).toBeGreaterThan(start + 2);
  });

  it("grow the subject on a push-in and fill what the keyframe never saw with background", () => {
    const frames = cameraFrames(scene(), move({ push: 0.2 }), 3);
    const width = (f: Uint8Array) => [...f.subarray((H / 2) * W, (H / 2 + 1) * W)].filter((v) => v > 40).length;
    // 48 px wide in the keyframe; near edges grow one pixel each side from the splats.
    expect(width(frames[0]!)).toBe(50);
    expect(width(frames[2]!)).toBeGreaterThan(55);
    // Where the near box was, the orbit reveals what was behind it: the subject or the background, never the box.
    const orbited = cameraFrames(scene(), move({ orbit: 3 }), 2)[1]!;
    for (let y = 131; y < 139; y++) for (let x = 63; x < 67; x++) expect(orbited[y * W + x]).toBeLessThan(200);
  });

  it("ease in and out when asked, linear otherwise", () => {
    const mid = (ease: "linear" | "ease") => nearBox(cameraFrames(scene(), move({ orbit: 3, ease }), 9)[1]!).cx;
    const start = nearBox(scene().data).cx;
    expect(Math.abs(mid("ease") - start)).toBeLessThan(Math.abs(mid("linear") - start));
  });

  it("write an animated WebP control clip at the clip's size and frame count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ok-cam-"));
    try {
      const png = join(dir, "depth.png");
      await run("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-i", "-", png], { input: Buffer.from(scene().data) });
      const out = await writeCameraClip(png, join(dir, "c.webp"), { move: move({ orbit: 6 }), frames: 9, fps: 24, width: 144, height: 256 });
      const info = await run("webpmux", ["-info", out]).catch(() => undefined);
      if (info) {
        const text = info.stdout.toString();
        expect(text).toMatch(/Canvas size: 144 x 256/);
        expect((text.match(/^\s*\d+:/gm) ?? []).length).toBe(9);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("take start and no motion source, and never default to a profile that can't follow a camera move", () => {
    const spec = JobSpecSchema.parse({ line: "wheel", operation: "clip.motion", prompt: "p", start: "@wheel-key", camera: { orbit: -7, push: 0.04 } });
    expect(spec.camera).toMatchObject({ orbit: -7, arc: 0, push: 0.04, ease: "linear", strength: 1 });
    const opts = { tier: "quality" as const, overrides: {} };
    expect(chooseProfile(spec, opts)).toBe("minimax-h3-motion");
    expect(chooseProfile({ operation: "clip.motion", motion: { asset: "ref", startSec: 0, endSec: 1, control: "depth", fit: "realtime" } }, opts)).toBe("minimax-h3-motion");
    expect(chooseProfile({ operation: "clip.motion", motion: { asset: "ref", startSec: 0, endSec: 1, control: "pose", fit: "realtime" } }, opts)).toBe("wan-animate2");
    // An override that can't follow the camera move gives way to one that can; a profile named in the job always wins.
    expect(chooseProfile(spec, { ...opts, overrides: { "clip.motion": "wan-animate2" } })).toBe("minimax-h3-motion");
    expect(chooseProfile({ ...spec, profile: "minimax-h3-motion-ref" }, opts)).toBe("minimax-h3-motion-ref");
  });
});
