import { randomInt } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { sampleSheet } from "../engine/sheets.js";
import type { Workspace } from "../project/workspace.js";
import { dataHome } from "../util/paths.js";
import { run } from "../util/proc.js";
import type { Backend, ModelChoices, OutputFile } from "./backend.js";
import { sizeForAspect } from "./graph.js";
import { CONTROL_MODES, type ControlMode, clipFrames, type Operation, OPERATIONS, type Profile, build, defaultProfile, estimateSeconds, licenseWarnings, profile } from "./operations.js";
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
  /** "stretch" spreads the source motion over the whole generated clip (slow motion); "hold" freezes its last frame. */
  fit: z.enum(["stretch", "hold"]).default("stretch"),
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
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

const JOBS = "plan/jobs.json";
const UPLOADS = "plan/uploads.json";

export async function loadJobs(ws: Workspace): Promise<JobRecord[]> {
  return (await ws.readJson(JOBS, z.array(JobRecordSchema))) ?? [];
}

async function saveJobs(ws: Workspace, jobs: JobRecord[]): Promise<void> {
  await ws.writeJson(JOBS, jobs);
}

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
  opts: { startSec: number; endSec: number; fps: number; frames: number; width: number; height: number; control: ControlMode | "raw"; fit: "stretch" | "hold" },
): Promise<string> {
  const span = Math.max(1 / opts.fps, opts.endSec - opts.startSec);
  const target = opts.frames / opts.fps;
  const filters = [
    ...(opts.fit === "stretch" ? [`setpts=PTS*${(target / span).toFixed(6)}`] : []),
    `fps=${opts.fps}`,
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase`,
    `crop=${opts.width}:${opts.height}`,
    ...(opts.control === "edges" ? ["edgedetect=low=0.08:high=0.3"] : []),
    ...(opts.fit === "hold" ? [`tpad=stop_mode=clone:stop=${opts.frames}`] : []),
    "format=rgb24",
  ];
  await mkdir(join(out, ".."), { recursive: true });
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-ss", String(opts.startSec), "-t", String(span), "-i", input,
    "-vf", filters.join(","),
    "-frames:v", String(opts.frames),
    "-loop", "0", "-lossless", "0", "-q:v", "75",
    out,
  ]);
  return out;
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

/** The profile a job runs on: the job's own, then the configured override, then the default. */
export function chooseProfile(spec: Pick<JobSpec, "operation" | "profile">, opts: ProfileChoice): string {
  const { catalog, onDemandModels } = opts;
  // On Comfy Cloud, model files load on demand: a profile only needs its nodes.
  const runnable = catalog ? (p: Profile) => (onDemandModels ? checkProfile(p, catalog).missingNodes.length === 0 : checkProfile(p, catalog).runnable) : undefined;
  return spec.profile ?? opts.overrides[spec.operation] ?? defaultProfile(spec.operation as Operation, opts.tier, runnable, { commercial: opts.commercial }).id;
}

/** Estimate (seconds of GPU time) for a spec without submitting anything. */
export function estimateSpec(ws: Workspace, spec: JobSpec, profileId: string): { seconds: number; width: number; height: number; frames?: number } {
  const prof = profile(profileId);
  const { width, height } = sizeForAspect(spec.aspect ?? referenceAspect(ws), spec.longSide ?? prof.longSide, prof.sizeStep);
  const frames = prof.fps ? clipFrames(prof, Math.round((spec.durationSec ?? 2) * prof.fps)) : undefined;
  return { seconds: estimateSeconds(profileId, { width, height, frames }) * spec.takes, width, height, frames };
}

export interface SubmitResult {
  submitted: JobRecord[];
  warnings: string[];
}

export async function submitJobs(ws: Workspace, backend: Backend, specs: JobSpec[], opts: { tier: "quality" | "lite"; overrides: Record<string, string>; commercial?: boolean }): Promise<SubmitResult> {
  const jobs = await loadJobs(ws);
  const submitted: JobRecord[] = [];
  const catalog = await backend.catalog().catch(() => undefined);
  const chosen = specs.map((spec) => chooseProfile(spec, { ...opts, catalog, onDemandModels: backend.onDemandModels }));
  const warnings = licenseWarnings(chosen, opts.commercial);

  for (const [i, spec] of specs.entries()) {
    const profileId = chosen[i]!;
    const prof = profile(profileId);
    if (prof.operation !== spec.operation) throw new Error(`Profile ${profileId} does ${prof.operation}, not ${spec.operation}`);
    const aspect = spec.aspect ?? referenceAspect(ws);
    const { width, height } = sizeForAspect(aspect, spec.longSide ?? prof.longSide, prof.sizeStep);
    const fps = prof.fps;
    const frames = fps ? clipFrames(prof, Math.round((spec.durationSec ?? 2) * fps)) : undefined;

    const upload = async (assetId: string) => ensureUploaded(ws, backend, ws.assetPath(assetId), assetId);
    const images = await Promise.all((spec.images ?? []).map(upload));
    const startImage = spec.start ? await upload(spec.start) : undefined;
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
    if (spec.operation === "clip.motion") {
      if (!spec.motion) throw new Error(`Line ${spec.line}: clip.motion needs motion {startSec, endSec}`);
      const m = spec.motion;
      const ctrl = ws.path("gen", "control", `${spec.line}.webp`);
      await makeControlClip(ws.assetPath(m.asset), ctrl, { ...m, fps: fps ?? 16, frames: frames ?? 33, width, height });
      controlImage = await ensureUploaded(ws, backend, ctrl, `control:${spec.line}:${m.asset}:${m.startSec}-${m.endSec}:${m.control}:${m.fit}:${frames}`);
    }

    for (let take = 1; take <= spec.takes; take++) {
      const previous = jobs.filter((j) => j.line === spec.line).map((j) => j.take);
      const takeNo = Math.max(0, ...previous) + 1;
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
        controlMode: spec.motion?.control,
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
      const promptId = await backend.submit(prompt);
      const record: JobRecord = {
        id: `${spec.line}_t${takeNo}`,
        line: spec.line,
        take: takeNo,
        spec,
        profile: profileId,
        backend: backend.target,
        promptId,
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
      submitted.push(record);
      await saveJobs(ws, jobs);
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
    const asset = await ws.register({ path: dest, role: "generated", id: `${job.id}${media.length > 1 ? `_${i + 1}` : ""}`, label: job.spec.prompt.slice(0, 80), jobId: job.id, lineId: job.line });
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

/** Polls the given (or all unfinished) jobs until they finish or the timeout passes, downloading results. */
export async function waitJobs(ws: Workspace, backend: Backend, opts: { ids?: string[]; timeoutSec: number; intervalSec?: number }): Promise<JobRecord[]> {
  const deadline = Date.now() + opts.timeoutSec * 1000;
  const interval = (opts.intervalSec ?? 4) * 1000;
  for (;;) {
    const jobs = await loadJobs(ws);
    const watching = jobs.filter((j) => (opts.ids ? opts.ids.includes(j.id) : true) && j.backend === backend.target);
    const open = watching.filter((j) => j.state === "pending" || j.state === "running");
    for (const job of open) {
      if (!job.promptId) continue;
      const res = await backend.poll(job.promptId).catch((e: Error) => ({ state: job.state, outputs: [], error: e.message }));
      job.state = res.state;
      if (res.state === "completed") {
        job.finishedAt = new Date().toISOString();
        job.outputs = await collect(ws, backend, job, res.outputs);
        const actual = (Date.parse(job.finishedAt) - Date.parse(job.submittedAt)) / 1000;
        const compute = Math.max(1, actual - (JOB_OVERHEAD_SEC[backend.kind] ?? 0));
        await recordTiming(backend.target, job.profile, job.estimateSec, compute).catch(() => undefined);
      } else if (res.state === "error" || res.state === "cancelled") {
        job.finishedAt = new Date().toISOString();
        job.error = res.error;
      }
    }
    await saveJobs(ws, jobs);
    const stillOpen = watching.filter((j) => j.state === "pending" || j.state === "running");
    if (!stillOpen.length || Date.now() >= deadline) return watching;
    await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(0, deadline - Date.now()))));
  }
}
