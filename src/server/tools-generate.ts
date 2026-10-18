import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { OUT_OF_CREDITS } from "../comfy/backend.js";
import {
  adjustedSeconds,
  cancelOpenJobs,
  chooseProfile,
  estimateSpec,
  estimateSpecFor,
  type JobSpec,
  JobSpecSchema,
  loadJobs,
  submitJobs,
  timingRatio,
  waitJobsDetailed,
} from "../comfy/jobs.js";
import { licenseLabel, licenseWarnings, profile } from "../comfy/operations.js";
import { extractFrame } from "../engine/sheets.js";
import type { Workspace } from "../project/workspace.js";
import { masterSize } from "../project/render-project.js";
import { type Edl, EdlSchema } from "../render/edl.js";
import { approvalFromFile, backendError, isAppRun, isConnectionError, presetAspect, readApproval, refuseIfLocked, userPicks } from "./app-mode.js";
import { type Content, image, result, safe, table } from "./content.js";
import { identityPanel } from "./identity.js";
import type { State } from "./state.js";
import { WIDGETS, widgetMeta } from "./widgets.js";

export const ROUTES = ["source", "graphic", "still", "i2v", "motion", "camera", "flf"] as const;

export const PlanSchema = z.object({
  contract: z
    .object({
      locks: z.array(z.object({ attribute: z.string(), scope: z.string().default("whole edit"), value: z.string(), instruction: z.string().optional() })).default([]),
      freedoms: z.array(z.string()).default([]),
    })
    .default({ locks: [], freedoms: [] }),
  concept: z.string().min(1).describe("The idea of the edit: its build and payoff, in one or two sentences"),
  output: z.object({ width: z.number().int(), height: z.number().int(), fps: z.number().positive(), durationSec: z.number().positive() }).optional(),
  shots: z
    .array(
      z.object({
        at: z.string().describe('Time range on the output timeline, e.g. "0-1.6" or "b4-b8"'),
        role: z.string(),
        description: z.string(),
        route: z.enum(ROUTES),
        lines: z.array(z.string()).default([]).describe("Generation lines this shot uses"),
      }),
    )
    .min(1),
  jobs: z.array(JobSpecSchema).default([]).describe('Generation lines. Reference an earlier line\'s accepted output as "@<line>" in images/start/end.'),
  energy: z.string().optional().describe("How the reference's cuts, flashes, shake, camera moves and hits land on the new timeline"),
});
export type Plan = z.infer<typeof PlanSchema>;

interface Verdict {
  asset: string;
  verdict: "accept" | "reject";
  reason?: string;
  badRanges?: [number, number][];
  at: string;
}

export async function verdicts(ws: Workspace): Promise<Verdict[]> {
  return (await ws.readJson<Verdict[]>("qa/verdicts.json")) ?? [];
}

/** "<asset>@f<frame>", "<asset>@<seconds>" (also "#" or ":") pick one frame of a video asset. */
const FRAME_REF = /^([a-z0-9_-]+)[@#:](f?)(\d+(?:\.\d+)?)s?$/i;

/** Extracts the referenced frame once and registers it as a style asset. */
async function frameAsset(ws: Workspace, ref: string): Promise<string> {
  const [, base, isFrame, value] = ref.match(FRAME_REF)!;
  const video = ws.asset(base!);
  if (video.kind !== "video") throw new Error(`${ref}: ${base} is not a video`);
  const frame = isFrame ? Math.round(Number(value)) : Math.round(Number(value) * (video.fps ?? 24));
  if (video.frameCount && frame >= video.frameCount) throw new Error(`${ref}: ${base} has ${video.frameCount} frames`);
  const id = `${base}_f${frame}`;
  if (ws.project.assets.some((a) => a.id === id)) return id;
  const out = ws.path("media", "frames", `${id}.png`);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(ws.path("media", "frames"), { recursive: true });
  await extractFrame(ws.assetPath(base!), frame, out);
  await ws.register({ path: out, role: "style", id, label: `${base} frame ${frame}` });
  return id;
}

/**
 * Resolves "@line" to the person's pick for that line (made in the app), else its accepted output (or
 * newest completed one), and "<video>@f<n>" to a frame; other ids pass through.
 */
async function resolveRef(ws: Workspace, ref: string): Promise<string> {
  if (FRAME_REF.test(ref) && !ws.project.assets.some((a) => a.id === ref)) return frameAsset(ws, ref);
  if (!ref.startsWith("@")) {
    ws.asset(ref);
    return ref;
  }
  const line = ref.slice(1);
  const picked = (await userPicks(ws)).get(line);
  if (picked && ws.project.assets.some((a) => a.id === picked)) return picked;
  const jobs = (await loadJobs(ws)).filter((j) => j.line === line && j.state === "completed" && j.outputs.length);
  if (!jobs.length) throw new Error(`Line ${line} has no finished output yet; generate and judge it before jobs that use ${ref}.`);
  const vs = await verdicts(ws);
  const outputs = jobs.flatMap((j) => j.outputs);
  const accepted = outputs.filter((o) => vs.some((v) => v.asset === o && v.verdict === "accept"));
  const usable = outputs.filter((o) => !vs.some((v) => v.asset === o && v.verdict === "reject"));
  const pick = accepted.at(-1) ?? usable.at(-1);
  if (!pick) throw new Error(`Every output of line ${line} was rejected.`);
  return pick;
}

/** The aspect a spec without one is made at: the reference's, else the template's format (spec D44), else 9:16. */
async function defaultAspect(ws: Workspace): Promise<number> {
  const ref = ws.reference();
  if (ref?.width && ref.height) return ref.width / ref.height;
  return (ref ? undefined : await presetAspect(ws)) ?? 9 / 16;
}

async function resolveSpec(ws: Workspace, spec: JobSpec): Promise<JobSpec> {
  const presetDefault = ws.reference() ? undefined : await presetAspect(ws);
  return {
    ...spec,
    ...(spec.aspect === undefined && presetDefault ? { aspect: presetDefault } : {}),
    images: spec.images ? await Promise.all(spec.images.map((r) => resolveRef(ws, r))) : undefined,
    start: spec.start ? await resolveRef(ws, spec.start) : undefined,
    end: spec.end ? await resolveRef(ws, spec.end) : undefined,
  };
}

/** GPU seconds already committed in a project: every job not in error or cancelled, as the budget counts them. */
async function committedSeconds(ws: Workspace, kind: string): Promise<number> {
  let total = 0;
  for (const j of await loadJobs(ws)) {
    if (j.state === "error" || j.state === "cancelled") continue;
    total += adjustedSeconds(j.estimateSec, 1, { ratio: await timingRatio(j.backend, j.profile), kind });
  }
  return total;
}

/** 45 → "45", 45.25 → "45.3". */
const minutes = (m: number) => String(+m.toFixed(1));

/** Every asset id the edit's shots draw from (sources and layers), in order of first use. */
export function editAssets(edl: Pick<Edl, "shots">): string[] {
  const ids: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "asset" && typeof x === "string") {
          if (!ids.includes(x)) ids.push(x);
        } else walk(x);
      }
    }
  };
  walk(edl.shots);
  return ids;
}

/**
 * The generated clips and stills of an edit that need an upscaled copy for a master of `longSide`: not
 * already that big, and with no upscaled copy at least that big. Reference footage and photos are left as
 * they are.
 */
export function upscaleTargets(ws: Workspace, edl: Pick<Edl, "shots">, longSide: number): { id: string; kind: "image" | "video" }[] {
  const long = (a: { width?: number; height?: number }) => Math.max(a.width ?? 0, a.height ?? 0);
  const out: { id: string; kind: "image" | "video" }[] = [];
  for (const id of editAssets(edl)) {
    const a = ws.project.assets.find((x) => x.id === id);
    if (!a || a.role !== "generated" || a.upscaleOf || a.kind === "audio") continue;
    if (long(a) >= longSide) continue;
    const up = ws.upscaled(id);
    if (up && long(up) >= longSide) continue;
    out.push({ id, kind: a.kind });
  }
  return out;
}

export function registerGenerationTools(server: McpServer, state: State): void {
  /**
   * The GPU-minute gate, then the submit: shared by katana_generate and katana_upscale. The agent may lower
   * the cap (budgetMinutes), never raise it past the person's approval.
   */
  async function submitWithinBudget(ws: Workspace, specs: JobSpec[], budgetMinutes: number | undefined, approval: Awaited<ReturnType<typeof readApproval>>) {
    const cfg = await state.config();
    const backend = await state.backend();
    const capMinutes = approval ? Math.min(budgetMinutes ?? Infinity, approval.gpuMinutes) : (budgetMinutes ?? cfg.budgetMinutes);
    const cap = capMinutes * 60;
    const prior = await committedSeconds(ws, backend.kind);
    const aspect = await defaultAspect(ws);
    const resolved = await Promise.all(specs.map((s) => resolveSpec(ws, s)));
    let planned = 0;
    for (const s of resolved) {
      const profileId = chooseProfile(s, { tier: cfg.tier, overrides: cfg.profiles, commercial: cfg.commercial });
      // An upscale's cost follows its source clip, which estimateSpec reads from the project.
      const est = s.operation === "upscale" ? estimateSpec(ws, s, profileId) : estimateSpecFor(s, profileId, aspect);
      planned += adjustedSeconds(est.seconds, s.takes, { ratio: await timingRatio(backend.target, profileId), kind: backend.kind });
    }
    if (prior + planned > cap) {
      const needs = (prior + planned) / 60;
      if (approval) {
        throw new Error(`[BUDGET] needs=${needs.toFixed(1)} cap=${minutes(capMinutes)} This needs about ${Math.round(needs)} GPU minutes in total; the person approved ${minutes(capMinutes)}. Stop now.`);
      }
      throw new Error(`This would bring the project to ~${needs.toFixed(1)} GPU minutes, over the approved ${(cap / 60).toFixed(1)}. Ask the user for a larger budget or trim the lines.`);
    }
    try {
      return { ...(await submitJobs(ws, backend, resolved, { tier: cfg.tier, overrides: cfg.profiles, commercial: cfg.commercial })), backend };
    } catch (e) {
      throw isAppRun() ? backendError(e, backend.target) : e;
    }
  }

  server.registerTool(
    "katana_plan",
    {
      title: "Save the creative plan",
      description:
        "Saves the task contract, concept, output format, shot list with routes, and the generation lines, then returns the compute estimate to show the user before generating. Plans can be revised by calling again.",
      inputSchema: z.object({ project: z.string(), plan: PlanSchema }),
      _meta: widgetMeta(WIDGETS.estimate),
    },
    safe(async ({ project, plan }) => {
      const ws = await state.workspace(project);
      refuseIfLocked(ws);
      const cfg = await state.config();
      const backend = await state.backend();
      // Without a reference, lines are made at the template's aspect (spec D44).
      const presetDefault = ws.reference() ? undefined : await presetAspect(ws);
      if (presetDefault) for (const j of plan.jobs) j.aspect ??= presetDefault;
      const aspect = await defaultAspect(ws);
      const lines = new Set(plan.jobs.map((j) => j.line));
      const problems: string[] = [];
      for (const j of plan.jobs) {
        for (const r of [...(j.images ?? []), j.start, j.end].filter(Boolean) as string[]) {
          if (r.startsWith("@")) {
            if (!lines.has(r.slice(1)) && !(await loadJobs(ws)).some((x) => x.line === r.slice(1))) problems.push(`${j.line}: ${r} is not a planned line`);
          } else if (FRAME_REF.test(r)) {
            const base = ws.project.assets.find((a) => a.id === r.match(FRAME_REF)![1]);
            if (!base || base.kind !== "video") problems.push(`${j.line}: ${r} needs a video asset before the @`);
          } else if (!ws.project.assets.some((a) => a.id === r)) problems.push(`${j.line}: unknown asset ${r}`);
        }
        if (j.operation === "clip.motion" && !j.motion && !j.camera) problems.push(`${j.line}: clip.motion needs motion {startSec, endSec, control} (a reference shot's move) or camera {orbit, arc, push} (a camera move)`);
        if (j.operation === "clip.motion" && j.camera && !j.start) problems.push(`${j.line}: a camera move needs start (its keyframe)`);
      }
      if (problems.length) throw new Error(`Plan has problems:\n- ${problems.join("\n- ")}`);
      const rows = [];
      const jobs = [];
      let total = 0;
      for (const j of plan.jobs) {
        const profileId = chooseProfile(j, { tier: cfg.tier, overrides: cfg.profiles, commercial: cfg.commercial });
        const est = estimateSpecFor(j, profileId, aspect);
        const seconds = adjustedSeconds(est.seconds, j.takes, { ratio: await timingRatio(backend.target, profileId), kind: backend.kind });
        total += seconds;
        const prof = profile(profileId);
        const video = prof.fps && j.durationSec ? `${j.durationSec} s` : "";
        const minutes = +(seconds / 60).toFixed(1);
        rows.push([j.line, j.operation, profileId, licenseLabel(prof.license), j.takes, video, `${est.width}×${est.height}`, minutes.toFixed(1)]);
        jobs.push({ line: j.line, operation: j.operation, profile: profileId, license: { name: prof.license.name, commercial: prof.license.commercial }, takes: j.takes, video, size: `${est.width}×${est.height}`, minutes });
      }
      await ws.writeJson("plan/plan.json", plan);
      const warnings = licenseWarnings(jobs.map((j) => j.profile), cfg.commercial);
      // In app runs the cap is the person's approval (the one katana_generate enforces), not the config budget.
      const appRun = approvalFromFile();
      const approved = appRun ? await readApproval(ws) : undefined;
      const budgetMinutes = appRun ? approved?.gpuMinutes : cfg.budgetMinutes;
      const estimate = {
        project: ws.project.id,
        totalMinutes: +(total / 60).toFixed(1),
        ...(budgetMinutes !== undefined ? { budgetMinutes } : {}),
        backend: backend.target,
        commercial: Boolean(cfg.commercial),
        jobs,
        licenseWarnings: warnings,
      };
      await ws.writeJson("plan/estimate.json", estimate);
      await ws.setStage("planned");
      const note = backend.kind === "comfy-cli" || backend.kind === "cloud" ? "Comfy Cloud: open-weights runs use subscription GPU time; no partner (paid API) nodes are used." : "Local/remote GPU: the cost is your machine's time.";
      const nonCommercial = jobs.some((j) => j.license.commercial === "no");
      return result(
        [
          `Plan saved: ${plan.shots.length} shots, ${plan.jobs.length} generation lines.`,
          "",
          rows.length ? table(["Line", "Operation", "Profile", "Licence", "Takes", "Video", "Size", "Est. GPU min"], rows) : "No generation needed: the edit uses footage, stills and graphics only.",
          "",
          `Estimated total: ${estimate.totalMinutes} GPU minutes on ${backend.target} (${appRun ? (approved ? `the person approved ${minutes(approved.gpuMinutes)} GPU min in total` : "the person approves the spend in the app") : `project budget ${cfg.budgetMinutes} min`}). ${note}`,
          ...(warnings.length
            ? [
                "",
                "Licence warnings (summaries of each model's licence, not legal advice); tell the user about them with the estimate:",
                ...warnings.map((w) => `- ${w}`),
                ...(nonCommercial && !cfg.commercial ? ["If the edit is for commercial use, run katana_backend set with commercial: true and plan again: defaults then skip non-commercial models."] : []),
                "",
              ]
            : []),
          appRun
            ? approved
              ? "Generate within that approval with katana_generate."
              : "The person approves the spend in the app: stop here and summarise the plan."
            : "Show this to the user and ask for approval before katana_generate.",
        ].join("\n"),
        estimate,
      );
    }),
  );

  server.registerTool(
    "katana_generate",
    {
      title: "Generate stills and clips",
      description:
        'Submits generation lines to ComfyUI: by line id from the saved plan, or inline specs. Requires a completed review (when there is a reference) and the user\'s approval of the estimate (approved: true). "@<line>" references resolve to that line\'s accepted output. Returns job ids; then call katana_wait.',
      inputSchema: z.object({
        project: z.string(),
        lines: z.array(z.string()).optional().describe("Plan line ids to submit"),
        jobs: z.array(JobSpecSchema).optional().describe("Inline specs (new lines or retries)"),
        approved: z.boolean().describe("True only after the user approved the estimate (or authorized generation within a budget)"),
        budgetMinutes: z.number().positive().optional().describe("The GPU-minute cap the user approved; defaults to the project budget"),
      }),
    },
    safe(async (a) => {
      const ws = await state.workspace(a.project);
      refuseIfLocked(ws);
      // In app runs the person approves in the app: the approval file is the only permission to spend.
      const approval = approvalFromFile() ? await readApproval(ws) : undefined;
      if (approvalFromFile() && !approval) throw new Error("[APPROVAL] The person approves spending in the app. Stop now and summarise the plan in two lines.");
      if (!a.approved) throw new Error("Show the estimate from katana_plan and get the user's approval first.");
      const pages = (await ws.readJson<unknown[]>("analysis/pages.json")) ?? [];
      if (ws.reference() && ws.project.mode !== "clip") {
        if (!pages.length) throw new Error("Analyze the reference (katana_analyze) and read every page before generating.");
        const missing = pages.length - Object.keys(ws.project.reviewedPages).length;
        if (missing > 0) throw new Error(`Read and log the remaining ${missing} review pages (katana_view, katana_review) before generating.`);
      }
      const plan = await ws.readJson("plan/plan.json", PlanSchema);
      const specs: JobSpec[] = [];
      for (const line of a.lines ?? []) {
        const j = plan?.jobs.find((x) => x.line === line);
        if (!j) throw new Error(`Line ${line} is not in the saved plan.`);
        specs.push(j);
      }
      specs.push(...(a.jobs ?? []));
      if (!specs.length) throw new Error("Nothing to generate: give lines or jobs.");
      const { submitted, warnings, backend } = await submitWithinBudget(ws, specs, a.budgetMinutes, approval);
      await ws.setStage("generating");
      return result(
        [
          `Submitted ${submitted.length} job(s) to ${backend.target}:\n${table(["Job", "Profile", "Size", "Frames", "Est. s"], submitted.map((j) => [j.id, j.profile, `${j.width}×${j.height}`, j.frames ?? "", j.estimateSec]))}`,
          warnings.length ? `Licence warnings:\n- ${warnings.join("\n- ")}` : "",
          "Next: katana_wait.",
        ].filter(Boolean).join("\n"),
        { jobs: submitted.map((j) => ({ id: j.id, profile: j.profile, promptId: j.promptId })), licenseWarnings: warnings },
      );
    }),
  );

  server.registerTool(
    "katana_upscale",
    {
      title: "Upscale the cut",
      description:
        "The finishing pass, once the cut is final and before the final render: upscales every generated clip and still the saved edit uses (SeedVR2: restored detail, the same frames and timing, colours matched) and sets the master to that size. Previews keep using the originals; katana_render with preview: false uses the upscaled copies. Shots already upscaled to that size are skipped. Then katana_wait, then katana_render with preview: false.",
      inputSchema: z.object({
        project: z.string(),
        longSide: z.number().int().min(720).max(3840).default(1920).describe("The master's long side in pixels: 1920 for 1080p, 3840 for 4K"),
        approved: z.boolean().describe("True after the user approved generation (the same approval as katana_generate)"),
        budgetMinutes: z.number().positive().optional().describe("The GPU-minute cap the user approved; defaults to the project budget"),
      }),
    },
    safe(async (a) => {
      const ws = await state.workspace(a.project);
      refuseIfLocked(ws);
      const approval = approvalFromFile() ? await readApproval(ws) : undefined;
      if (approvalFromFile() && !approval) throw new Error("[APPROVAL] The person approves spending in the app. Stop now and summarise the plan in two lines.");
      if (!a.approved) throw new Error("Get the user's approval for the GPU time first, as for katana_generate.");
      const edl = await ws.readJson("render/edl.json", EdlSchema);
      if (!edl) throw new Error("No edit saved yet. Cut the edit with katana_edit, then upscale it.");
      const targets = upscaleTargets(ws, edl, a.longSide);
      const lines = new Set<string>();
      const specs: JobSpec[] = targets.map((t) => {
        let line = `up-${t.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);
        while (lines.has(line)) line = `${line.slice(0, 29)}-${lines.size}`;
        lines.add(line);
        return JobSpecSchema.parse({ line, operation: "upscale", prompt: `upscale ${t.id}`, start: t.id, longSide: a.longSide, seed: 1 });
      });
      const submitted = specs.length ? (await submitWithinBudget(ws, specs, a.budgetMinutes, approval)).submitted : [];
      const fresh = (await ws.readJson("render/edl.json", EdlSchema)) ?? edl;
      fresh.canvas.master = { longSide: a.longSide };
      await ws.writeJson("render/edl.json", fresh);
      const size = masterSize(fresh.canvas, a.longSide);
      return result(
        [
          specs.length
            ? `Upscaling ${specs.length} shot(s) for a ${size.width}×${size.height} master:\n${table(["Job", "Shot", "Profile", "Est. s"], submitted.map((j) => [j.id, j.spec.start ?? "", j.profile, j.estimateSec]))}`
            : `Every generated shot in the edit already has an upscaled copy at least ${a.longSide} px on its long side.`,
          `The master renders at ${size.width}×${size.height}; previews stay at the edit's size.`,
          specs.length ? "Next: katana_wait, then katana_render with preview: false." : "Next: katana_render with preview: false.",
        ].join("\n"),
        { jobs: submitted.map((j) => ({ id: j.id, asset: j.spec.start, profile: j.profile })), master: size },
      );
    }),
  );

  server.registerTool(
    "katana_wait",
    {
      title: "Wait for jobs",
      description:
        "Waits for submitted jobs (all unfinished ones by default) up to timeoutSec, downloads finished outputs into the project and returns them for review: stills as images, clips as frame sheets. Call again while jobs are still running.",
      inputSchema: z.object({ project: z.string(), jobs: z.array(z.string()).optional(), timeoutSec: z.number().int().min(0).max(600).default(240) }),
    },
    safe(async (a, req) => {
      const ws = await state.workspace(a.project);
      refuseIfLocked(ws);
      const backend = await state.backend();
      const before = new Map((await loadJobs(ws)).map((j) => [j.id, j.state]));
      // A wait the client gave up on (Esc) stops polling instead of running on to its timeout.
      const { jobs, lastPass } = await waitJobsDetailed(ws, backend, { ids: a.jobs, timeoutSec: a.timeoutSec, signal: req?.mcpReq?.signal });
      if (isAppRun()) {
        if (jobs.some((j) => j.state === "error" && before.get(j.id) !== "error" && j.error?.includes(OUT_OF_CREDITS))) throw new Error(`[OUT_OF_CREDITS] ${OUT_OF_CREDITS}`);
        if (lastPass.polled && lastPass.failures.length === lastPass.polled && lastPass.failures.every((m) => isConnectionError({ message: m }))) {
          throw new Error(`[BACKEND] ${backend.target}: not answering`);
        }
      }
      const fresh = jobs.filter((j) => j.state === "completed" && before.get(j.id) !== "completed");
      const images: Content[] = [];
      const shown: string[] = [];
      // Keyframes come back as one panel per line: the subject photo, then every new take, so
      // likeness is compared rather than recalled and the best take is picked side by side.
      const keyframes = new Map<string, string[]>();
      for (const j of fresh) if (j.spec.operation === "still.compose") keyframes.set(j.line, [...(keyframes.get(j.line) ?? []), ...j.outputs]);
      for (const [, ids] of keyframes) {
        if (images.length >= 4) break;
        const panel = await identityPanel(ws, ids).catch(() => undefined);
        if (!panel) continue;
        images.push(await image(panel));
        shown.push(...ids);
      }
      for (const j of fresh) {
        for (const id of j.outputs) {
          if (images.length >= 4 || shown.includes(id)) continue;
          const asset = ws.asset(id);
          images.push(await image(asset.kind === "image" ? ws.path(asset.path) : ws.path("qa", `${id}.jpg`)));
          shown.push(id);
        }
      }
      const open = jobs.filter((j) => j.state === "pending" || j.state === "running").length;
      const rows = jobs.map((j) => [j.id, j.state, j.outputs.join(", "), j.error ?? ""]);
      return result(
        [
          table(["Job", "State", "Outputs", "Error"], rows),
          shown.length ? `Showing: ${shown.join(", ")}. Judge each with katana_judge. Keyframes are shown next to the subject photo, all takes of a line together: accept the take that looks most like the subject and reject the rest; reject every take where the face is a different person (face shape, skin tone, jaw, eyes, hairline), however good the shot is.` : "",
          fresh.length && fresh.flatMap((j) => j.outputs).length > shown.length ? "More outputs finished; view them with katana_view (target asset)." : "",
          open ? `${open} job(s) still running: call katana_wait again.` : "All listed jobs are finished.",
        ].filter(Boolean).join("\n"),
        { jobs: jobs.map((j) => ({ id: j.id, state: j.state, outputs: j.outputs, error: j.error })) },
        images,
      );
    }),
  );

  server.registerTool(
    "katana_judge",
    {
      title: "Judge a generated asset",
      description:
        "Records your verdict on a generated still or clip after looking at it: accept or reject with the reason (identity, clothing, hands, extra people, text, style mismatch), and for clips the bad time ranges the edit must avoid.",
      inputSchema: z.object({
        project: z.string(),
        asset: z.string(),
        verdict: z.enum(["accept", "reject"]),
        reason: z.string().max(500).optional(),
        badRanges: z.array(z.tuple([z.number().min(0), z.number().positive()])).default([]).describe("[start, end] seconds within the clip"),
      }),
    },
    safe(async (a) => {
      const ws = await state.workspace(a.project);
      refuseIfLocked(ws);
      const asset = ws.asset(a.asset);
      // The person's pick for a line (made in the app) is final.
      const line = asset.lineId;
      const pick = line ? (await userPicks(ws)).get(line) : undefined;
      if (pick && ((a.verdict === "accept" && a.asset !== pick) || (a.verdict === "reject" && a.asset === pick))) {
        throw new Error(`[USER_PICK] The person picked ${pick} for line ${line} in the app; keep it.`);
      }
      const list = (await verdicts(ws)).filter((v) => v.asset !== a.asset);
      list.push({ asset: a.asset, verdict: a.verdict, reason: a.reason, badRanges: a.badRanges, at: new Date().toISOString() });
      await ws.writeJson("qa/verdicts.json", list);
      return result(`${a.asset}: ${a.verdict}${a.reason ? ` (${a.reason})` : ""}.`, { verdict: a.verdict });
    }),
  );

  server.registerTool(
    "katana_cancel",
    {
      title: "Cancel generation jobs",
      description:
        "Cancels the project's queued and running generation jobs on the current ComfyUI backend, so they stop using GPU time. Finished outputs are kept; jobs sent to another backend are left alone. Call katana_generate again to resume.",
      inputSchema: z.object({ project: z.string() }),
    },
    safe(async ({ project }) => {
      const ws = await state.workspace(project);
      refuseIfLocked(ws);
      const backend = await state.backend();
      const r = await cancelOpenJobs(ws, backend);
      return result(
        [
          `Cancelled ${r.cancelled} job(s) on ${backend.target}.`,
          r.failed.length ? `${r.failed.length} couldn't be cancelled and may still use GPU time: ${r.failed.map((f) => `${f.id} (${f.error})`).join(", ")}.` : "",
          r.unsent ? `${r.unsent} job(s) were being sent when the session stopped and may still use GPU time.` : "",
          r.otherTarget ? `${r.otherTarget} job(s) on another backend were left alone.` : "",
        ].filter(Boolean).join(" "),
        r,
      );
    }),
  );
}
