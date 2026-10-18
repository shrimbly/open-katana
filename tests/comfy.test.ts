import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudBackend, collectOutputs, HttpBackend, onlyUnlistedModels } from "../src/comfy/backend.js";
import { h3Frames, sizeForAspect, wanFrames } from "../src/comfy/graph.js";
import { cancelOpenJobs, chooseProfile, type JobRecord, submitJobs, waitJobs } from "../src/comfy/jobs.js";
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
      // An upscale given a clip's frames (controlImage) saves a video, like the clips.
      expect(classes).toContain(p.operation.startsWith("clip") || p.operation === "upscale" ? "SaveVideo" : "SaveImage");
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
    const depth = build("wan22-14b-fun-control", { ...params, controlMode: "depth", depthModel: "da3" });
    expect(Object.values(depth.prompt).map((n) => (n as { class_type: string }).class_type)).toContain("DA3Inference");
  });

  it("read depth with Marigold V2 by default: one deterministic step, near as bright", () => {
    const nodes = Object.values(build("minimax-h3-motion", { ...params, controlMode: "depth" }).prompt) as { class_type: string; inputs: Record<string, unknown> }[];
    const classes = nodes.map((n) => n.class_type);
    expect(classes).not.toContain("DA3Inference");
    expect(nodes.find((n) => n.class_type === "MarigoldV2PostProcess")?.inputs.prediction).toBe("depth");
    expect(nodes.find((n) => n.class_type === "ManualSigmas")?.inputs.sigmas).toBe("0.5, 0");
    expect(classes).toContain("DisableNoise");
    expect(nodes.find((n) => n.class_type === "LoraLoaderModelOnly" && n.inputs.lora_name === "marigold_v2_depth_log_stage2.safetensors")).toBeTruthy();
  });

  it("steer H3 reference-to-video with the control frames, the keyframe pinned at frame 0", () => {
    const b = build("minimax-h3-motion-ref", { ...params, images: ["p1.png", "p2.png"], controlMode: "depth", controlStrength: 0.6 });
    const nodes = Object.values(b.prompt) as { class_type: string; inputs: Record<string, unknown> }[];
    expect(nodes.find((n) => n.class_type === "MiniMaxH3FunControlNetApply")?.inputs.strength).toBe(0.6);
    const ref = nodes.find((n) => n.class_type === "MiniMaxH3ReferenceToVideo")!;
    expect(Object.keys(ref.inputs).filter((k) => k.startsWith("ref_images."))).toHaveLength(2);
    expect(nodes.find((n) => n.class_type === "MiniMaxH3AddGuide")?.inputs.frame_idx).toBe(0);
  });

  it("find people before reading their pose, instead of a fixed corner box", () => {
    for (const id of ["wan22-14b-fun-control", "minimax-h3-motion"]) {
      const nodes = Object.values(build(id, { ...params, controlMode: "pose" }).prompt) as { class_type: string; inputs: Record<string, unknown> }[];
      const detect = nodes.find((n) => n.class_type === "RTDETR_detect");
      expect(detect?.inputs, id).toMatchObject({ class_name: "person" });
      // bboxes is a link to the detector, never a literal region.
      expect(Array.isArray(nodes.find((n) => n.class_type === "SDPoseKeypointExtractor")!.inputs.bboxes), id).toBe(true);
    }
  });

  it("run MiniMax H3 at full quality by default and turbo only in the turbo variants", () => {
    const of = (id: string, aspect: number) => {
      const b = build(id, { ...params, aspect });
      const nodes = Object.values(b.prompt) as { class_type: string; inputs: Record<string, unknown> }[];
      return { b, lora: nodes.some((n) => n.class_type === "LoraLoaderModelOnly"), steps: nodes.find((n) => n.class_type === "BasicScheduler")!.inputs.steps };
    };
    // Native canvas: about 1 MP, 768×1344 for vertical edits and 1024×768 for 4:3.
    expect(of("minimax-h3-i2v", 9 / 16)).toMatchObject({ b: { width: 768, height: 1344 }, lora: false, steps: 20 });
    expect(of("minimax-h3-flf", 4 / 3)).toMatchObject({ b: { width: 1024, height: 768 }, lora: false, steps: 20 });
    expect(of("minimax-h3-r2v", 16 / 9)).toMatchObject({ b: { width: 1344, height: 768 }, lora: false, steps: 20 });
    expect(of("minimax-h3-i2v-turbo", 9 / 16)).toMatchObject({ lora: true, steps: 8 });
    expect(of("minimax-h3-flf-turbo", 9 / 16)).toMatchObject({ lora: true, steps: 8 });
    expect(of("minimax-h3-r2v-turbo", 9 / 16)).toMatchObject({ lora: true, steps: 4 });
    // Motion transfer: the turbo LoRA at 6 steps tested best, on the 4:3 native canvas.
    expect(of("minimax-h3-motion", 4 / 3)).toMatchObject({ b: { width: 1024, height: 768 }, lora: true, steps: 6 });
  });

  it("drive Wan Animate 2 straight from the reference frames, with the hero as the identity image", () => {
    const b = build("wan-animate2", { ...params, aspect: 4 / 3, frames: 26 });
    const nodes = Object.values(b.prompt) as { class_type: string; inputs: Record<string, unknown> }[];
    const animate = nodes.find((n) => n.class_type === "WanAnimate2ToVideo")!;
    expect(Array.isArray(animate.inputs.pose_video)).toBe(true);
    expect(Array.isArray(animate.inputs.reference_image)).toBe(true);
    expect(animate.inputs.length).toBe(29);
    expect(nodes.some((n) => n.class_type === "SDPoseKeypointExtractor")).toBe(false);
    expect(b).toMatchObject({ width: 832, height: 624, fps: 24 });
  });
});

describe("clip defaults", () => {
  it("make clips on MiniMax H3 and motion transfer on Wan Animate 2, with Wan 2.2 as the Apache-2.0 fallback", () => {
    expect(defaultProfile("clip.i2v").id).toBe("minimax-h3-i2v");
    expect(defaultProfile("clip.flf").id).toBe("minimax-h3-flf");
    expect(defaultProfile("clip.r2v").id).toBe("minimax-h3-r2v");
    expect(defaultProfile("clip.motion").id).toBe("wan-animate2");
    expect(defaultProfile("clip.i2v", "lite").id).toBe("minimax-h3-i2v-turbo");
    // H3's licence is restricted, not non-commercial: the commercial switch keeps it and warns.
    expect(defaultProfile("clip.i2v", "quality", undefined, { commercial: true }).id).toBe("minimax-h3-i2v");
    // A backend without the H3 nodes falls back to Wan.
    const noH3 = (p: { nodes: string[] }) => !p.nodes.some((n) => n.startsWith("MiniMaxH3"));
    expect(defaultProfile("clip.i2v", "quality", noH3).id).toBe("wan22-14b-i2v");
    expect(defaultProfile("clip.flf", "quality", noH3).id).toBe("wan22-14b-flf");
    expect(defaultProfile("clip.motion", "quality", noH3).id).toBe("wan-animate2");
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
    const { submitted } = await submitJobs(ws, backend, [{ line: "plate1", operation: "still.generate", profile: "z-image-turbo", prompt: "empty rain-wet street at night, no people", takes: 1 }], { tier: "lite", overrides: {} });
    expect(submitted).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain("z_image_turbo_bf16.safetensors");
    const done = await waitJobs(ws, backend, { timeoutSec: 20, intervalSec: 0.05 });
    expect(done[0]!.state).toBe("completed");
    const asset = ws.asset(done[0]!.outputs[0]!);
    expect(asset.role).toBe("generated");
    expect(asset.width).toBe(320);
  });
});

describe("cancelling a project's open jobs", () => {
  let server: Server;
  let url: string;
  const calls: { path: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      calls.push({ path: `${req.method} ${req.url}`, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => server?.close());

  it("cancels only the open jobs on the current target, and is idempotent", async () => {
    const backend = new HttpBackend({ kind: "http", url });
    const ws = await Workspace.create({ title: "cancel", root: await tempDir("ok-proj-") });
    const job = (id: string, state: JobRecord["state"], target: string, promptId?: string): JobRecord => ({
      id, line: id.split("_")[0]!, take: 1, spec: { line: id.split("_")[0]!, operation: "still.generate", prompt: "p", takes: 1 }, profile: "z-image-turbo",
      backend: target, ...(promptId ? { promptId } : {}), state, seed: 1, width: 64, height: 64, estimateSec: 10, submittedAt: "2026-10-17T10:00:00.000Z", outputs: [],
    });
    await ws.writeJson("plan/jobs.json", [
      job("a_t1", "pending", backend.target, "p1"),
      job("b_t1", "running", backend.target, "p2"),
      job("c_t1", "completed", backend.target, "p3"),
      job("d_t1", "pending", "http://elsewhere:8188", "p4"),
      job("e_t1", "error", backend.target, "p5"),
    ]);
    const r = await cancelOpenJobs(ws, backend, "Cancelled in the app");
    expect(r).toEqual({ cancelled: 2, failed: [], otherTarget: 1, unsent: 0 });
    const deletes = calls.filter((c) => c.path === "POST /queue").map((c) => JSON.parse(c.body).delete);
    expect(deletes).toEqual([["p1"], ["p2"]]);
    // Neither was the prompt ComfyUI is running, so nothing is interrupted.
    expect(calls.filter((c) => c.path === "POST /interrupt")).toHaveLength(0);
    const jobs = (await ws.readJson<JobRecord[]>("plan/jobs.json"))!;
    expect(jobs.map((j) => j.state)).toEqual(["cancelled", "cancelled", "completed", "pending", "error"]);
    expect(jobs[0]).toMatchObject({ error: "Cancelled in the app" });
    expect(jobs[0]!.finishedAt).toBeDefined();
    const before = calls.length;
    expect(await cancelOpenJobs(ws, backend)).toEqual({ cancelled: 0, failed: [], otherTarget: 1, unsent: 0 });
    expect(calls.length).toBe(before);
  });
});

describe("cancels that must be confirmed", () => {
  const job = (id: string, state: JobRecord["state"], target: string, over: Partial<JobRecord> = {}): JobRecord => ({
    id, line: id.split("_")[0]!, take: 1, spec: { line: id.split("_")[0]!, operation: "still.generate", prompt: "p", takes: 1 }, profile: "z-image-turbo",
    backend: target, state, seed: 1, width: 64, height: 64, estimateSec: 10, submittedAt: new Date().toISOString(), outputs: [], ...over,
  });
  /** A mock ComfyUI: `running` is the prompt it executes; /history answers after `historyMs`; `status` for every POST. */
  async function mock(o: { running?: string; historyMs?: number; status?: number; promptMs?: number } = {}) {
    const calls: { path: string; body: string }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString();
      calls.push({ path: `${req.method} ${req.url}`, body });
      const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (req.url === "/queue" && req.method === "GET") return json(200, { queue_running: o.running ? [[0, o.running]] : [], queue_pending: [] });
      if (req.url?.startsWith("/history/")) {
        await new Promise((r) => setTimeout(r, o.historyMs ?? 0));
        return json(200, {});
      }
      if (req.url === "/prompt") {
        await new Promise((r) => setTimeout(r, o.promptMs ?? 0));
        return json(200, { prompt_id: JSON.parse(body).prompt_id ?? "server-id" });
      }
      if (req.url === "/object_info") return json(200, {});
      json(o.status ?? 200, {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("interrupts only the prompt ComfyUI is running, by its id", async () => {
    const m = await mock({ running: "p2" });
    try {
      const backend = new HttpBackend({ kind: "http", url: m.url });
      await backend.cancel("p1");
      expect(m.calls.filter((c) => c.path === "POST /interrupt")).toHaveLength(0);
      await backend.cancel("p2");
      const interrupts = m.calls.filter((c) => c.path === "POST /interrupt");
      expect(interrupts.map((c) => JSON.parse(c.body))).toEqual([{ prompt_id: "p2" }]);
    } finally {
      await m.close();
    }
  });

  it("keeps jobs open and reports them when the backend can't confirm the cancel", async () => {
    const m = await mock({ status: 500 });
    const ws = await Workspace.create({ title: "cancel-fails", root: await tempDir("ok-proj-") });
    try {
      for (const backend of [new HttpBackend({ kind: "http", url: m.url }), new HttpBackend({ kind: "http", url: "http://127.0.0.1:9" }), new CloudBackend({ kind: "cloud", url: m.url, apiKey: "k" })]) {
        await ws.writeJson("plan/jobs.json", [job("a_t1", "pending", backend.target, { promptId: "p1" }), job("b_t1", "running", backend.target, { promptId: "p2" })]);
        const r = await cancelOpenJobs(ws, backend);
        expect(r.cancelled, backend.target).toBe(0);
        expect(r.failed.map((f) => f.id)).toEqual(["a_t1", "b_t1"]);
        expect((await ws.readJson<JobRecord[]>("plan/jobs.json"))!.map((j) => j.state)).toEqual(["pending", "running"]);
      }
    } finally {
      await m.close();
    }
  });

  it("a cloud job that is already gone counts as cancelled", async () => {
    const m = await mock({ status: 404 });
    try {
      const backend = new CloudBackend({ kind: "cloud", url: m.url, apiKey: "k" });
      const ws = await Workspace.create({ title: "cancel-gone", root: await tempDir("ok-proj-") });
      await ws.writeJson("plan/jobs.json", [job("a_t1", "pending", backend.target, { promptId: "p1" })]);
      expect((await cancelOpenJobs(ws, backend)).cancelled).toBe(1);
    } finally {
      await m.close();
    }
  });

  it("a wait in progress doesn't undo a cancel (its save merges)", async () => {
    const m = await mock({ historyMs: 400 });
    try {
      const backend = new HttpBackend({ kind: "http", url: m.url });
      const ws = await Workspace.create({ title: "race", root: await tempDir("ok-proj-") });
      await ws.writeJson("plan/jobs.json", ["a_t1", "b_t1", "c_t1"].map((id, i) => job(id, "pending", backend.target, { promptId: `p${i}` })));
      const waiting = waitJobs(ws, backend, { timeoutSec: 2, intervalSec: 0.1 });
      await new Promise((r) => setTimeout(r, 200));
      expect((await cancelOpenJobs(ws, backend)).cancelled).toBe(3);
      const seen = await waiting;
      expect(seen.map((j) => j.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
      expect((await ws.readJson<JobRecord[]>("plan/jobs.json"))!.map((j) => j.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    } finally {
      await m.close();
    }
  });

  it("an aborted wait stops polling", async () => {
    const m = await mock();
    try {
      const backend = new HttpBackend({ kind: "http", url: m.url });
      const ws = await Workspace.create({ title: "abort", root: await tempDir("ok-proj-") });
      await ws.writeJson("plan/jobs.json", [job("a_t1", "pending", backend.target, { promptId: "p1" })]);
      const ac = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ac.abort(), 150);
      await waitJobs(ws, backend, { timeoutSec: 30, intervalSec: 0.05, signal: ac.signal });
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      await m.close();
    }
  });

  it("records a job before its submit returns, under the prompt id it asks ComfyUI to use", async () => {
    const m = await mock({ promptMs: 500 });
    try {
      const backend = new HttpBackend({ kind: "http", url: m.url });
      const ws = await Workspace.create({ title: "sending", root: await tempDir("ok-proj-") });
      const submitting = submitJobs(ws, backend, [{ line: "plate1", operation: "still.generate", prompt: "empty street", takes: 1 }], { tier: "lite", overrides: {} });
      await new Promise((r) => setTimeout(r, 250));
      const during = (await ws.readJson<JobRecord[]>("plan/jobs.json"))!;
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({ id: "plate1_t1", state: "pending" });
      expect(during[0]!.promptId).toBeUndefined();
      const asked = during[0]!.sending!;
      expect(asked).toMatch(/^[0-9a-f-]{36}$/);
      const { submitted } = await submitting;
      expect(submitted[0]!.promptId).toBe(asked);
      expect(JSON.parse(m.calls.find((c) => c.path === "POST /prompt")!.body).prompt_id).toBe(asked);
      const after = (await ws.readJson<JobRecord[]>("plan/jobs.json"))!;
      expect(after[0]).toMatchObject({ promptId: asked });
      expect(after[0]!.sending).toBeUndefined();
    } finally {
      await m.close();
    }
  });

  it("a job left mid-submit by a process that died is cancelled by the id it asked for", async () => {
    const m = await mock();
    try {
      const backend = new HttpBackend({ kind: "http", url: m.url });
      const ws = await Workspace.create({ title: "orphan", root: await tempDir("ok-proj-") });
      await ws.writeJson("plan/jobs.json", [job("a_t1", "pending", backend.target, { sending: "0b8a3c9e-1111-4222-8333-944455556666" })]);
      const r = await cancelOpenJobs(ws, backend);
      expect(r.cancelled).toBe(1);
      expect(m.calls.filter((c) => c.path === "POST /queue").map((c) => JSON.parse(c.body).delete)).toEqual([["0b8a3c9e-1111-4222-8333-944455556666"]]);
      // On a backend that picks its own ids it can't be reached: it is reported, not claimed cancelled.
      const cloud = new CloudBackend({ kind: "cloud", url: m.url, apiKey: "k" });
      await ws.writeJson("plan/jobs.json", [job("b_t1", "pending", cloud.target, { sending: "0b8a3c9e-1111-4222-8333-944455556667" })]);
      expect(await cancelOpenJobs(ws, cloud)).toMatchObject({ cancelled: 0, unsent: 1 });
      expect((await ws.readJson<JobRecord[]>("plan/jobs.json"))![0]!.state).toBe("error");
    } finally {
      await m.close();
    }
  });
});

describe("still models", () => {
  it("defaults to the tested best model and falls back to what the backend can run", () => {
    expect(defaultProfile("still.compose").id).toBe("qwen21-edit");
    expect(defaultProfile("still.face").id).toBe("face-crop");
    // Plates share the keyframe model's weights; Z-Image Turbo is the fallback (and the commercial pick).
    expect(defaultProfile("still.generate").id).toBe("qwen21");
    expect(defaultProfile("still.generate", "lite").id).toBe("qwen21-turbo");
    expect(defaultProfile("still.generate", "quality", undefined, { commercial: true }).id).toBe("z-image-turbo");
    expect(profile("qwen21").models).toEqual(profile("qwen21-edit").models);
    expect(defaultProfile("still.compose", "lite").id).toBe("qwen21-turbo-edit");
    expect(defaultProfile("still.compose", "quality", (p) => !p.id.startsWith("qwen21")).id).toBe("boogu-edit");
    expect(defaultProfile("still.generate", "quality", (p) => !p.id.startsWith("qwen21") && p.id !== "z-image-turbo").id).toBe("ernie-image-turbo");
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
    // ModelPatchLoader's input is just "name": the H3 Fun ControlNet patch is unlisted on Comfy Cloud but runs.
    expect(onlyUnlistedModels(err("comfy run: workflow_unknown_nodes — Workflow has 1 validation error(s) against cloud (node 6: 'minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors' not in 26 known options for name — closest: x)"))).toBe(true);
    // Qwen-Image 2.1 text-to-image leaves the encoder's image inputs empty, as Comfy's own template does.
    expect(onlyUnlistedModels(err("comfy run: workflow_unknown_nodes — (node 1: 'qwen_image_2.1_int8_convrot.safetensors' not in 377 known options for unet_name — closest: x\nnode 5: required autogrow input 'images' has no connected slots — the server will reject this node)"))).toBe(true);
    // A non-model value that isn't allowed is a real error.
    expect(onlyUnlistedModels(err("comfy run: workflow_unknown_nodes — (node 4: 'banana' not in 3 known options for sampler_name — closest: euler)"))).toBe(false);
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
