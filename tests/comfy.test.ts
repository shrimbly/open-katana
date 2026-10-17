import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectOutputs, HttpBackend, onlyUnlistedModels } from "../src/comfy/backend.js";
import { h3Frames, sizeForAspect, wanFrames } from "../src/comfy/graph.js";
import { chooseProfile, submitJobs, waitJobs } from "../src/comfy/jobs.js";
import { build, defaultProfile, flux3RefTags, licenseAllows, licenseWarnings, OPERATIONS, PREFERENCE, PROFILES, profile } from "../src/comfy/operations.js";
import { checkProfile, modelStem, resolveModels } from "../src/comfy/resolve.js";
import { Workspace } from "../src/project/workspace.js";
import { run } from "../src/util/proc.js";
import { tempDir } from "./helpers/synth.js";

const params = { prompt: "p", seed: 3, aspect: 9 / 16, images: ["a.png", "b.png"], startImage: "a.png", endImage: "b.png", controlImage: "c.webp", frames: 30, filenamePrefix: "t" };

describe("graph builders", () => {
  it("round Wan lengths to 4n+1 and sizes to multiples of 16", () => {
    expect(wanFrames(30)).toBe(33);
    expect(wanFrames(33)).toBe(33);
    expect(wanFrames(1)).toBe(5);
    expect(sizeForAspect(9 / 16, 832)).toEqual({ width: 464, height: 832 });
    expect(sizeForAspect(4 / 3, 960, 32)).toEqual({ width: 960, height: 736 });
  });

  it("round MiniMax H3 lengths to 17n+5", () => {
    expect([1, 5, 6, 22, 48, 56, 57].map(h3Frames)).toEqual([5, 5, 22, 22, 56, 56, 73]);
  });

  it("pin an H3 reference shot to its start keyframe with a frame-0 guide", () => {
    const b = build("minimax-h3-r2v", { ...params, images: ["a.png", "b.png", "c.png"], frames: 48 });
    const nodes = Object.values(b.prompt) as { class_type: string; inputs: Record<string, unknown> }[];
    const r2v = nodes.find((n) => n.class_type === "MiniMaxH3ReferenceToVideo")!;
    expect(Object.keys(r2v.inputs).filter((k) => k.startsWith("ref_images."))).toHaveLength(3);
    expect(nodes.find((n) => n.class_type === "MiniMaxH3AddGuide")!.inputs.frame_idx).toBe(0);
    expect(b.frames).toBe(56);
    expect(b.width % 32).toBe(0);
  });

  it("build a saving graph for every profile", () => {
    for (const p of PROFILES) {
      const b = build(p.id, p.operation === "matte" ? { ...params, controlImage: undefined } : params);
      const classes = Object.values(b.prompt).map((n) => (n as { class_type: string }).class_type);
      expect(classes).toContain(p.operation.startsWith("clip") ? "SaveVideo" : "SaveImage");
      for (const node of p.nodes) expect(classes, `${p.id} uses ${node}`).toContain(node);
    }
  });

  it("matte stills as RGBA images and clips as mask videos", () => {
    const classes = (b: ReturnType<typeof build>) => Object.values(b.prompt).map((n) => (n as { class_type: string }).class_type);
    expect(classes(build("birefnet", { ...params, controlImage: undefined }))).toEqual(expect.arrayContaining(["JoinImageWithAlpha", "SaveImage"]));
    expect(classes(build("birefnet", { ...params, fps: 16 }))).toEqual(expect.arrayContaining(["MaskToImage", "SaveVideo"]));
  });

  it("extract pose skeletons in-graph so the driving performer never reaches the model", () => {
    const pose = build("wan22-14b-fun-control", { ...params, controlMode: "pose" });
    const classes = Object.values(pose.prompt).map((n) => (n as { class_type: string }).class_type);
    expect(classes).toContain("SDPoseKeypointExtractor");
    expect(classes).toContain("SDPoseDrawKeypoints");
    const depth = build("wan22-14b-fun-control", { ...params, controlMode: "depth" });
    expect(Object.values(depth.prompt).map((n) => (n as { class_type: string }).class_type)).toContain("DA3Inference");
  });
});

describe("model resolution", () => {
  it("ignores precision tags when matching model files", () => {
    expect(modelStem("flux-2-klein-9b-fp8.safetensors")).toBe("flux-2-klein-9b");
    expect(modelStem("umt5_xxl_fp8_e4m3fn_scaled.safetensors")).toBe("umt5_xxl");
    expect(modelStem("qwen_image_edit_2511_fp8mixed.safetensors")).toBe("qwen_image_edit_2511");
  });

  it("substitutes an available variant and reports models that are missing", () => {
    const b = build("flux2-klein-9b", params);
    const models = new Map([
      ["unet_name", new Set(["flux-2-klein-9b.safetensors"])],
      ["clip_name", new Set<string>()],
      ["vae_name", new Set(["full_encoder_small_decoder.safetensors"])],
    ]);
    const r = resolveModels(b.prompt as never, models);
    expect(r.substituted["flux-2-klein-9b-fp8.safetensors"]).toBe("flux-2-klein-9b.safetensors");
    expect(r.missing.map((m) => m.name)).toEqual(["qwen_3_8b_fp8mixed.safetensors"]);
    expect(checkProfile(profile("flux2-klein-9b"), { nodes: new Set(), models }).missingModels).toEqual(["text_encoders/qwen_3_8b_fp8mixed.safetensors"]);
  });

  it("collects files from every kind of history output", () => {
    const files = collectOutputs({ "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] }, "12": { images: [{ filename: "v.mp4", subfolder: "video", type: "output" }], animated: [true] } });
    expect(files.map((f) => `${f.nodeId}:${f.filename}`)).toEqual(["9:a.png", "12:v.mp4"]);
  });
});

describe("HTTP backend against a mock ComfyUI", () => {
  let server: Server;
  let url: string;
  let png: Buffer;
  const prompts: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const dir = await tempDir();
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240", "-frames:v", "1", join(dir, "out.png")]);
    png = await readFile(join(dir, "out.png"));
    let polls = 0;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const json = (data: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (req.url === "/system_stats") return json({ system: { comfyui_version: "0.0.test" }, devices: [{ name: "mock", vram_total: 24 * 2 ** 30 }] });
      if (req.url === "/object_info") return json({ UNETLoader: { input: { required: { unet_name: [["z_image_turbo_bf16.safetensors"]] } } } });
      if (req.url === "/upload/image") return json({ name: `up-${body.length}.png`, subfolder: "" });
      if (req.url === "/prompt") {
        prompts.push(JSON.parse(body.toString()).prompt);
        return json({ prompt_id: `p${prompts.length}` });
      }
      if (req.url === "/queue") return json({ queue_running: [], queue_pending: [] });
      if (req.url?.startsWith("/history/")) {
        const id = req.url.split("/").pop()!;
        if (++polls < 2) return json({});
        return json({ [id]: { status: { status_str: "success", completed: true }, outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } });
      }
      if (req.url?.startsWith("/view")) return res.writeHead(200, { "content-type": "image/png" }).end(png);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => server?.close());

  it("checks, submits, waits and downloads into the project", async () => {
    const backend = new HttpBackend({ kind: "http", url });
    expect((await backend.check()).ok).toBe(true);
    const ws = await Workspace.create({ title: "mock", root: await tempDir("ok-proj-") });
    const { submitted } = await submitJobs(ws, backend, [{ line: "plate1", operation: "still.generate", prompt: "empty rain-wet street at night, no people", takes: 1 }], { tier: "lite", overrides: {} });
    expect(submitted).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain("z_image_turbo_bf16.safetensors");
    const done = await waitJobs(ws, backend, { timeoutSec: 20, intervalSec: 0.05 });
    expect(done[0]!.state).toBe("completed");
    const asset = ws.asset(done[0]!.outputs[0]!);
    expect(asset.role).toBe("generated");
    expect(asset.width).toBe(320);
  });
});

describe("still models", () => {
  it("defaults to the tested best model and falls back to what the backend can run", () => {
    expect(defaultProfile("still.compose").id).toBe("qwen21-edit");
    expect(defaultProfile("still.face").id).toBe("face-crop");
    expect(defaultProfile("still.generate").id).toBe("z-image-turbo");
    expect(defaultProfile("still.compose", "lite").id).toBe("qwen21-turbo-edit");
    expect(defaultProfile("still.compose", "quality", (p) => !p.id.startsWith("qwen21")).id).toBe("boogu-edit");
    expect(defaultProfile("still.generate", "quality", (p) => p.id !== "z-image-turbo").id).toBe("ernie-image-turbo");
  });

  it("keeps opt-in profiles out of the lite fallback", () => {
    expect(PREFERENCE["still.compose"]!.lite).toEqual(["qwen21-turbo-edit", "boogu-edit-turbo"]);
    expect(defaultProfile("still.compose", "lite", (p) => !p.id.startsWith("qwen21")).id).toBe("boogu-edit-turbo");
    // With no preferred lite model runnable, the fallback skips FLUX.2 klein 9B and Mage-Flow (opt-in).
    const fallback = defaultProfile("still.compose", "lite", (p) => !p.id.startsWith("qwen21") && !p.id.startsWith("boogu"));
    expect(fallback.optIn).toBeFalsy();
    expect(fallback.id).toBe("qwen-edit-2511");
  });

  it("builds every still profile into a valid-looking graph", () => {
    for (const p of PROFILES.filter((x) => x.operation.startsWith("still."))) {
      const b = build(p.id, { prompt: "the person from image 2 in the light of image 1", seed: 1, aspect: 16 / 9, images: p.operation === "still.generate" ? undefined : ["a.png", "b.png"], filenamePrefix: "t" });
      const classes = Object.values(b.prompt as Record<string, { class_type: string }>).map((n) => n.class_type);
      for (const n of p.nodes) expect(classes, `${p.id} uses ${n}`).toContain(n);
      expect(classes).toContain("SaveImage");
      if (p.operation === "still.face") {
        expect(classes.filter((c) => c === "LoadImage")).toHaveLength(1);
        continue;
      }
      expect(b.width / b.height).toBeCloseTo(16 / 9, 1);
      // Style reference takes the look of one image; every other compose profile takes them all.
      if (p.operation === "still.compose") expect(classes.filter((c) => c === "LoadImage")).toHaveLength(p.id === "krea2-style-reference" ? 1 : 2);
    }
  });

  it("translates image references for FLUX 3", () => {
    expect(flux3RefTags("the person from image 2 in the framing of Image 1")).toBe("the person from <ref_image_1> in the framing of <ref_image_0>");
  });
});

describe("Comfy Cloud on-demand models", () => {
  it("recognises CLI pre-check failures that are only about unlisted model files", () => {
    const err = (message: string) => Object.assign(new Error(message), { code: "workflow_unknown_nodes" });
    expect(onlyUnlistedModels(err("comfy run: workflow_unknown_nodes — Workflow has 2 validation error(s) against cloud (node 1: 'qwen_image_2.1_turbo_int8_convrot.safetensors' not in 377 known options for unet_name — closest: x\nnode 2: 'qwen3vl_8b_int8_convrot.safetensors' not in 81 known options for clip_name — closest: y)"))).toBe(true);
    expect(onlyUnlistedModels(err("comfy run: workflow_unknown_nodes — (node 3: unknown class_type 'Foo')"))).toBe(false);
    expect(onlyUnlistedModels(Object.assign(new Error("x"), { code: "other" }))).toBe(false);
  });
});

describe("model licences", () => {
  it("gives every profile a licence, and only valid profiles in PREFERENCE", () => {
    for (const p of PROFILES) {
      expect(p.license.name, p.id).toBeTruthy();
      expect(["yes", "no", "restricted"], p.id).toContain(p.license.commercial);
    }
    for (const [op, tiers] of Object.entries(PREFERENCE)) {
      for (const id of [...tiers.quality, ...tiers.lite]) {
        expect(profile(id).operation, id).toBe(op);
        expect(profile(id).optIn, `${id} is opt-in and must not be a preference`).toBeFalsy();
      }
    }
  });

  it("marks restricted and unverified licences opt-in", () => {
    for (const id of ["krea2-turbo", "krea2-style-reference", "flux2-klein-9b"]) expect(profile(id).optIn, id).toBe(true);
    for (const p of PROFILES.filter((x) => x.license.note?.startsWith("unverified"))) expect(p.optIn, p.id).toBe(true);
    expect(profile("qwen21-edit").license).toMatchObject({ name: "Qwen Research License", commercial: "no" });
    expect(profile("flux2-klein-9b").license).toMatchObject({ name: "FLUX Non-Commercial License", commercial: "no" });
    for (const p of PROFILES.filter((x) => x.id.startsWith("minimax-h3"))) expect(p.license).toMatchObject({ name: "MiniMax H3 Community License", commercial: "restricted" });
  });

  it("never returns an opt-in profile as a default, whatever the backend can run", () => {
    for (const op of OPERATIONS) {
      for (const tier of ["quality", "lite"] as const) {
        for (const runnable of [undefined, () => false, (p: { optIn?: boolean }) => Boolean(p.optIn)]) {
          for (const commercial of [false, true]) expect(defaultProfile(op, tier, runnable, { commercial }).optIn, `${op} ${tier}`).toBeFalsy();
        }
      }
    }
  });

  it("skips non-commercial profiles with the commercial switch on", () => {
    expect(defaultProfile("still.compose", "quality", undefined, { commercial: true }).id).toBe("boogu-edit");
    expect(defaultProfile("still.compose", "lite", undefined, { commercial: true }).id).toBe("boogu-edit-turbo");
    expect(defaultProfile("still.compose", "quality", (p) => p.id !== "boogu-edit", { commercial: true }).id).toBe("qwen-edit-2511");
    expect(defaultProfile("still.generate", "quality", (p) => p.id.startsWith("qwen21"), { commercial: true }).id).toBe("z-image-turbo");
    // Restricted licences stay available; they are warned about instead.
    expect(defaultProfile("clip.r2v", "quality", undefined, { commercial: true }).id).toBe("minimax-h3-r2v");
    for (const op of OPERATIONS) {
      for (const tier of ["quality", "lite"] as const) expect(licenseAllows(defaultProfile(op, tier, undefined, { commercial: true }), true), `${op} ${tier}`).toBe(true);
    }
  });

  it("still runs a profile named in the job or the overrides, and warns about it", () => {
    const spec = { operation: "still.compose" as const };
    expect(chooseProfile(spec, { tier: "quality", overrides: {}, commercial: true })).toBe("boogu-edit");
    expect(chooseProfile({ ...spec, profile: "qwen21-edit" }, { tier: "quality", overrides: {}, commercial: true })).toBe("qwen21-edit");
    expect(chooseProfile(spec, { tier: "quality", overrides: { "still.compose": "flux2-klein-9b" }, commercial: true })).toBe("flux2-klein-9b");
    const [warning] = licenseWarnings(["qwen21-edit"], true);
    expect(warning).toContain("Qwen Research License, non-commercial");
    expect(warning).toContain("named explicitly");
    expect(licenseWarnings(["qwen21-edit"], false)[0]).not.toContain("named explicitly");
  });

  it("warns once per restricted profile and never about permissive ones", () => {
    const warnings = licenseWarnings(["minimax-h3-i2v", "minimax-h3-i2v", "wan22-14b-i2v", "boogu-edit", "lens-turbo"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^minimax-h3-i2v: MiniMax H3 Community License, restricted\. .*United States, European Union, United Kingdom and South Korea/);
    expect(warnings[1]).toMatch(/^lens-turbo: .*unverified/);
  });
});
