import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { adjustedSeconds, chooseProfile, estimateSpecFor, type JobSpec, timingRatio } from "../../comfy/jobs.js";
import { type Operation, profile } from "../../comfy/operations.js";
import { checkProfile } from "../../comfy/resolve.js";
import { type Config, loadConfig } from "../../config.js";
import { type AudioAnalysis, analyzeAudio } from "../../engine/audio.js";
import { DECODE_BRIEF, resolveBrief } from "../../presets/brief.js";
import { getPreset, type PresetEntry } from "../../presets/library.js";
import { Workspace } from "../../project/workspace.js";
import { gridBeats, resolveTime, type Time } from "../../render/edl.js";
import { fitTrack } from "../music.js";
import { HttpError } from "../router.js";
import { ID_PATTERNS } from "../schemas.js";
import { loadSettings } from "../settings.js";
import { uploadMediaPath } from "../uploads.js";
import { cachedCatalog, currentBackend, setupStatus, whereOf } from "../setup.js";
import type { BackendWhere, BriefField, BriefFile, DecodeState, Estimate, LicenceNote, RunDraft, SetupStatus, TemplateKind, TrackFit } from "../types.js";
import { costRange, type HistoryKind, loadHistory, wallRange } from "./history.js";
import { briefLines, firstPrompt, type PromptInput } from "./prompt.js";
import { projectDir } from "./store.js";

/**
 * The receipt before any agent runs, and the exact first prompt (spec §9.14). Deterministic for the
 * same inputs, files and history; the numbers use the same budget maths as katana_plan and the
 * katana_generate gate (adjustedSeconds, D45).
 */

const NEW_PROJECT = "(new project)";

/**
 * Claude seeds per kind (USD) and wall-clock seeds (minutes), until history has three samples.
 * Shot-for-shot comes from five recorded Opus runs of hype-energy, iron-mindset and night-stare
 * (Oct 2026): $4.48–7.62 and 16.7–27.0 min. Freestyle and decode have no measured runs yet.
 */
const CLAUDE_SEEDS: Record<HistoryKind, [number, number]> = { "shot-for-shot": [4, 8], freestyle: [4, 9], decode: [5, 10] };
const WALL_SEEDS: Record<HistoryKind, [number, number]> = { "shot-for-shot": [17, 28], freestyle: [18, 32], decode: [22, 40] };
const PER_PAGE_USD = 0.08;

const ROLE: Record<string, string> = {
  "still.compose": "keyframes",
  "still.face": "face crop",
  "still.generate": "plates",
  "clip.i2v": "clips",
  "clip.flf": "transitions",
  "clip.r2v": "reference clips",
  "clip.motion": "motion clips",
  matte: "cut-outs",
};

/** The model family name used in copy ("Qwen-Image 2.1", "MiniMax H3"), from the profile id. */
const FAMILIES: [RegExp, string][] = [
  [/^qwen21-turbo/, "Qwen-Image 2.1 Turbo"],
  [/^qwen21/, "Qwen-Image 2.1"],
  [/^qwen-edit-2511/, "Qwen-Image-Edit 2511"],
  [/^minimax-h3/, "MiniMax H3"],
  [/^wan22/, "Wan 2.2"],
  [/^boogu-edit-turbo/, "Boogu Image Edit Turbo"],
  [/^boogu/, "Boogu Image Edit"],
  [/^flux3/, "FLUX 3 Image Klein"],
  [/^flux2-klein/, "FLUX.2 klein 9B"],
  [/^krea2/, "Krea 2"],
  [/^z-image/, "Z-Image Turbo"],
  [/^ernie/, "ERNIE-Image Turbo"],
  [/^lens/, "Lens Turbo"],
  [/^mage-flow/, "Mage-Flow-Edit Turbo"],
  [/^firered/, "FireRed-Image-Edit 1.1"],
  [/^face-crop/, "Face crop"],
  [/^birefnet/, "BiRefNet"],
];
export function familyName(profileId: string): string {
  return FAMILIES.find(([re]) => re.test(profileId))?.[1] ?? profile(profileId).title.split(/ \(| \+ /)[0]!;
}

/** What a profile makes, in receipt words ("keyframes", "clips", "cut-outs"). */
export function roleOf(profileId: string): string {
  const op = profile(profileId).operation;
  return ROLE[op] ?? op;
}

/** "MiniMax H3 (clips)"; "Face crop" alone when the name already says what it does. */
export function modelWithRole(profileId: string): string {
  const name = familyName(profileId);
  const role = ROLE[profile(profileId).operation] ?? profile(profileId).operation;
  return name.toLowerCase() === role.toLowerCase() ? name : `${name} (${role})`;
}

/** One sentence for the receipt about what a licence allows. */
export function licenceSentence(profileId: string): string {
  const l = profile(profileId).license;
  if (l.commercial === "no") return "non-commercial licence, not for paid or commercial work.";
  if (/^MiniMax H3/.test(l.name)) return "not licensed for use in the US, EU, UK or South Korea, on your own GPU or on Comfy Cloud; attribution required.";
  if (!l.note || l.note.startsWith("unverified")) return "licence not verified: see the model card.";
  const first = /^.*?[.;](\s|$)/.exec(l.note)?.[0].trim() ?? l.note;
  return `${first.charAt(0).toLowerCase()}${first.slice(1).replace(/;$/, ".")}`;
}

/**
 * A profile's licence for the receipt, or undefined for an unknown profile. Permissive profiles are
 * listed too (commercial "yes", nothing to acknowledge) so Details can name every model; only the
 * others get a line in the receipt and the approve dialog.
 */
export function licenceNote(profileId: string, acknowledged: boolean): LicenceNote | undefined {
  let p;
  try {
    p = profile(profileId);
  } catch {
    return undefined;
  }
  if (p.license.commercial === "yes") {
    return { profile: profileId, title: familyName(profileId), role: ROLE[p.operation] ?? p.operation, name: p.license.name, commercial: "yes", ...(p.license.url ? { url: p.license.url } : {}), acknowledged: true };
  }
  return {
    profile: profileId,
    title: familyName(profileId),
    role: ROLE[p.operation] ?? p.operation,
    name: p.license.name,
    commercial: p.license.commercial,
    note: licenceSentence(profileId),
    ...(p.license.url ? { url: p.license.url } : {}),
    acknowledged,
  };
}

// ---------- template and decode inputs ----------

export function aspectValue(aspect: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(aspect.trim());
  if (m) return Number(m[1]) / Number(m[2]);
  const n = Number(aspect);
  return n > 0 ? n : 9 / 16;
}

export function templateKind(p: { skeleton?: unknown; slots: unknown[] }): TemplateKind {
  return p.skeleton && p.slots.length ? "shot-for-shot" : "freestyle";
}

interface Skeleton {
  canvas?: { width?: number; height?: number; fps?: number; durationSec?: number };
  grid?: { bpm: number; phase?: number };
  shots?: {
    start: Time;
    end: Time;
    source?: { asset?: string; in?: number; speed?: number; speedTo?: number; matte?: string };
    layers?: { start?: Time; end?: Time; source?: { asset?: string; in?: number; speed?: number; speedTo?: number; matte?: string } }[];
  }[];
}

/** How long each skeleton slot's clip must run: max over its uses of in + span × average speed. */
function slotLengths(skeleton: Skeleton, grid: { bpm: number; phase: number }, durationSec: number): Map<string, number> {
  const fps = skeleton.canvas?.fps ?? 30;
  const ctx = { fps, beats: gridBeats(grid, durationSec + 8) };
  const out = new Map<string, number>();
  const use = (asset: string | undefined, start: Time, end: Time, src: { in?: number; speed?: number; speedTo?: number }) => {
    if (!asset?.startsWith("slot:")) return;
    const id = asset.slice(5);
    let span = 0;
    try {
      span = Math.max(0, resolveTime(end, ctx) - resolveTime(start, ctx));
    } catch {
      span = 0;
    }
    const speed = src.speedTo !== undefined ? ((src.speed ?? 1) + src.speedTo) / 2 : (src.speed ?? 1);
    out.set(id, Math.max(out.get(id) ?? 0, (src.in ?? 0) + span * speed));
  };
  for (const s of skeleton.shots ?? []) {
    use(s.source?.asset, s.start, s.end, s.source ?? {});
    use(s.source?.matte, s.start, s.end, s.source ?? {});
    for (const l of s.layers ?? []) {
      use(l.source?.asset, l.start ?? s.start, l.end ?? s.end, l.source ?? {});
      use(l.source?.matte, l.start ?? s.start, l.end ?? s.end, l.source ?? {});
    }
  }
  return out;
}

const clipSec = (raw: number) => Math.min(10, Math.max(1, Math.ceil(raw * 2) / 2));
const MATTE = /[-_]matte$/;

type JobDraft = { line: string; operation: Operation; takes: number; durationSec?: number };

/** The lines a shot-for-shot template needs: the face crop, then each slot the skeleton uses. */
export function skeletonJobs(preset: PresetEntry, grid: { bpm: number; phase: number }, durationSec: number): JobDraft[] {
  const skeleton = (preset.skeleton ?? {}) as Skeleton;
  const lengths = slotLengths(skeleton, grid, durationSec);
  const jobs: JobDraft[] = [{ line: "face", operation: "still.face", takes: 1 }];
  for (const slot of preset.slots) {
    if (!lengths.has(slot.id)) continue;
    const op = slot.operation ?? "";
    const still: Operation = /still\.generate/.test(op) ? "still.generate" : "still.compose";
    if (MATTE.test(slot.id)) {
      const parent = slot.id.replace(MATTE, "");
      jobs.push({ line: slot.id, operation: "matte", takes: 1, durationSec: clipSec(lengths.get(parent) ?? lengths.get(slot.id) ?? 2) });
    } else if (slot.kind === "clip") {
      const clip: Operation = /clip\.r2v/.test(op) ? "clip.r2v" : /clip\.flf/.test(op) ? "clip.flf" : "clip.i2v";
      jobs.push({ line: `${slot.id}-key`, operation: still, takes: 3 });
      jobs.push({ line: slot.id, operation: clip, takes: 1, durationSec: clipSec(lengths.get(slot.id)!) });
    } else if (slot.kind === "still") jobs.push({ line: slot.id, operation: still, takes: 3 });
    else if (slot.kind === "graphic") jobs.push({ line: slot.id, operation: still, takes: 1 });
  }
  return jobs;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function pairedJobs(n: number, clip: number): JobDraft[] {
  return Array.from({ length: n }, (_, i) => [
    { line: `shot${i + 1}-key`, operation: "still.compose" as Operation, takes: 3 },
    { line: `shot${i + 1}`, operation: "clip.i2v" as Operation, takes: 1, durationSec: clip },
  ]).flat();
}

/** What the app knows about a decoded project: its decode state, reference and app.json origin. */
export interface DecodeInfo {
  state?: DecodeState;
  name: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  shots: number;
  meanShotSec: number;
  pages: number;
}

export async function decodeInfo(project: string): Promise<DecodeInfo> {
  if (!ID_PATTERNS.project.test(project)) throw new HttpError(400, "Bad project id.", "BAD_ID");
  const dir = projectDir(project);
  if (!existsSync(join(dir, "project.json"))) throw new HttpError(404, "No such edit.", "NOT_FOUND");
  const ws = await Workspace.open(project);
  const state = await ws.readJson<DecodeState>("analysis/decode.json").catch(() => undefined);
  const breakdown = await ws.readJson<{ shots?: unknown[]; format?: { durationSec?: number; width?: number; height?: number; fpsValue?: number; hasAudio?: boolean } }>("analysis/breakdown.json").catch(() => undefined);
  const pages = (await ws.readJson<unknown[]>("analysis/pages.json").catch(() => undefined))?.length;
  const ref = ws.reference();
  const app = await ws.readJson<{ origin?: { sourceName?: string } }>("app.json").catch(() => undefined);
  const durationSec = state?.format?.durationSec ?? breakdown?.format?.durationSec ?? ref?.durationSec ?? 0;
  const shots = state?.stats?.shots ?? breakdown?.shots?.length ?? state?.cutMap?.shots.length ?? 0;
  return {
    state,
    name: app?.origin?.sourceName ?? state?.name ?? ref?.label ?? "the reference",
    durationSec,
    width: state?.format?.width ?? breakdown?.format?.width ?? ref?.width ?? 1080,
    height: state?.format?.height ?? breakdown?.format?.height ?? ref?.height ?? 1920,
    fps: state?.format?.fps ?? breakdown?.format?.fpsValue ?? ref?.fps ?? 30,
    hasAudio: state?.format?.hasAudio ?? breakdown?.format?.hasAudio ?? ref?.hasAudio ?? false,
    shots,
    meanShotSec: state?.stats?.meanShotSec ?? (shots ? durationSec / shots : 1),
    pages: state?.pages ?? pages ?? Math.ceil(durationSec),
  };
}

// ---------- the person's track ----------

const trackCache = new Map<string, AudioAnalysis>();

/** The media file of a staged upload (inbox/<id>/media<ext>), or of "<project>:<asset>". */
export async function mediaFile(ref: string): Promise<string | undefined> {
  if (ID_PATTERNS.upload.test(ref)) return uploadMediaPath(ref);
  const [project, asset] = ref.split(":");
  if (!project || !asset || !ID_PATTERNS.project.test(project) || !ID_PATTERNS.asset.test(asset)) return undefined;
  try {
    return (await Workspace.open(project)).assetPath(asset);
  } catch {
    return undefined;
  }
}

/** Beat and loudness analysis of the person's track, cached per file. */
export async function trackAnalysis(ref: string): Promise<AudioAnalysis | undefined> {
  const file = await mediaFile(ref);
  if (!file) return undefined;
  const key = `${file}|${statSync(file).mtimeMs}`;
  if (!trackCache.has(key)) trackCache.set(key, await analyzeAudio(file));
  return trackCache.get(key);
}

// ---------- the Claude plan window (from the last run's rate-limit events) ----------

let planWindow: { fiveHour?: number; resetsAt?: string } | undefined;

/** The manager reports the latest 5-hour utilisation it saw, for the receipt's warning. */
export function notePlanWindow(w: { fiveHour?: number; resetsAt?: string } | undefined): void {
  if (w?.fiveHour !== undefined) planWindow = w;
}

function currentPlanWindow(now = Date.now()): number | undefined {
  if (!planWindow?.fiveHour) return undefined;
  if (planWindow.resetsAt && Date.parse(planWindow.resetsAt) < now) return undefined;
  return planWindow.fiveHour;
}

// ---------- the estimate ----------

export interface DraftAnalysis {
  estimate: Estimate;
  /** Everything the first prompt needs except the project id and the approved cap. */
  promptInput: Omit<PromptInput, "project" | "gpuCapMinutes">;
  preset?: PresetEntry;
  decode?: DecodeInfo;
  fields: BriefField[];
  fit?: TrackFit;
  brief?: { file: BriefFile; problems: { field: string; message: string }[] };
  /** Run-only profile overrides and the commercial switch, as the MCP server will see them. */
  overrides: Record<string, string | null>;
  commercial: boolean;
  historyKind: HistoryKind;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** Rounded as katana_plan rounds its minutes, so the receipt and the plan show the same numbers. */
const r1 = (n: number) => +n.toFixed(1);
const up5 = (n: number) => Math.ceil(n / 5) * 5;

function gpuNote(where: BackendWhere, target: string): string {
  if (where === "cloud") return "Uses Comfy Cloud GPU time from your plan. Credits are shared across your workspace.";
  if (where === "local") return "Runs on this computer's GPU.";
  let host = target;
  try {
    host = new URL(target).hostname;
  } catch {
    // keep the target as written
  }
  return `Runs on ${host}.`;
}

function claudeNote(claude: SetupStatus["claude"]): string {
  if (claude.auth === "api-key") return "billed to your Anthropic API key";
  if (claude.auth === "subscription") return `counts toward your ${claude.plan ?? "Claude"} plan`;
  return "counts toward your Claude usage";
}

/** Analyses a draft: the jobs it implies, their numbers, licences and blockers, and the prompt input. */
export async function analyzeDraft(draft: RunDraft, opts: { setup?: SetupStatus; cfg?: Config } = {}): Promise<DraftAnalysis> {
  const cfg = opts.cfg ?? (await loadConfig());
  const [settings, history, setup] = await Promise.all([loadSettings(), loadHistory(), opts.setup ? Promise.resolve(opts.setup) : setupStatus()]);
  const { backend } = currentBackend(cfg);
  const kind = backend?.kind ?? "http";
  const target = backend?.target ?? "http://127.0.0.1:8188";
  const where = whereOf(kind, target);
  const cache = cachedCatalog();
  const catalog = cache && cache.target === target ? cache.catalog : undefined;
  const onDemandModels = Boolean(backend?.onDemandModels);

  let preset: PresetEntry | undefined;
  let decode: DecodeInfo | undefined;
  let fields: BriefField[];
  let jobs: JobDraft[];
  let aspect: number;
  let historyKind: HistoryKind;
  let basis: Estimate["basis"];
  let fit: TrackFit | undefined;
  let format: PromptInput["format"];
  let trackDuration: number | undefined;

  if (draft.kind === "template") {
    if (!draft.template || !ID_PATTERNS.slug.test(draft.template)) throw new HttpError(422, "Pick a template.", "BAD_DRAFT", { problems: [{ field: "template", message: "Pick a template." }] });
    preset = await getPreset(draft.template).catch(() => {
      throw new HttpError(404, `No template "${draft.template}".`, "NOT_FOUND");
    });
    fields = preset.brief as BriefField[];
    aspect = aspectValue(preset.format.aspect);
    const tk = templateKind(preset);
    historyKind = tk;
    const skeleton = (preset.skeleton ?? {}) as Skeleton;
    const baseDuration = skeleton.canvas?.durationSec ?? preset.format.durationSec ?? 15;
    if (draft.musicChoice === "mine" && draft.music) {
      const track = await trackAnalysis(draft.music).catch(() => undefined);
      if (track) {
        trackDuration = track.durationSec;
        try {
          // A freestyle template's tempo is its own track's: the person's track folds toward it.
          const nominalBpm = preset.timing?.nominalBpm ?? (skeleton.grid ? undefined : preset.soundtrack?.bpm);
          fit = fitTrack(track, { ...(skeleton.grid ? { grid: { bpm: skeleton.grid.bpm, phase: skeleton.grid.phase ?? 0 } } : {}), ...(nominalBpm ? { nominalBpm } : {}), ...(preset.timing?.dropBeat !== undefined ? { dropBeat: preset.timing.dropBeat } : {}), durationSec: baseDuration }, draft.alignDrop);
        } catch {
          fit = undefined;
        }
      }
    }
    const durationSec = fit?.durationSec ?? baseDuration;
    if (tk === "shot-for-shot") {
      basis = "skeleton";
      const grid = fit?.grid ?? (skeleton.grid ? { bpm: skeleton.grid.bpm, phase: skeleton.grid.phase ?? 0 } : { bpm: preset.timing?.nominalBpm ?? 120, phase: 0 });
      jobs = skeletonJobs(preset, grid, durationSec);
    } else {
      basis = "recipe";
      jobs = pairedJobs(clamp(Math.round(durationSec / 1.6), 6, 12), 3);
    }
    const w = skeleton.canvas?.width;
    const h = skeleton.canvas?.height;
    const fps = skeleton.canvas?.fps ?? preset.format.fps;
    format = w && h ? { width: w, height: h, fps, aspect: preset.format.aspect } : aspect >= 1 ? { width: Math.round((1080 * aspect) / 2) * 2, height: 1080, fps, aspect: preset.format.aspect } : { width: 1080, height: Math.round(1080 / aspect / 2) * 2, fps, aspect: preset.format.aspect };
  } else {
    if (!draft.project) throw new HttpError(422, "Pick a decoded edit.", "BAD_DRAFT", { problems: [{ field: "project", message: "Pick a decoded edit." }] });
    decode = await decodeInfo(draft.project);
    fields = DECODE_BRIEF;
    aspect = decode.width && decode.height ? decode.width / decode.height : 9 / 16;
    historyKind = "decode";
    basis = "decode";
    const n = draft.mode === "recreate" ? clamp(Math.round(decode.shots * 0.6), 6, 16) : clamp(Math.round(decode.shots * 0.45), 6, 14);
    jobs = pairedJobs(n, Math.min(3, Math.max(1.5, decode.meanShotSec * 2)));
    if (draft.musicChoice === "mine" && draft.music) trackDuration = (await trackAnalysis(draft.music).catch(() => undefined))?.durationSec;
  }

  // Profiles as the MCP server will pick them: config overrides, minus the run's Wan swap.
  const overrides: Record<string, string | null> = draft.clipsModel === "wan22" ? { "clip.i2v": null, "clip.flf": null } : {};
  const effective: Record<string, string> = { ...cfg.profiles };
  for (const [op, v] of Object.entries(overrides)) {
    if (v === null) delete effective[op];
    else effective[op] = v;
  }
  const commercial = draft.commercial || Boolean(cfg.commercial);

  const rows: Estimate["jobs"] = [];
  const raw: { line: string; operation: string; profile: string; minutes: number; overhead: number; takes: number; videoSec?: number }[] = [];
  for (const j of jobs) {
    const profileId = chooseProfile({ operation: j.operation }, { tier: cfg.tier, overrides: effective, commercial, catalog, onDemandModels });
    const spec: JobSpec = { line: j.line, operation: j.operation, prompt: "estimate", takes: j.takes, ...(j.durationSec ? { durationSec: j.durationSec } : {}) };
    const est = estimateSpecFor(spec, profileId, aspect);
    const ratio = await timingRatio(target, profileId);
    const total = adjustedSeconds(est.seconds, j.takes, { ratio, kind });
    const overhead = adjustedSeconds(0, j.takes, { ratio, kind });
    rows.push({ line: j.line, operation: j.operation, profile: profileId, takes: j.takes, ...(j.durationSec ? { videoSec: j.durationSec } : {}), minutes: r1(total / 60) });
    raw.push({ line: j.line, operation: j.operation, profile: profileId, minutes: (total - overhead) / 60, overhead: overhead / 60, takes: j.takes, ...(j.durationSec ? { videoSec: j.durationSec } : {}) });
  }
  const lowExact = raw.reduce((s, j) => s + j.minutes + j.overhead, 0);
  const low = r1(lowExact);
  const high = r1(lowExact * 1.35);

  // Groups for the receipt.
  const groupDefs: { label: string; match: (op: string) => boolean; detail: (js: typeof raw) => string }[] = [
    { label: "Keyframes", match: (op) => op === "still.compose" || op === "still.generate", detail: (js) => `${js.length} line${js.length === 1 ? "" : "s"} · ${js.reduce((s, j) => s + j.takes, 0)} takes` },
    { label: "Face crop", match: (op) => op === "still.face", detail: () => "1 crop of your face photo" },
    { label: "Clips", match: (op) => op.startsWith("clip."), detail: (js) => `${js.length} clip${js.length === 1 ? "" : "s"} · ${Math.min(...js.map((j) => j.videoSec ?? 2))}–${Math.max(...js.map((j) => j.videoSec ?? 2))} s` },
    { label: "Cut-outs", match: (op) => op === "matte", detail: (js) => `${js.length} cut-out${js.length === 1 ? "" : "s"}` },
  ];
  const groups: Estimate["groups"] = [];
  for (const g of groupDefs) {
    const js = raw.filter((j) => g.match(j.operation));
    if (!js.length) continue;
    const counts = new Map<string, number>();
    for (const j of js) counts.set(j.profile, (counts.get(j.profile) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    const m = js.reduce((s, j) => s + j.minutes, 0);
    groups.push({ label: g.label, detail: g.detail(js), profile: top, profileTitle: profile(top).title, minutes: { low: r1(m), high: r1(m * 1.35) } });
  }
  const overheadMin = raw.reduce((s, j) => s + j.overhead, 0);
  const takes = raw.reduce((s, j) => s + j.takes, 0);
  if (overheadMin > 0) groups.push({ label: "Queueing", detail: `${takes} job${takes === 1 ? "" : "s"} on ${where === "cloud" ? "Comfy Cloud" : target}`, profile: "", profileTitle: "Queueing, uploads and downloads", minutes: { low: r1(overheadMin), high: r1(overheadMin * 1.35) } });

  // Claude and wall clock.
  const claudeRange = costRange(history, historyKind) ?? CLAUDE_SEEDS[historyKind];
  const pageUsd = historyKind === "decode" && !costRange(history, historyKind) ? PER_PAGE_USD * (decode?.pages ?? 0) : 0;
  const claudeLow = Math.round((claudeRange[0] + pageUsd) * 2) / 2;
  const claudeHigh = Math.round((claudeRange[1] + pageUsd) * 2) / 2;
  const wall = wallRange(history, historyKind) ?? WALL_SEEDS[historyKind];
  const fiveHour = currentPlanWindow();

  // Licences of the profiles actually chosen.
  const chosen = [...new Set(rows.map((r) => r.profile))];
  const licences = chosen.map((id) => licenceNote(id, settings.licencesAcknowledged.includes(id))).filter((l): l is LicenceNote => Boolean(l));
  const canUseWan22 = rows.some((r) => (r.operation === "clip.i2v" || r.operation === "clip.flf") && r.profile.startsWith("minimax-h3-"));

  const warnings: Estimate["warnings"] = [];
  if (where === "cloud") warnings.push({ code: "SHARED_CREDITS", message: "Credits are shared across your Comfy workspace." });
  if (fiveHour !== undefined && fiveHour > 0.7) warnings.push({ code: "PLAN_WINDOW", message: `Your Claude plan is at ${Math.round(fiveHour * 100)}% of its 5-hour limit. The edit may pause until it resets.` });
  if (decode && decode.durationSec > 30) warnings.push({ code: "LONG_EDIT", message: "Longer edits cost more for the director to study." });
  const editSec = fit ? fit.offsetSec + fit.durationSec : decode?.durationSec ?? 0;
  if (trackDuration !== undefined && editSec > trackDuration + 0.05) warnings.push({ code: "TRACK_SHORT", message: "Your track ends before the edit does." });

  const blockers: Estimate["blockers"] = setup.blockers.map((b) => ({ ...b, action: b.code === "FFMPEG_MISSING" ? "How" : b.code === "GPU_ENV_SECRET" ? "Save it" : "Set up" }));
  if (catalog && !onDemandModels) {
    const missing = chosen.filter((id) => !checkProfile(profile(id), catalog).runnable);
    if (missing.length) {
      const names = missing.map((id) => modelWithRole(id));
      blockers.push({ code: "MODELS_MISSING", message: `${draft.kind === "decode" ? "This edit" : "This template"} needs models your ComfyUI doesn't have: ${names.join(", ")}.`, action: "See what's missing" });
    }
  }

  // The key covers what changes the numbers or the run, never the words, the note, the title or the caps.
  const keyed = { kind: draft.kind, template: draft.template, project: draft.project, photos: draft.photos, music: draft.music, musicChoice: draft.musicChoice, alignDrop: draft.alignDrop, mode: draft.mode, planFirst: draft.planFirst, commercial: draft.commercial, clipsModel: draft.clipsModel };
  const key = createHash("sha256").update(JSON.stringify(canonical({ draft: keyed, profiles: chosen.sort(), low, high }))).digest("hex").slice(0, 16);

  const estimate: Estimate = {
    key,
    basis,
    gpu: { lowMin: low, highMin: high, suggestedCapMin: Math.max(5, up5(high * 1.15)), where, target, note: gpuNote(where, target) },
    claude: {
      lowUsd: claudeLow,
      highUsd: claudeHigh,
      suggestedCapUsd: Math.max(settings.defaultClaudeCapUsd, up5(claudeHigh * 1.6)),
      auth: setup.claude.auth ?? "unknown",
      ...(setup.claude.plan ? { plan: setup.claude.plan } : {}),
      note: claudeNote(setup.claude),
      ...(fiveHour !== undefined ? { fiveHourUtilization: fiveHour } : {}),
    },
    wall: { lowMin: Math.round(wall[0]), highMin: Math.round(wall[1]) },
    groups,
    jobs: rows,
    licences,
    canUseWan22,
    ...(fit ? { track: fit } : {}),
    warnings,
    blockers,
  };

  // The brief: the person's words for the prompt (validation happens when the run starts).
  let brief: DraftAnalysis["brief"];
  try {
    brief = resolveBrief(preset, draft.brief, { ...(fit ? { fit } : {}), musicChoice: draft.musicChoice, ...(draft.kind === "decode" ? { fields: DECODE_BRIEF } : {}) });
  } catch {
    brief = undefined;
  }
  const bound = brief?.file.words.map((w) => ({ index: w.index, text: w.text })) ?? [];
  const promptInput: DraftAnalysis["promptInput"] = {
    kind: draft.kind,
    ...(preset ? { template: { slug: preset.slug, title: preset.title, kind: templateKind(preset) } } : {}),
    ...(decode ? { reference: { name: decode.name, durationSec: decode.durationSec } } : {}),
    mode: draft.mode,
    photos: draft.photos.length,
    ...(draft.kind === "template" && draft.musicChoice === "template" ? { music: { source: "template" as const } } : {}),
    ...(draft.musicChoice === "mine" && draft.music ? { music: { source: "mine" as const, ...(fit ? { bpm: fit.bpm, offsetSec: fit.offsetSec, aligned: fit.aligned } : {}) } } : {}),
    ...(draft.kind === "decode" ? { sound: draft.musicChoice === "original" ? ("original" as const) : ("mine" as const) } : {}),
    ...(format ? { format } : {}),
    brief: briefLines(fields, draft.brief),
    ...(draft.note ? { note: draft.note } : {}),
    words: bound,
    verbatim: brief?.file.verbatim ?? [],
    planFirst: draft.planFirst,
  };
  return { estimate, promptInput, preset, decode, fields, fit, brief, overrides, commercial, historyKind };
}

/** The receipt before any agent runs, and the exact first prompt (spec §9.14). */
export async function estimateDraft(draft: RunDraft): Promise<{ estimate: Estimate; prompt: string }> {
  const a = await analyzeDraft(draft);
  return { estimate: a.estimate, prompt: firstPrompt({ ...a.promptInput, project: draft.kind === "decode" && draft.project ? draft.project : NEW_PROJECT, gpuCapMinutes: a.estimate.gpu.suggestedCapMin }) };
}
