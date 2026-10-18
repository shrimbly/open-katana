import { randomInt, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { sampleSheet } from "../engine/sheets.js";
import type { Workspace } from "../project/workspace.js";
import { dataHome } from "../util/paths.js";
import { run } from "../util/proc.js";
import type { Backend, ModelChoices, OutputFile } from "./backend.js";
import { CameraMoveSchema, writeCameraClip } from "./camera.js";
import { sizeForAspect } from "./graph.js";
import { CONTROL_MODES, type ControlMode, DEPTH_MODELS, buildControlPreview, clipFrames, type Operation, OPERATIONS, type Profile, build, defaultProfile, estimateSeconds, h3LongSide, licenseWarnings, profile } from "./operations.js";
import { checkProfile, resolveModels } from "./resolve.js";

export const MotionSourceSchema = z.object({
  /** Asset holding the driving motion (default: the reference video). */
  asset: z.string().default("ref"),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  /**
   * pose: skeletons (people; keeps the hero's identity). depth: depth maps (shape, parallax).
   * edges: edge maps (camera path and layout of shots without people; edges copy the source's
   * faces and logos, so never use them on a person you are replacing).
   */
  control: z.enum(CONTROL_MODES).default("pose"),
  /**
   * "realtime" (default) keeps the source's speed: the clip is as long as the source span, rounded up
   * to the model's frame rule, and any extra frames replay the move backwards (never slowed down).
   * "stretch" spreads the source motion over the whole generated clip (slow motion, for a slow-mo
   * beat); "hold" freezes its last frame.
   */
  fit: z.enum(["realtime", "stretch", "hold"]).default("realtime"),
  /**
   * Region of the source to keep, as fractions of its width and height, when the performer is small
   * in the frame (a scope, a wide shot): the crop is scaled up to the output, so pose detection and
   * the generated framing both follow the performer.
   */
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) }).optional(),
  /** Which model reads depth for `control: "depth"`: Marigold V2 (default, sharper) or Depth Anything 3 (lighter download). */
  depth: z.enum(DEPTH_MODELS).optional(),
  /** How hard the control steers (default 1). About 0.6 for depth when the reference's subject has a different shape. */
  strength: z.number().min(0.1).max(2).optional(),
});

export const JobSpecSchema = z.object({
  line: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i, "line ids are short slugs like key1, plate-street, v3"),
  operation: z.enum(OPERATIONS),
  profile: z.string().optional(),
  prompt: z.string().min(1),
  negative: z.string().optional(),
  /**
   * Images in reference order (image1 is the canvas/style owner for still.compose): asset ids,
   * "@<line>" for that line's accepted output, or a frame of a video: "ref@f42" (frame) / "ref@2.1" (seconds).
   */
  images: z.array(z.string()).max(9).optional(),
  /** First frame for clips: asset id, "@<line>" or a video frame ("ref@f42"). */
  start: z.string().optional(),
  end: z.string().optional(),
  motion: MotionSourceSchema.optional(),
  /**
   * clip.motion without a source shot: a real camera move (orbit, arc, push-in with parallax) made from the
   * start keyframe's own depth. Use it instead of a still with a zoom whenever the reference's camera
   * travels around or toward the subject. Takes `start`, not `motion`.
   */
  camera: CameraMoveSchema.optional(),
  /** Seconds of video to generate (clips). The edit picks in-points from it. */
  durationSec: z.number().positive().max(10).optional(),
  /** Output aspect (width/height); defaults to the reference's. */
  aspect: z.number().positive().optional(),
  longSide: z.number().int().min(256).max(2048).optional(),
  seed: z.number().int().nonnegative().optional(),
  takes: z.number().int().min(1).max(4).default(1),
});
export type JobSpec = z.infer<typeof JobSpecSchema>;

export const JobRecordSchema = z.object({
  id: z.string(),
  line: z.string(),
  take: z.number(),
  spec: JobSpecSchema,
  profile: z.string(),
  backend: z.string(),
  promptId: z.string().optional(),
  /**
   * Set while the submit is on its way: the prompt id this process asked the backend to use. The record is
   * saved before the submit, so a process killed mid-submit still leaves a job the cancel sweep can find.
   */
  sending: z.string().optional(),
  state: z.enum(["pending", "running", "completed", "error", "cancelled"]),
  seed: z.number(),
  width: z.number(),
  height: z.number(),
  frames: z.number().optional(),
  fps: z.number().optional(),
  estimateSec: z.number(),
  submittedAt: z.string(),
  finishedAt: z.string().optional(),
  outputs: z.array(z.string()).default([]),
  error: z.string().optional(),
  substituted: z.record(z.string(), z.string()).optional(),
  /** Times the job was sent again, unchanged, after a server error that isn't about its inputs. */
  retries: z.number().int().nonnegative().optional(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

/**
 * Server errors that come and go on Comfy Cloud and aren't about the job's inputs: the same graph runs
 * when sent again. MiniMax H3's conditioning nodes sometimes fail with a tensor-size mismatch on a busy
 * worker (four failed in clusters in one edit, and the identical graphs then ran four times out of four),
 * and a token can expire mid-run.
 */
const TRANSIENT_ERRORS = [/size of tensor a \(\d+\) must match the size of tensor b \(\d+\)[\s\S]*MiniMaxH3|MiniMaxH3[\s\S]*size of tensor a \(\d+\) must match/i, /Unauthorized: Please login first to use this node/i];
const MAX_RETRIES = 1;

export function isTransientError(error: string | undefined): boolean {
  return Boolean(error && TRANSIENT_ERRORS.some((r) => r.test(error)));
}

const promptFile = (ws: Workspace, jobId: string) => ws.path("gen", "prompts", `${jobId}.json`);

const JOBS = "plan/jobs.json";
const UPLOADS = "plan/uploads.json";

export async function loadJobs(ws: Workspace): Promise<JobRecord[]> {
  return (await ws.readJson(JOBS, z.array(JobRecordSchema))) ?? [];
}

async function saveJobs(ws: Workspace, jobs: JobRecord[]): Promise<void> {
  await ws.writeJson(JOBS, jobs);
}

// jobs.json is read, changed and saved under one queue per project in this process: katana_cancel can run
// while a katana_wait pass is polling, and neither may save over the other's changes. Network calls
// (submits, polls, cancels, downloads) happen outside the queue; only the read-merge-save is inside.
const jobQueues = new Map<string, Promise<unknown>>();

async function updateJobs<T>(ws: Workspace, fn: (jobs: JobRecord[]) => T): Promise<T> {
  const key = ws.dir;
  const before = jobQueues.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(async () => {
    const jobs = await loadJobs(ws);
    const out = fn(jobs);
    await saveJobs(ws, jobs);
    return out;
  });
  const settled = mine.catch(() => undefined);
  jobQueues.set(key, settled);
  void settled.then(() => {
    if (jobQueues.get(key) === settled) jobQueues.delete(key);
  });
  return mine;
}

const isOpen = (j: Pick<JobRecord, "state">) => j.state === "pending" || j.state === "running";

/** Submits this process has on their way (their `sending` ids). */
const sendingNow = new Set<string>();

/** A placeholder left by a process that died mid-submit is given up after this long. */
const STALE_SEND_MS = 10 * 60_000;

/** Uploads an asset to the backend once; later calls reuse the server-side name. */
export async function ensureUploaded(ws: Workspace, backend: Backend, file: string, key: string): Promise<string> {
  const cache = (await ws.readJson<Record<string, string>>(UPLOADS)) ?? {};
  const stamp = statSync(file).mtimeMs.toFixed(0);
  const cacheKey = `${backend.target}|${key}|${stamp}`;
  const hit = cache[cacheKey];
  if (hit) return hit;
  const name = await backend.upload(file);
  cache[cacheKey] = name;
  await ws.writeJson(UPLOADS, cache);
  return name;
}

/**
 * Cuts the driving motion out of a source clip as an animated WebP at the model's frame rate.
 * ComfyUI's LoadImage decodes every frame of it into one IMAGE batch.
 */
export async function makeControlClip(
  input: string,
  out: string,
  opts: {
    startSec: number; endSec: number; fps: number; frames: number; width: number; height: number;
    control: ControlMode | "raw"; fit: "realtime" | "stretch" | "hold"; crop?: { x: number; y: number; w: number; h: number };
    /** WebP quality (default 75; control maps need no more, frames to upscale do). */
    quality?: number;
  },
): Promise<string> {
  const span = Math.max(1 / opts.fps, opts.endSec - opts.startSec);
  const target = opts.frames / opts.fps;
  const c = opts.crop;
  const head = [
    ...(c ? [`crop=iw*${c.w.toFixed(4)}:ih*${c.h.toFixed(4)}:iw*${c.x.toFixed(4)}:ih*${c.y.toFixed(4)}`] : []),
    ...(opts.fit === "stretch" ? [`setpts=PTS*${(target / span).toFixed(6)}`] : []),
    `fps=${opts.fps}`,
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase`,
    `crop=${opts.width}:${opts.height}`,
    ...(opts.control === "edges" ? ["edgedetect=low=0.08:high=0.3"] : []),
  ].join(",");
  // realtime: the move at its own speed, then back and forth (forward, reversed without its two
  // turning frames, …) until the model's frame count is reached: no frame is slowed down or frozen.
  // Faint temporal noise keeps every frame distinct: the animated-WebP encoder merges identical frames,
  // which would shorten the control video (held frames, still sources) and break its timing.
  const sourceFrames = Math.max(1, Math.round(span * opts.fps));
  const cycle = Math.max(1, 2 * sourceFrames - 2);
  const tail = "noise=alls=2:allf=t,format=rgb24";
  const graph =
    opts.fit === "realtime" && opts.frames > sourceFrames && sourceFrames > 2
      ? `[0:v]${head},trim=end_frame=${sourceFrames},split[f][b];[b]reverse,trim=start_frame=1:end_frame=${sourceFrames - 1}[r];[f][r]concat=n=2:v=1:a=0,loop=loop=${Math.ceil(opts.frames / cycle)}:size=${cycle},${tail}[v]`
      : `[0:v]${head}${opts.fit === "hold" || opts.fit === "realtime" ? `,tpad=stop_mode=clone:stop=${opts.frames}` : ""},${tail}[v]`;
  await mkdir(join(out, ".."), { recursive: true });
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-ss", String(opts.startSec), "-t", String(span), "-i", input,
    "-filter_complex", graph, "-map", "[v]",
    "-frames:v", String(opts.frames),
    "-loop", "0", "-lossless", "0", "-q:v", String(opts.quality ?? 75),
    out,
  ]);
  return out;
}

/**
 * Seconds of picture a clip job asks for. A realtime motion job is exactly as long as the source
 * span it re-performs; everything else uses its durationSec (default 2 s).
 */
export function clipSeconds(spec: Pick<JobSpec, "operation" | "durationSec" | "motion">): number {
  const m = spec.motion;
  if (spec.operation === "clip.motion" && m && m.fit === "realtime") return Math.max(0.05, m.endSec - m.startSec);
  return spec.durationSec ?? 2;
}

function referenceAspect(ws: Workspace): number {
  const ref = ws.reference();
  return ref?.width && ref.height ? ref.width / ref.height : 9 / 16;
}

export interface ProfileChoice {
  tier: "quality" | "lite";
  overrides: Record<string, string>;
  /** config.commercial: defaults skip non-commercial profiles. A profile named in the job or overrides still wins. */
  commercial?: boolean;
  catalog?: { nodes: Set<string>; models: ModelChoices };
  onDemandModels?: boolean;
}

/** The kind of control frames a clip.motion job sends: a camera move, or its motion source's control. */
export function motionControl(spec: Partial<Pick<JobSpec, "operation" | "motion" | "camera">>): "pose" | "depth" | "edges" | "camera" | undefined {
  if (spec.operation !== "clip.motion") return undefined;
  return spec.camera ? "camera" : spec.motion?.control;
}

/** The profile a job runs on: the job's own, then the configured override, then the default. */
export function chooseProfile(spec: Pick<JobSpec, "operation" | "profile"> & Partial<Pick<JobSpec, "motion" | "camera">>, opts: ProfileChoice): string {
  const { catalog, onDemandModels } = opts;
  // On Comfy Cloud, model files load on demand: a profile only needs its nodes.
  const runnable = catalog ? (p: Profile) => (onDemandModels ? checkProfile(p, catalog).missingNodes.length === 0 : checkProfile(p, catalog).runnable) : undefined;
  const control = motionControl(spec);
  const override = opts.overrides[spec.operation];
  const fits = (id: string | undefined) => {
    const c = id ? profile(id).controls : undefined;
    return !control || !c || c.includes(control);
  };
  if (spec.profile) return spec.profile;
  if (override && fits(override)) return override;
  return defaultProfile(spec.operation as Operation, opts.tier, runnable, { commercial: opts.commercial, control }).id;
}

/** GPU seconds of the depth pass a camera move makes on its keyframe first. */
const CAMERA_DEPTH_SEC = 20;

/**
 * Estimate (seconds of GPU time, all takes) for a spec on a profile without submitting anything. Pure:
 * `aspect` is used when the spec has none (the reference's, or the template's format).
 */
export function estimateSpecFor(spec: JobSpec, profileId: string, aspect: number): { seconds: number; width: number; height: number; frames?: number } {
  const prof = profile(profileId);
  const a = spec.aspect ?? aspect;
  const { width, height } = sizeForAspect(a, spec.longSide ?? (prof.frames === "h3" ? h3LongSide(a, prof.longSide) : prof.longSide), prof.sizeStep);
  // An upscale keeps its clip's frames: durationSec says how long the clip is (no duration: a still).
  const frames = prof.fps ? clipFrames(prof, Math.round(clipSeconds(spec) * prof.fps)) : spec.operation === "upscale" && spec.durationSec ? Math.round(spec.durationSec * 24) : undefined;
  return { seconds: estimateSeconds(profileId, { width, height, frames }) * spec.takes + (spec.camera ? CAMERA_DEPTH_SEC : 0), width, height, frames };
}

/** Estimate (seconds of GPU time) for a spec in a project without submitting anything. */
export function estimateSpec(ws: Workspace, spec: JobSpec, profileId: string): { seconds: number; width: number; height: number; frames?: number } {
  if (spec.operation === "upscale" && spec.start) {
    // The source sets the shape and, for a clip, the frame count.
    const src = ws.project.assets.find((a) => a.id === spec.start);
    if (src?.width && src.height) {
      const prof = profile(profileId);
      const { width, height } = sizeForAspect(src.width / src.height, spec.longSide ?? prof.longSide, prof.sizeStep);
      const frames = src.kind === "video" ? (src.frameCount ?? Math.round((src.durationSec ?? 2) * (src.fps ?? 24))) : undefined;
      return { seconds: estimateSeconds(profileId, { width, height, frames }) * spec.takes, width, height, frames };
    }
  }
  return estimateSpecFor(spec, profileId, referenceAspect(ws));
}

/**
 * GPU seconds as the budget counts them: the raw estimate scaled by the measured timing ratio for
 * this target and profile, plus the fixed per-take overhead of the backend kind. One function for
 * katana_plan, the katana_generate gate and the app's estimate.
 */
export function adjustedSeconds(rawSec: number, takes: number, o: { ratio: number; kind: string }): number {
  return rawSec * o.ratio + (JOB_OVERHEAD_SEC[o.kind] ?? 0) * takes;
}

/** Measured actual/estimated GPU time for a target and profile (1 until a job has finished there). */
export async function timingRatio(target: string, profileId: string): Promise<number> {
  const file = join(dataHome(), "timings.json");
  if (!existsSync(file)) return 1;
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as Record<string, { n: number; ratio: number }>;
    return data[`${target}|${profileId}`]?.ratio ?? 1;
  } catch {
    return 1;
  }
}

// Shutdown drain (spec §10.6): on SIGTERM the MCP server stops submitting, waits for the submits in
// flight to reach jobs.json, then exits, so the app's cancel sweep sees every job that was queued.
let shuttingDown = false;
let inFlight = 0;

export function beginShutdown(): void {
  shuttingDown = true;
}

export const isShuttingDown = (): boolean => shuttingDown;

/** Submits sent to the backend whose job record is not saved yet. */
export const inFlightSubmits = (): number => inFlight;

export interface SubmitResult {
  submitted: JobRecord[];
  warnings: string[];
}

/**
 * The Marigold V2 depth of an uploaded keyframe, for camera moves: one short job, waited for here and
 * cached in gen/control by the upload's name. It isn't a take in jobs.json (it takes about 20 s).
 */
async function keyframeDepth(ws: Workspace, backend: Backend, uploaded: string, models?: ModelChoices): Promise<string> {
  const file = ws.path("gen", "control", `depth-${uploaded.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.png`);
  if (existsSync(file)) return file;
  let prompt = buildControlPreview({ controlImage: uploaded, controlMode: "depth", depthModel: "marigold", kind: "image", filenamePrefix: `open-katana/${ws.project.id}/depth` }).prompt as Record<string, never>;
  if (models) prompt = resolveModels(prompt, models).prompt as Record<string, never>;
  const id = await backend.submit(prompt);
  const until = Date.now() + 10 * 60_000;
  for (;;) {
    if (shuttingDown) {
      await backend.cancel(id).catch(() => undefined);
      throw new Error("[STOPPED] Stopped in the app.");
    }
    const poll = await backend.poll(id);
    if (poll.state === "completed") {
      const out = poll.outputs.find((o) => /\.png$/i.test(o.filename)) ?? poll.outputs[0];
      if (!out) throw new Error("The depth pass for a camera move returned no image.");
      await mkdir(join(file, ".."), { recursive: true });
      await backend.download(out, file);
      return file;
    }
    if (poll.state === "error" || poll.state === "cancelled") throw new Error(`The depth pass for a camera move failed: ${poll.error ?? poll.state}`);
    if (Date.now() > until) {
      await backend.cancel(id).catch(() => undefined);
      throw new Error("The depth pass for a camera move took over 10 minutes.");
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export async function submitJobs(ws: Workspace, backend: Backend, specs: JobSpec[], opts: { tier: "quality" | "lite"; overrides: Record<string, string>; commercial?: boolean }): Promise<SubmitResult> {
  const submitted: JobRecord[] = [];
  const catalog = await backend.catalog().catch(() => undefined);
  const chosen = specs.map((spec) => chooseProfile(spec, { ...opts, catalog, onDemandModels: backend.onDemandModels }));
  const warnings = licenseWarnings(chosen, opts.commercial);

  for (const [i, spec] of specs.entries()) {
    const profileId = chosen[i]!;
    const prof = profile(profileId);
    if (prof.operation !== spec.operation) throw new Error(`Profile ${profileId} does ${prof.operation}, not ${spec.operation}`);
    const upscaleSource = spec.operation === "upscale" ? (spec.start ? ws.asset(spec.start) : undefined) : undefined;
    if (spec.operation === "upscale" && !upscaleSource) throw new Error(`Line ${spec.line}: upscale needs start (the accepted clip or still to upscale)`);
    const aspect = spec.aspect ?? (upscaleSource?.width && upscaleSource.height ? upscaleSource.width / upscaleSource.height : referenceAspect(ws));
    const { width, height } = sizeForAspect(aspect, spec.longSide ?? (prof.frames === "h3" ? h3LongSide(aspect, prof.longSide) : prof.longSide), prof.sizeStep);
    const fps = prof.fps;
    const frames = fps ? clipFrames(prof, Math.round(clipSeconds(spec) * fps)) : undefined;

    const upload = async (assetId: string) => ensureUploaded(ws, backend, ws.assetPath(assetId), assetId);
    const images = await Promise.all((spec.images ?? []).map(upload));
    // A clip to upscale goes up as its frames (below), not as the video file.
    const startImage = spec.start && upscaleSource?.kind !== "video" ? await upload(spec.start) : undefined;
    const endImage = spec.end ? await upload(spec.end) : undefined;
    let controlImage: string | undefined;
    let matteFps: number | undefined;
    let matteFrames: number | undefined;
    if (spec.operation === "matte" && spec.start && ws.asset(spec.start).kind === "video") {
      // Video matte: send every frame of the clip, at its own rate and size, so the mask lines up 1:1.
      const clip = ws.asset(spec.start);
      matteFps = Math.min(30, Math.round(clip.fps ?? 16));
      matteFrames = Math.min(241, Math.max(1, Math.round((clip.durationSec ?? 1) * matteFps)));
      const scale = Math.min(1, 832 / Math.max(clip.width ?? 832, clip.height ?? 832));
      const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
      const frames = ws.path("gen", "control", `${spec.line}-frames.webp`);
      await makeControlClip(ws.assetPath(clip.id), frames, {
        startSec: 0, endSec: clip.durationSec ?? 1, fps: matteFps, frames: matteFrames,
        width: even(clip.width ?? 832), height: even(clip.height ?? 832), control: "raw", fit: "hold",
      });
      controlImage = await ensureUploaded(ws, backend, frames, `matte:${clip.id}:${matteFps}`);
    }
    if (upscaleSource?.kind === "video") {
      // Every frame at the clip's own size and rate, so the upscaled copy lines up with it frame for frame.
      const clip = upscaleSource;
      matteFps = clip.fps ?? 24;
      matteFrames = clip.frameCount ?? Math.max(1, Math.round((clip.durationSec ?? 1) * matteFps));
      const frames = ws.path("gen", "control", `${spec.line}-source.webp`);
      await makeControlClip(ws.assetPath(clip.id), frames, {
        startSec: 0, endSec: clip.durationSec ?? 1, fps: matteFps, frames: matteFrames,
        width: Math.round((clip.width ?? 576) / 2) * 2, height: Math.round((clip.height ?? 1024) / 2) * 2, control: "raw", fit: "hold", quality: 95,
      });
      controlImage = await ensureUploaded(ws, backend, frames, `upscale:${clip.id}:${statSync(ws.assetPath(clip.id)).mtimeMs}`);
    }
    if (spec.operation === "clip.motion" && spec.camera) {
      if (spec.motion) throw new Error(`Line ${spec.line}: give clip.motion either motion (a reference shot's move) or camera (a camera move), not both`);
      if (!startImage) throw new Error(`Line ${spec.line}: a camera move needs start (the keyframe it moves around)`);
      const depth = await keyframeDepth(ws, backend, startImage, catalog?.models);
      const ctrl = ws.path("gen", "control", `${spec.line}-camera.webp`);
      await writeCameraClip(depth, ctrl, { move: spec.camera, frames: frames ?? 33, fps: fps ?? 24, width, height });
      const c = spec.camera;
      controlImage = await ensureUploaded(ws, backend, ctrl, `camera:${spec.line}:${startImage}:${c.orbit}:${c.arc}:${c.push}:${c.ease}:${frames}:${width}x${height}`);
    } else if (spec.operation === "clip.motion") {
      if (!spec.motion) throw new Error(`Line ${spec.line}: clip.motion needs motion {startSec, endSec} (a reference shot's move) or camera (a camera move)`);
      const m = spec.motion;
      const ctrl = ws.path("gen", "control", `${spec.line}.webp`);
      await makeControlClip(ws.assetPath(m.asset), ctrl, { ...m, fps: fps ?? 16, frames: frames ?? 33, width, height });
      controlImage = await ensureUploaded(ws, backend, ctrl, `control:${spec.line}:${m.asset}:${m.startSec}-${m.endSec}:${m.control}:${m.fit}:${frames}:${m.crop ? Object.values(m.crop).join(",") : ""}`);
    }

    for (let take = 1; take <= spec.takes; take++) {
      // The submit and the save that records it are one unit for the shutdown drain.
      if (shuttingDown) throw new Error("[STOPPED] Stopped in the app.");
      const sendId = randomUUID();
      inFlight++;
      sendingNow.add(sendId);
      try {
        // The take is numbered, built and recorded (as being sent) before the submit, so a Stop that kills
        // this process mid-submit still finds the job in jobs.json.
        const { record, prompt } = await updateJobs(ws, (jobs) => {
          const takeNo = Math.max(0, ...jobs.filter((j) => j.line === spec.line).map((j) => j.take)) + 1;
          const seed = spec.seed !== undefined ? spec.seed + take - 1 : randomInt(0, 2 ** 31);
          const built = build(profileId, {
            prompt: spec.prompt,
            negative: spec.negative,
            seed,
            aspect,
            longSide: spec.longSide,
            images,
            startImage,
            endImage,
            controlImage,
            controlMode: spec.camera ? undefined : spec.motion?.control,
            controlStrength: spec.camera?.strength ?? spec.motion?.strength,
            depthModel: spec.motion?.depth,
            frames: matteFrames ?? frames,
            fps: matteFps,
            filenamePrefix: `open-katana/${ws.project.id}/${spec.line}_t${takeNo}`,
          });
          let prompt = built.prompt as Record<string, never>;
          let substituted: Record<string, string> | undefined;
          if (catalog) {
            const r = resolveModels(prompt, catalog.models);
            if (r.missing.length && !backend.onDemandModels) {
              throw new Error(`Line ${spec.line}: ${backend.target} lacks ${r.missing.map((m) => m.name).join(", ")}. Run katana_backend to see download links, or choose another profile.`);
            }
            prompt = r.prompt as Record<string, never>;
            substituted = Object.keys(r.substituted).length ? r.substituted : undefined;
          }
          const record: JobRecord = {
            id: `${spec.line}_t${takeNo}`,
            line: spec.line,
            take: takeNo,
            spec,
            profile: profileId,
            backend: backend.target,
            sending: sendId,
            state: "pending",
            seed,
            width: built.width,
            height: built.height,
            frames: built.frames,
            fps: built.fps,
            estimateSec: estimateSeconds(profileId, { width: built.width, height: built.height, frames: built.frames }),
            submittedAt: new Date().toISOString(),
            outputs: [],
            substituted,
          };
          jobs.push(record);
          return { record, prompt };
        });
        // Kept so a server error that isn't about the inputs can be sent again unchanged.
        await mkdir(join(promptFile(ws, record.id), ".."), { recursive: true });
        await writeFile(promptFile(ws, record.id), JSON.stringify(prompt));
        let promptId: string;
        try {
          promptId = await backend.submit(prompt, { promptId: sendId });
        } catch (e) {
          // Never queued: the placeholder goes.
          await updateJobs(ws, (jobs) => {
            const i = jobs.findIndex((j) => j.id === record.id && j.sending === sendId);
            if (i >= 0) jobs.splice(i, 1);
          });
          throw e;
        }
        const saved = await updateJobs(ws, (jobs) => {
          const j = jobs.find((x) => x.id === record.id && x.sending === sendId);
          if (!j) return undefined;
          j.promptId = promptId;
          delete j.sending;
          return { ...j };
        });
        // Cancelled while it was on its way (katana_cancel in the same session): cancel it now it has an id.
        if (saved?.state === "cancelled") await backend.cancel(promptId).catch(() => undefined);
        const done = saved ?? { ...record, promptId, sending: undefined };
        submitted.push(done);
      } finally {
        sendingNow.delete(sendId);
        inFlight--;
      }
    }
  }
  return { submitted, warnings };
}

/** Fixed per-job cost of queueing, uploads and downloads, by backend kind (seconds). */
export const JOB_OVERHEAD_SEC: Record<string, number> = { http: 3, cloud: 15, "comfy-cli": 20 };

async function recordTiming(target: string, profileId: string, estimateSec: number, actualSec: number): Promise<void> {
  const file = join(dataHome(), "timings.json");
  const data: Record<string, { n: number; ratio: number }> = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  const key = `${target}|${profileId}`;
  const prev = data[key] ?? { n: 0, ratio: 1 };
  const ratio = actualSec / Math.max(1, estimateSec);
  data[key] = { n: prev.n + 1, ratio: (prev.ratio * prev.n + ratio) / (prev.n + 1) };
  await mkdir(dataHome(), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

async function collect(ws: Workspace, backend: Backend, job: JobRecord, files: OutputFile[]): Promise<string[]> {
  const ids: string[] = [];
  const dir = ws.path("gen", job.line);
  await mkdir(dir, { recursive: true });
  const media = files.filter((f) => /\.(png|jpe?g|webp|mp4|webm|mov|gif)$/i.test(f.filename));
  for (const [i, file] of media.entries()) {
    const ext = extname(file.filename).toLowerCase() || ".bin";
    const dest = join(dir, `${job.id}${media.length > 1 ? `_${i + 1}` : ""}${ext}`);
    await backend.download({ ...file, promptId: file.promptId ?? job.promptId }, dest);
    const upscaleOf = job.spec.operation === "upscale" && job.spec.start ? job.spec.start : undefined;
    const asset = await ws.register({ path: dest, role: "generated", id: `${job.id}${media.length > 1 ? `_${i + 1}` : ""}`, label: job.spec.prompt.slice(0, 80), jobId: job.id, lineId: job.line, upscaleOf });
    if (asset.kind === "video" && asset.fps && asset.durationSec) {
      await sampleSheet({
        input: dest,
        outPath: ws.path("qa", `${asset.id}.jpg`),
        aspect: (asset.width ?? 16) / (asset.height ?? 9),
        fps: asset.fps,
        durationSec: asset.durationSec,
        everySec: 0.25,
      });
    }
    ids.push(asset.id);
  }
  return ids;
}

/** What the last polling pass of a wait saw: how many jobs it polled and the errors of the polls that failed. */
export interface PollPass {
  polled: number;
  failures: string[];
}

/** Polls the given (or all unfinished) jobs until they finish or the timeout passes, downloading results. */
export async function waitJobs(ws: Workspace, backend: Backend, opts: { ids?: string[]; timeoutSec: number; intervalSec?: number; signal?: AbortSignal }): Promise<JobRecord[]> {
  return (await waitJobsDetailed(ws, backend, opts)).jobs;
}

/** What one poll found for a job, applied to jobs.json only while the job is still open there. */
type Seen = Pick<JobRecord, "id" | "state"> & Partial<Pick<JobRecord, "finishedAt" | "outputs" | "error" | "promptId">> & { adopt?: string; resent?: string };

/**
 * waitJobs, plus what its last polling pass saw (to tell a backend that stopped answering from a slow one).
 * Each pass polls a snapshot, then merges what it saw into a fresh read of jobs.json: a job cancelled or
 * finished meanwhile (katana_cancel, another wait) keeps that state, except that a job the backend says
 * completed keeps its outputs. An aborted request (the client gave up on katana_wait) stops polling.
 */
export async function waitJobsDetailed(
  ws: Workspace,
  backend: Backend,
  opts: { ids?: string[]; timeoutSec: number; intervalSec?: number; signal?: AbortSignal },
): Promise<{ jobs: JobRecord[]; lastPass: PollPass }> {
  const deadline = Date.now() + opts.timeoutSec * 1000;
  const interval = (opts.intervalSec ?? 4) * 1000;
  const watched = (j: JobRecord) => (opts.ids ? opts.ids.includes(j.id) : true) && j.backend === backend.target;
  for (;;) {
    const snapshot = (await loadJobs(ws)).filter(watched);
    const pass: PollPass = { polled: 0, failures: [] };
    const seen: Seen[] = [];
    for (const job of snapshot.filter(isOpen)) {
      if (opts.signal?.aborted) break;
      if (!job.promptId) {
        const placeholder = await placeholderState(job, backend);
        if (placeholder) seen.push(placeholder);
        continue;
      }
      pass.polled++;
      const res = await backend.poll(job.promptId).catch((e: Error) => {
        pass.failures.push(e.message);
        return { state: job.state, outputs: [], error: e.message };
      });
      if (res.state === "completed") {
        const finishedAt = new Date().toISOString();
        const outputs = await collect(ws, backend, job, res.outputs);
        seen.push({ id: job.id, state: "completed", finishedAt, outputs });
        const actual = (Date.parse(finishedAt) - Date.parse(job.submittedAt)) / 1000;
        const compute = Math.max(1, actual - (JOB_OVERHEAD_SEC[backend.kind] ?? 0));
        await recordTiming(backend.target, job.profile, job.estimateSec, compute).catch(() => undefined);
      } else if (res.state === "error" && isTransientError(res.error) && (job.retries ?? 0) < MAX_RETRIES && existsSync(promptFile(ws, job.id))) {
        const resent = await backend.submit(JSON.parse(await readFile(promptFile(ws, job.id), "utf8"))).catch(() => undefined);
        if (resent) seen.push({ id: job.id, state: "pending", resent, error: res.error });
        else seen.push({ id: job.id, state: "error", finishedAt: new Date().toISOString(), error: res.error });
      } else if (res.state === "error" || res.state === "cancelled") {
        const again = res.state === "error" && isTransientError(res.error) && (job.retries ?? 0) >= MAX_RETRIES;
        const error = again ? `${res.error} (sent twice; this Comfy Cloud error is usually about the server, not the job: resubmit it unchanged before changing its move or prompt)` : res.error;
        seen.push({ id: job.id, state: res.state, finishedAt: new Date().toISOString(), error });
      } else if (res.state !== job.state) seen.push({ id: job.id, state: res.state });
    }
    const orphans: string[] = [];
    const jobs = await updateJobs(ws, (all) => {
      for (const s of seen) {
        const cur = all.find((j) => j.id === s.id);
        if (!cur) continue;
        if (s.resent) {
          // Cancelled while it was being sent again: the new copy goes too.
          if (!isOpen(cur)) {
            orphans.push(s.resent);
            continue;
          }
          cur.promptId = s.resent;
          cur.state = "pending";
          cur.retries = (cur.retries ?? 0) + 1;
          cur.submittedAt = new Date().toISOString();
          continue;
        }
        if (s.adopt && cur.sending === s.adopt) {
          cur.promptId = s.adopt;
          delete cur.sending;
          continue;
        }
        if (!isOpen(cur) && !(s.state === "completed" && cur.state === "cancelled")) continue;
        cur.state = s.state;
        if (s.finishedAt) cur.finishedAt = s.finishedAt;
        if (s.outputs) cur.outputs = s.outputs;
        if (s.error !== undefined) cur.error = s.error;
        if (s.state === "completed") delete cur.error;
      }
      return all.filter(watched).map((j) => ({ ...j }));
    });
    for (const id of orphans) await backend.cancel(id).catch(() => undefined);
    const stillOpen = jobs.filter(isOpen);
    if (!stillOpen.length || Date.now() >= deadline || opts.signal?.aborted) return { jobs, lastPass: pass };
    await new Promise<void>((r) => {
      const timer = setTimeout(done, Math.min(interval, Math.max(0, deadline - Date.now())));
      function done() {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", done);
        r();
      }
      opts.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/**
 * A job recorded before its submit returned. Ours (still on its way in this process): wait. Left by a
 * process that died mid-submit: an http ComfyUI that took our prompt id shows the job under it, so it is
 * adopted; one that shows nothing for long enough, or a backend that picks its own ids, means the job can't
 * be followed, and it is marked as an error.
 */
async function placeholderState(job: JobRecord, backend: Backend): Promise<Seen | undefined> {
  const id = job.sending;
  if (!id || sendingNow.has(id)) return undefined;
  const lost = { id: job.id, state: "error" as const, finishedAt: new Date().toISOString(), error: `The submit to ${backend.target} was interrupted before it answered; the job may still have run.` };
  if (backend.kind !== "http") return lost;
  const res = await backend.poll(id).catch(() => undefined);
  if (res && res.state !== "pending") return { id: job.id, state: job.state, adopt: id };
  return Date.now() - Date.parse(job.submittedAt) > STALE_SEND_MS ? lost : undefined;
}

/**
 * Cancels this project's queued and running jobs on the backend's target (spec §10.7). Each is cancelled on
 * the backend and marked cancelled; a job whose cancel failed (the backend didn't confirm it) stays open, so
 * a later wait can still collect it, and is reported. Jobs on another target are left alone and counted.
 * A job recorded mid-submit by a process that is gone is cancelled by the id it asked for on an http
 * ComfyUI; elsewhere it can't be reached and is counted as `unsent`. Idempotent; safe while a wait in this
 * process is polling (the save merges).
 */
export async function cancelOpenJobs(ws: Workspace, backend: Backend, reason = "Cancelled"): Promise<{ cancelled: number; failed: { id: string; error: string }[]; otherTarget: number; unsent: number }> {
  const snapshot = await loadJobs(ws);
  const failed: { id: string; error: string }[] = [];
  const outcome = new Map<string, { state: "cancelled" | "error"; error: string }>();
  let otherTarget = 0;
  let unsent = 0;
  for (const job of snapshot.filter(isOpen)) {
    if (job.backend !== backend.target) {
      otherTarget++;
      continue;
    }
    if (!job.promptId) {
      if (!job.sending) continue;
      if (sendingNow.has(job.sending)) {
        // On its way in this process: the submit cancels it as soon as the backend answers with its id.
        outcome.set(job.id, { state: "cancelled", error: reason });
      } else if (backend.kind === "http") {
        await backend.cancel(job.sending).catch(() => undefined);
        outcome.set(job.id, { state: "cancelled", error: "Cancelled while it was being sent" });
      } else {
        unsent++;
        outcome.set(job.id, { state: "error", error: `Stopped while it was being sent to ${backend.target}; it may still run.` });
      }
      continue;
    }
    try {
      await backend.cancel(job.promptId);
      outcome.set(job.id, { state: "cancelled", error: reason });
    } catch (e) {
      failed.push({ id: job.id, error: (e as Error).message });
    }
  }
  let cancelled = 0;
  if (outcome.size) {
    await updateJobs(ws, (jobs) => {
      for (const job of jobs) {
        const o = outcome.get(job.id);
        if (!o || !isOpen(job)) continue;
        job.state = o.state;
        job.finishedAt = new Date().toISOString();
        job.error = o.error;
        if (o.state === "cancelled") cancelled++;
      }
    });
  }
  return { cancelled, failed, otherTarget, unsent };
}
