import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chooseProfile, estimateSpec, JobSpecSchema } from "../src/comfy/jobs.js";
import { build } from "../src/comfy/operations.js";
import { masterSize, renderProject } from "../src/project/render-project.js";
import { Workspace } from "../src/project/workspace.js";
import { EdlSchema } from "../src/render/edl.js";
import { editAssets, upscaleTargets } from "../src/server/tools-generate.js";
import { run } from "../src/util/proc.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function project(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "ok-up-"));
  dirs.push(root);
  return Workspace.create({ title: "upscale", root });
}

/** A one-second clip of one colour. */
async function clip(dir: string, name: string, colour: string, w: number, h: number): Promise<string> {
  const out = join(dir, name);
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${w}x${h}:r=24:d=1`, "-pix_fmt", "yuv420p", out]);
  return out;
}

/** The mean RGB of the master's middle frame. */
async function middleColour(path: string): Promise<[number, number, number]> {
  const raw = (await run("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", path, "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])).stdout;
  return [raw[0]!, raw[1]!, raw[2]!];
}

describe("the upscale finishing pass", () => {
  it("builds SeedVR2: one step at the target size, colours matched back to the source", () => {
    const b = build("seedvr2-7b-sharp", { prompt: "upscale", seed: 1, aspect: 9 / 16, controlImage: "frames.webp", frames: 56, fps: 24, longSide: 1920, filenamePrefix: "t" });
    const nodes = Object.values(b.prompt) as { class_type: string; inputs: Record<string, unknown> }[];
    expect(nodes.find((n) => n.class_type === "UNETLoader")?.inputs.unet_name).toBe("seedvr2_7b_sharp_int8_convrot.safetensors");
    expect(nodes.find((n) => n.class_type === "KSampler")?.inputs).toMatchObject({ steps: 1, cfg: 1 });
    expect(nodes.find((n) => n.class_type === "ResizeImageMaskNode")?.inputs["resize_type.longer_size"]).toBe(1920);
    expect(nodes.find((n) => n.class_type === "SeedVR2PostProcessing")?.inputs.color_correction_method).toBe("lab");
    expect(nodes.some((n) => n.class_type === "SaveVideo")).toBe(true);
    expect(b).toMatchObject({ width: 1080, height: 1920, frames: 56, fps: 24 });
    const still = build("seedvr2-3b", { prompt: "upscale", seed: 1, aspect: 9 / 16, startImage: "key.png", longSide: 1920, filenamePrefix: "t" });
    expect((Object.values(still.prompt) as { class_type: string }[]).some((n) => n.class_type === "SaveImage")).toBe(true);
    expect(chooseProfile({ operation: "upscale" }, { tier: "quality", overrides: {} })).toBe("seedvr2-7b-sharp");
    expect(chooseProfile({ operation: "upscale" }, { tier: "lite", overrides: {} })).toBe("seedvr2-3b");
  });

  it("upscales each generated shot the edit uses once, never footage or photos, and costs a clip by its frames", async () => {
    const ws = await project();
    const small = await clip(ws.dir, "a.mp4", "red", 72, 128);
    const big = await clip(ws.dir, "b.mp4", "red", 1080, 1920);
    await ws.register({ path: small, role: "generated", id: "shot_t1" });
    await ws.register({ path: big, role: "generated", id: "big_t1" });
    await ws.register({ path: small, role: "subject", id: "s1" });
    const edl = EdlSchema.parse({
      canvas: { width: 72, height: 128, fps: 24 },
      audio: null,
      shots: [
        { start: 0, end: 0.5, source: { asset: "shot_t1" } },
        { start: 0.5, end: 1, source: { asset: "big_t1" }, layers: [{ source: { asset: "s1" } }, { source: { asset: "shot_t1" } }] },
      ],
    });
    expect(editAssets(edl)).toEqual(["shot_t1", "big_t1", "s1"]);
    expect(upscaleTargets(ws, edl, 1920)).toEqual([{ id: "shot_t1", kind: "video" }]);
    const est = estimateSpec(ws, JobSpecSchema.parse({ line: "up-shot_t1", operation: "upscale", prompt: "upscale", start: "shot_t1", longSide: 1920 }), "seedvr2-7b-sharp");
    expect(est).toMatchObject({ width: 1080, height: 1920, frames: 24 });
    // Once a copy at least that big exists, the shot is done.
    await ws.register({ path: big, role: "generated", id: "up-shot_t1_t1", upscaleOf: "shot_t1" });
    expect(upscaleTargets(ws, edl, 1920)).toEqual([]);
    expect(upscaleTargets(ws, edl, 3840).map((t) => t.id)).toEqual(["shot_t1", "big_t1"]);
  });

  it("renders the master at its size from the upscaled copies, and previews from the originals", async () => {
    const ws = await project();
    await ws.register({ path: await clip(ws.dir, "orig.mp4", "red", 72, 128), role: "generated", id: "shot_t1" });
    await ws.register({ path: await clip(ws.dir, "up.mp4", "blue", 144, 256), role: "generated", id: "up-shot_t1_t1", upscaleOf: "shot_t1" });
    expect(masterSize({ width: 720, height: 1280 }, 1920)).toEqual({ width: 1080, height: 1920 });
    const edl = EdlSchema.parse({ canvas: { width: 72, height: 128, fps: 24, master: { longSide: 256 } }, audio: null, shots: [{ start: 0, end: 1, source: { asset: "shot_t1" } }] });
    await ws.writeJson("render/edl.json", edl);
    const master = await renderProject(ws, "master");
    expect(master).toMatchObject({ width: 144, height: 256 });
    const [r, , b] = await middleColour(master.path);
    expect(b).toBeGreaterThan(r);
    const preview = await renderProject(ws, "preview");
    const [r2, , b2] = await middleColour(preview.path);
    expect(r2).toBeGreaterThan(b2);
  });
});
