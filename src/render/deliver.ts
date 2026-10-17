import { copyFile, stat } from "node:fs/promises";
import { probe } from "../engine/probe.js";
import { run } from "../util/proc.js";

export interface DeliverResult {
  path: string;
  sizeMB: number;
  reencoded: boolean;
  frames: number;
}

/**
 * Produces the shareable file from a master: copied as-is when it fits under `maxMB`,
 * otherwise re-encoded at a bitrate that does. The frame count is verified either way.
 */
export async function deliver(master: string, out: string, maxMB = 50): Promise<DeliverResult> {
  const info = await probe(master);
  const frames = info.video?.frameCount ?? 0;
  const size = (await stat(master)).size;
  let reencoded = false;
  if (size <= maxMB * 2 ** 20) {
    await copyFile(master, out);
  } else {
    const audioKbps = info.audio ? 192 : 0;
    const videoKbps = Math.max(500, Math.floor(((maxMB * 0.94 * 8 * 1024) / Math.max(info.durationSec, 0.1)) - audioKbps));
    await run("ffmpeg", [
      "-v", "error", "-y", "-i", master,
      "-c:v", "libx264", "-preset", "slow", "-b:v", `${videoKbps}k`, "-maxrate", `${Math.round(videoKbps * 1.5)}k`, "-bufsize", `${videoKbps * 2}k`,
      "-pix_fmt", "yuv420p", "-frames:v", String(frames),
      ...(info.audio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-movflags", "+faststart", out,
    ]);
    reencoded = true;
  }
  const check = await probe(out);
  if ((check.video?.frameCount ?? 0) !== frames) throw new Error(`Delivered file has ${check.video?.frameCount} frames, master has ${frames}`);
  return { path: out, sizeMB: Math.round(((await stat(out)).size / 2 ** 20) * 100) / 100, reencoded, frames };
}
