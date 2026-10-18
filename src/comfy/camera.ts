import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { run } from "../util/proc.js";

/**
 * Camera moves made from a keyframe's own depth. The keyframe's depth map is re-rendered from a camera
 * that orbits, arcs or pushes in around the subject, and those depth frames steer the clip. The control
 * always agrees with frame 0, so the model can't snap to another subject's shapes or cut away, and the
 * parallax is real: near things slide past far things the way a gimbal move shows them.
 */
export const CameraMoveSchema = z.object({
  /** Degrees the camera arcs around the subject, keeping it framed: positive to the camera's right, negative to its left. */
  orbit: z.number().min(-30).max(30).default(0),
  /** Degrees the camera arcs up over (positive) or down under (negative) the subject. */
  arc: z.number().min(-20).max(20).default(0),
  /** Fraction of the distance to the subject the camera travels toward it; negative pulls back. */
  push: z.number().min(-0.4).max(0.4).default(0),
  /** "linear" keeps one speed (a move already under way, as in most cut-in shots); "ease" starts and stops gently. */
  ease: z.enum(["linear", "ease"]).default("linear"),
  /** How hard the move steers the clip (default 1). */
  strength: z.number().min(0.1).max(2).default(1),
});
export type CameraMove = z.infer<typeof CameraMoveSchema>;

export interface GrayImage {
  width: number;
  height: number;
  /** One byte per pixel, row by row. Depth maps: near is bright. */
  data: Uint8Array;
}

/** The far/near distance ratio a 0–1 depth map is read as: enough parallax for a gimbal move, never a fisheye swing. */
const DEPTH_RATIO = 10;
/** Vertical field of view of the virtual camera, in degrees (about a 35 mm lens on a phone-shaped frame). */
const FOV = 40;

/**
 * Depth frames of `depth` seen from a camera making `move`, one per frame. Pure. The pivot is the subject:
 * the nearest third of the frame's central region, so the subject stays framed while the background slides.
 */
export function cameraFrames(depth: GrayImage, move: Pick<CameraMove, "orbit" | "arc" | "push" | "ease">, frames: number): Uint8Array[] {
  const { width: W, height: H, data } = depth;
  const n = W * H;
  const f = H / 2 / Math.tan((FOV * Math.PI) / 360);
  const lnr = Math.log(DEPTH_RATIO);
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = DEPTH_RATIO ** (1 - data[i]! / 255);
  const centre: number[] = [];
  for (let y = H >> 2; y < (3 * H) >> 2; y++) for (let x = W >> 2; x < (3 * W) >> 2; x++) centre.push(z[y * W + x]!);
  centre.sort((a, b) => a - b);
  const zp = centre.length ? centre[Math.floor(centre.length * 0.3)]! : 1;
  // Points relative to the pivot.
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const pz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % W;
    const y = (i - x) / W;
    px[i] = ((x - W / 2) / f) * z[i]!;
    py[i] = ((y - H / 2) / f) * z[i]!;
    pz[i] = z[i]! - zp;
  }
  const out: Uint8Array[] = [];
  const zbuf = new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let k = 0; k < frames; k++) {
    const t = frames > 1 ? k / (frames - 1) : 0;
    const e = move.ease === "ease" ? t * t * (3 - 2 * t) : t;
    // The camera turns around the pivot, so the world turns the other way in its view.
    const yaw = (-move.orbit * e * Math.PI) / 180;
    const pitch = (move.arc * e * Math.PI) / 180;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch);
    const dist = zp * (1 - move.push * e);
    zbuf.fill(Infinity);
    for (let i = 0; i < n; i++) {
      const x1 = cy * px[i]! - sy * pz[i]!;
      const z1 = sy * px[i]! + cy * pz[i]!;
      const y2 = cx * py[i]! - sx * z1;
      const Z = sx * py[i]! + cx * z1 + dist;
      if (Z < 0.05) continue;
      const u = Math.round((x1 / Z) * f + W / 2);
      const v = Math.round((y2 / Z) * f + H / 2);
      // 3×3 splats, nearest wins: a surface seen closer or at an angle stays closed, and the background
      // can't show through it. Centred, so the picture doesn't shift (near edges grow by one pixel).
      for (let yy = v - 1; yy <= v + 1; yy++) {
        if (yy < 0 || yy >= H) continue;
        for (let xx = u - 1; xx <= u + 1; xx++) {
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (Z < zbuf[j]!) zbuf[j] = Z;
        }
      }
    }
    // What the keyframe never saw (behind the subject, past the frame edge) is background: holes grow
    // inward from their farthest seen neighbour; anything still open after that takes the farther end
    // of its row, then of its column.
    let holes: number[] = [];
    for (let j = 0; j < n; j++) if (!Number.isFinite(zbuf[j]!)) holes.push(j);
    for (let pass = 0; pass < 96 && holes.length; pass++) {
      tmp.set(zbuf);
      const open: number[] = [];
      for (const j of holes) {
        const x = j % W;
        const y = (j - x) / W;
        let far = -Infinity;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
            const d = tmp[yy * W + xx]!;
            if (Number.isFinite(d) && d > far) far = d;
          }
        if (far > -Infinity) zbuf[j] = far;
        else open.push(j);
      }
      holes = open;
    }
    if (holes.length) {
      fillFarther(zbuf, H, W, W, 1);
      fillFarther(zbuf, W, H, 1, W);
    }
    const frame = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = Number.isFinite(zbuf[i]!) ? zbuf[i]! : DEPTH_RATIO;
      frame[i] = Math.round(Math.min(1, Math.max(0, 1 - Math.log(Math.max(d, 1e-3)) / lnr)) * 255);
    }
    out.push(frame);
  }
  return out;
}

/** Fills each unseen run along lines of `len` pixels with the farther of its two seen ends. */
function fillFarther(buf: Float32Array, lines: number, len: number, lineStride: number, step: number): void {
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    let i = 0;
    while (i < len) {
      if (Number.isFinite(buf[base + i * step]!)) {
        i++;
        continue;
      }
      let j = i;
      while (j < len && !Number.isFinite(buf[base + j * step]!)) j++;
      const before = i > 0 ? buf[base + (i - 1) * step]! : -Infinity;
      const after = j < len ? buf[base + j * step]! : -Infinity;
      const fill = Math.max(before, after);
      if (fill > -Infinity) for (let k = i; k < j; k++) buf[base + k * step] = fill;
      i = j;
    }
  }
}

/** Reads an image file as 8-bit gray. */
export async function readGray(path: string): Promise<GrayImage> {
  const probe = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path]);
  const [width, height] = probe.stdout.toString().trim().split(",").map(Number) as [number, number];
  const raw = await run("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  return { width, height, data: new Uint8Array(raw.stdout.buffer, raw.stdout.byteOffset, width * height) };
}

/**
 * Writes the control clip for a camera move: an animated WebP of `frames` depth frames at the clip's size.
 * Faint temporal noise keeps every frame distinct, as in the other control clips (the encoder merges
 * identical frames, which would break the timing of a move that eases to a stop).
 */
export async function writeCameraClip(depthPng: string, out: string, opts: { move: CameraMove; frames: number; fps: number; width: number; height: number }): Promise<string> {
  const depth = await readGray(depthPng);
  const frames = cameraFrames(depth, opts.move, opts.frames);
  await mkdir(dirname(out), { recursive: true });
  await run(
    "ffmpeg",
    [
      "-v", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${depth.width}x${depth.height}`, "-r", String(opts.fps), "-i", "-",
      "-vf", `scale=${opts.width}:${opts.height}:flags=lanczos:force_original_aspect_ratio=increase,crop=${opts.width}:${opts.height},noise=alls=2:allf=t,format=rgb24`,
      "-frames:v", String(opts.frames),
      "-loop", "0", "-lossless", "0", "-q:v", "75",
      out,
    ],
    { input: Buffer.concat(frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength))) },
  );
  return out;
}
