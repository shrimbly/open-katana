import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { adjustedSeconds, type JobRecord, JobRecordSchema, timingRatio } from "../../comfy/jobs.js";
import { type Preset, PresetSchema } from "../../presets/library.js";
import { type Project, ProjectSchema, Workspace } from "../../project/workspace.js";
import { type Edl, EdlSchema } from "../../render/edl.js";
import { cutMapFromEdl, cutMapFromPreset } from "../cutmap.js";
import { ApprovalFileSchema, BriefFileSchema, UserPicksFileSchema } from "../schemas.js";
import type { ApprovalFile, BriefFile, CutMapData, DecodeState, PlanEstimate, UserPick } from "../types.js";
import { classOf, type PhaseClass } from "./reducer.js";

/**
 * The project files a run's state is built from (spec §9.8, file side). Reads tolerate half-written
 * or bad JSON by keeping the last good value, so a write in progress never blanks the page.
 */
export interface FileSnapshot {
  project?: Project;
  preset?: Preset;
  estimate?: { totalMinutes: number; jobs: PlanEstimate["jobs"] };
  plan?: { concept?: string; jobs: { line: string; operation: string }[] };
  jobs: JobRecord[];
  verdicts: { asset: string; verdict: "accept" | "reject"; reason?: string; at?: string }[];
  picks: UserPick[];
  edl?: Edl;
  brief?: BriefFile;
  approval?: ApprovalFile;
  preview?: { mtime: number };
  /** Identity panels in qa/ (`<ids>-vs-<subject>.jpg`). */
  panels: string[];
  decode?: DecodeState;
  /** analysis/pages.json length. */
  pages?: number;
  /** The base map: the cut once render/edl.json exists, else the template's or the decoded edit's. */
  cutMap?: CutMapData;
  gpu: { committedMin: number; doneSec: Record<PhaseClass, number>; plannedSec: Record<PhaseClass, number> };
  /** version → silent copy (project-relative), when one exists. */
  silent: Record<number, string>;
  /** version → size in MB. */
  sizes: Record<number, number>;
  /** Last time a watched file changed (ms). */
  changedAt: number;
}

export function emptySnapshot(now = Date.now()): FileSnapshot {
  return { jobs: [], verdicts: [], picks: [], panels: [], gpu: { committedMin: 0, doneSec: { stills: 0, clips: 0, mattes: 0 }, plannedSec: { stills: 0, clips: 0, mattes: 0 } }, silent: {}, sizes: {}, changedAt: now };
}

type Parse<T> = (data: unknown) => T | undefined;
const zodParse =
  <T>(schema: { safeParse: (d: unknown) => { success: true; data: T } | { success: false } }): Parse<T> =>
  (d) => {
    const r = schema.safeParse(d);
    return r.success ? r.data : undefined;
  };

/** Reads one JSON file; `keep` is returned when the file is missing-but-was-there or unreadable. */
async function readJson<T>(file: string, parse: Parse<T>, keep: T | undefined): Promise<T | undefined> {
  if (!existsSync(file)) return undefined;
  try {
    return parse(JSON.parse(await readFile(file, "utf8"))) ?? keep;
  } catch {
    return keep;
  }
}

const mtime = (file: string) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

const asVerdicts: Parse<FileSnapshot["verdicts"]> = (d) =>
  Array.isArray(d) ? d.filter((v): v is FileSnapshot["verdicts"][number] => typeof v?.asset === "string" && (v.verdict === "accept" || v.verdict === "reject")) : undefined;
const asJobs: Parse<JobRecord[]> = (d) => (Array.isArray(d) ? d.map((j) => JobRecordSchema.safeParse(j)).filter((r) => r.success).map((r) => r.data) : undefined);
const asEstimate: Parse<FileSnapshot["estimate"]> = (d) => {
  const e = d as { totalMinutes?: unknown; jobs?: unknown };
  if (typeof e?.totalMinutes !== "number" || !Array.isArray(e.jobs)) return undefined;
  return {
    totalMinutes: e.totalMinutes,
    jobs: (e.jobs as Record<string, unknown>[]).map((j) => ({
      line: String(j.line ?? ""),
      operation: String(j.operation ?? ""),
      profile: String(j.profile ?? ""),
      takes: Number(j.takes ?? 1),
      video: String(j.video ?? ""),
      minutes: Number(j.minutes ?? 0),
    })),
  };
};
const asPlan: Parse<FileSnapshot["plan"]> = (d) => {
  const p = d as { concept?: unknown; jobs?: unknown };
  if (!p || typeof p !== "object") return undefined;
  const jobs = (Array.isArray(p.jobs) ? p.jobs : []) as { line?: unknown; operation?: unknown }[];
  return {
    ...(typeof p.concept === "string" ? { concept: p.concept } : {}),
    jobs: jobs.filter((j) => typeof j.line === "string" && typeof j.operation === "string").map((j) => ({ line: j.line as string, operation: j.operation as string })),
  };
};
const asPages: Parse<number> = (d) => (Array.isArray(d) ? d.length : undefined);
const asDecode: Parse<DecodeState> = (d) => (d && typeof d === "object" && typeof (d as DecodeState).project === "string" ? (d as DecodeState) : undefined);

/** Where the map's inputs were when it was last built, so it is rebuilt only when they change. */
interface MapKey {
  edl: number;
  preset: number;
  brief: number;
  decode: number;
}

/**
 * Reads the project's files into a snapshot. `prev` supplies the last good values (and the cut map,
 * rebuilt only when the EDL, preset, brief or decode changed). `backend` is the current target, for
 * the GPU minutes committed.
 */
export async function readSnapshot(dir: string, prev: FileSnapshot | undefined, backend: { kind: string; target: string }, opts: { cutMap?: boolean } = {}): Promise<FileSnapshot> {
  const at = (rel: string) => join(dir, rel);
  const snap = emptySnapshot(prev?.changedAt);
  snap.project = await readJson(at("project.json"), zodParse(ProjectSchema), prev?.project);
  snap.preset = await readJson(at("plan/preset.json"), zodParse(PresetSchema), prev?.preset);
  snap.estimate = await readJson(at("plan/estimate.json"), asEstimate, prev?.estimate);
  snap.plan = await readJson(at("plan/plan.json"), asPlan, prev?.plan);
  snap.jobs = (await readJson(at("plan/jobs.json"), asJobs, prev?.jobs)) ?? [];
  snap.verdicts = (await readJson(at("qa/verdicts.json"), asVerdicts, prev?.verdicts)) ?? [];
  snap.picks = (await readJson(at("qa/user-picks.json"), zodParse(UserPicksFileSchema), prev?.picks ? { v: 1 as const, picks: prev.picks } : undefined))?.picks ?? [];
  snap.edl = await readJson(at("render/edl.json"), zodParse(EdlSchema), prev?.edl);
  snap.brief = await readJson(at("plan/brief.json"), zodParse(BriefFileSchema), prev?.brief);
  snap.approval = await readJson(at("plan/approval.json"), zodParse(ApprovalFileSchema), prev?.approval);
  snap.decode = await readJson(at("analysis/decode.json"), asDecode, prev?.decode);
  snap.pages = await readJson(at("analysis/pages.json"), asPages, prev?.pages);
  const preview = mtime(at("render/preview.mp4"));
  if (preview) snap.preview = { mtime: preview };
  snap.panels = existsSync(at("qa")) ? (await readdir(at("qa")).catch(() => [] as string[])).filter((n) => /-vs-.*\.jpe?g$/i.test(n)).sort() : [];

  for (const v of snap.project?.versions ?? []) {
    const silent = v.path.replace(/\.mp4$/i, "_silent.mp4");
    if (silent !== v.path && existsSync(at(silent))) snap.silent[v.version] = silent;
    try {
      snap.sizes[v.version] = +(statSync(at(v.path)).size / 2 ** 20).toFixed(1);
    } catch {
      // The file may still be moving into place.
    }
  }

  // GPU minutes: committed over every job that ran or may still run; done and planned per class.
  const ratios = new Map<string, number>();
  const ratio = async (target: string, profile: string) => {
    const key = `${target}|${profile}`;
    if (!ratios.has(key)) ratios.set(key, await timingRatio(target, profile).catch(() => 1));
    return ratios.get(key)!;
  };
  for (const j of snap.jobs) {
    if (j.state === "error" || j.state === "cancelled") continue;
    const sec = adjustedSeconds(j.estimateSec, 1, { ratio: await ratio(j.backend, j.profile), kind: backend.kind });
    snap.gpu.committedMin += sec / 60;
    if (j.state === "completed") snap.gpu.doneSec[classOf(j.spec.operation)] += sec;
  }
  for (const j of snap.estimate?.jobs ?? []) snap.gpu.plannedSec[classOf(j.operation)] += j.minutes * 60;

  if (opts.cutMap === false) {
    snap.cutMap = prev?.cutMap;
    return snap;
  }
  const key: MapKey = { edl: mtime(at("render/edl.json")), preset: mtime(at("plan/preset.json")), brief: mtime(at("plan/brief.json")), decode: mtime(at("analysis/decode.json")) };
  const prevKey = mapKeys.get(dir);
  if (prev?.cutMap && prevKey && JSON.stringify(prevKey) === JSON.stringify(key)) snap.cutMap = prev.cutMap;
  else {
    snap.cutMap = await baseCutMap(dir, snap).catch(() => prev?.cutMap);
    mapKeys.set(dir, key);
  }
  return snap;
}

const mapKeys = new Map<string, MapKey>();

async function baseCutMap(dir: string, snap: FileSnapshot): Promise<CutMapData | undefined> {
  if (snap.edl && snap.project) {
    const fromEdl = await cutMapFromEdl(await Workspace.open(dir)).catch(() => undefined);
    if (fromEdl) return fromEdl;
  }
  if (snap.preset) {
    try {
      return cutMapFromPreset(snap.preset, { ...(snap.brief?.grid ? { grid: snap.brief.grid } : {}), ...(snap.brief?.durationSec ? { durationSec: snap.brief.durationSec } : {}) });
    } catch {
      // Cut maps are decoration: a template the map builder cannot read just shows none.
    }
  }
  return snap.decode?.cutMap;
}

const IGNORED = /^(render[/\\](cache|thumbs)|runs)([/\\]|$)/;

/**
 * Watches a project directory (recursively, debounced 200 ms) and calls `onChange`. The manager
 * also polls every 2 s, so a missed event only delays an update.
 */
export class ProjectWatcher {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly dir: string,
    private readonly onChange: () => void,
    /** One path under an ignored folder that still counts (the run's own stream). */
    private readonly also?: string,
  ) {}

  start(): void {
    if (this.watcher || !existsSync(this.dir)) return;
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_e, name) => {
        const rel = name ? String(name).replaceAll("\\", "/") : "";
        if (rel && IGNORED.test(rel) && rel !== this.also) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(this.onChange, 200);
      });
      this.watcher.on("error", () => this.close());
    } catch {
      // No recursive watch on this platform: the 2 s poll still updates the page.
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
