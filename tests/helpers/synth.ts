import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/util/proc.js";

export const FPS = 24;

/**
 * Ground truth for the synthetic reference edit built by `makeReferenceEdit`.
 * Frames: pan 0–23 | bars 24–35 | blue insert 36 | still + white flash at 47–48 | shake 61–83.
 */
export const TRUTH = {
  frameCount: 84,
  cutFrames: [24, 36, 37, 61],
  flashFrames: [47, 48],
  panShot: 0,
  shakeShot: 4,
  beatPeriodSec: 0.5,
};

/** A fresh directory under the test run's scratch root (removed in global teardown). */
export async function tempDir(prefix = "ok-test-"): Promise<string> {
  return mkdtemp(join(process.env.OPEN_KATANA_TEST_TMP ?? tmpdir(), prefix));
}

async function segment(dir: string, name: string, vf: string, frames: number, source: string): Promise<string> {
  const out = join(dir, `${name}.mp4`);
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", source,
    "-vf", `${vf},fps=${FPS},format=yuv420p`,
    "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-g", "1",
    out,
  ]);
  return out;
}

/** Builds a 3.5 s, 640×360, 24 fps reference edit with known cuts, a flash, a pan, shake and 120 BPM clicks. */
export async function makeReferenceEdit(dir: string): Promise<string> {
  // A static, low-frequency color texture: enough 2-D detail for motion estimation at analysis size.
  const still =
    "nullsrc=s=1280x720:r=24,geq=r='255*random(1)':g='255*random(2)':b='255*random(3)',boxblur=10:2,eq=contrast=4,trim=end_frame=1,loop=loop=-1:size=1:start=0";
  const parts = [
    await segment(dir, "a_pan", "crop=640:360:x='160+n*8':y=180", 24, still),
    await segment(dir, "b_bars", "scale=640:360", 12, "smptehdbars=s=640x360:r=24"),
    await segment(dir, "c_insert", "scale=640:360", 1, "color=c=0x1030ff:s=640x360:r=24"),
    await segment(dir, "d_flash", "scale=640:360,drawbox=enable='between(n,10,11)':color=white:t=fill", 24, "mandelbrot=s=640x360:r=24:end_scale=0.5"),
    await segment(dir, "e_shake", "crop=640:360:x='320+14*sin(n*2.3)':y='180+10*cos(n*1.9)'", 23, still),
  ];
  const list = join(dir, "parts.txt");
  await writeFile(list, parts.map((p) => `file '${p}'`).join("\n"));
  const video = join(dir, "video.mp4");
  await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);
  const out = join(dir, "reference.mp4");
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-i", video,
    "-f", "lavfi", "-i", "aevalsrc=exprs='0.8*sin(2*PI*880*t)*exp(-60*mod(t\\,0.5))':s=44100:d=3.5",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
    out,
  ]);
  return out;
}
