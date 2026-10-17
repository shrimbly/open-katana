import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelOpenJobs } from "../../comfy/jobs.js";
import { loadConfig } from "../../config.js";
import { getPreset, type Preset, PresetSchema } from "../../presets/library.js";
import { projectsRoot, Workspace, writeFileAtomic } from "../../project/workspace.js";
import { dataHome } from "../../util/paths.js";
import { writeSilentCopy } from "../export.js";
import { isId } from "../http.js";
import { acquireProjectLock, lockedBy, releaseProjectLock } from "../project-lock.js";
import { withProject } from "../projects.js";
import { HttpError } from "../router.js";
import { ContinueRunSchema, StartRunSchema } from "../schemas.js";
import { loadSettings, saveSettings } from "../settings.js";
import { claudeIdentity, claudePath, currentBackend, setupStatus } from "../setup.js";
import type { AppJson, ApprovalFile, ContinueRun, FieldProblem, LicenceNote, RunDiagnostics, RunRecord, RunState, RunSummary, SetupStatus, StartRun } from "../types.js";
import { takeSoundtrack, takeUploads } from "../uploads.js";
import { budgetFor, claudeArgs, MIN_BUDGET_USD } from "./args.js";
import { analyzeDraft, licenceNote, notePlanWindow, templateKind } from "./estimate.js";
import { appendSample, type HistoryKind, loadHistory, phaseMedians } from "./history.js";
import { type ContinueReason, continuePrompt, firstPrompt, freshSessionPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { estimateUsd } from "./pricing.js";
import { attemptEnd, attemptPhaseSec, attentionMessage, buildState, failureCopy, HOLDS_LOCK, newFacts, PHASES, reduce, resumeMissing, seedPhase, type StreamFacts, summarize, usesSlot } from "./reducer.js";
import { findRun, listRunRecords, newRunId, projectDir, RUN_FILES, readAppJson, readRun, runDir, writeAppJson, writeRun } from "./store.js";
import { LineTailer, markerLine, parseLine } from "./stream.js";
import { isAlive, keepAwake, killGroup, procCommand, procStart, spawnDirector, waitGroupGone, writeMcpConfig } from "./spawn.js";
import { emptySnapshot, type FileSnapshot, ProjectWatcher, readSnapshot } from "./watch.js";

/**
 * Starts, watches, adopts, cancels and continues director runs (spec §9). Only the app owner has one.
 * The director runs detached and writes to files; this class only reads those files and the project's,
 * so runs survive a server restart and a new server adopts them.
 */

const POLL_MS = 2_000;
const EMIT_MS = 250;
const RESULT_GRACE_MS = 20_000;
const STDERR_TAIL_BYTES = 16_384;
const TERMINAL = new Set(["done", "failed", "cancelled", "interrupted"]);

interface Live {
  rec: RunRecord;
  facts: StreamFacts;
  files: FileSnapshot;
  state: RunState;
  historyKind: HistoryKind;
  tailer?: LineTailer;
  watcher?: ProjectWatcher;
  child?: ChildProcess;
  exit?: { code: number | null; signal: string | null };
  caffeinate?: number;
  /** Highest pct of the current attempt. */
  floorPct: number;
  /** A poll saw the director gone; the next one that reads nothing new finalizes the attempt. */
  goneSeen?: boolean;
  resultAt?: number;
  killedForInit?: boolean;
  startNow?: boolean;
  polling?: Promise<void>;
  again?: boolean;
  finalizing?: boolean;
  /** An attempt is being launched: polls wait, since the facts and exit still describe the last attempt. */
  launching?: boolean;
  lastEmit: number;
  emitTimer?: NodeJS.Timeout;
  summaryKey?: string;
}

const iso = () => new Date().toISOString();
const up5 = (n: number) => Math.ceil(n / 5) * 5;

/** Every environment value longer than 8 characters, replaced in diagnostics. */
function redact(text: string): string {
  const values = Object.values(process.env)
    .filter((v): v is string => typeof v === "string" && v.length > 8)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join("•••");
  return out;
}

async function tail(file: string, bytes = STDERR_TAIL_BYTES): Promise<string> {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const fh = await open(file, "r");
  try {
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function zodProblems(issues: { path: PropertyKey[]; message: string }[]): FieldProblem[] {
  return issues.map((i) => ({ field: i.path.map(String).join(".") || "request", message: i.message }));
}

export class RunManager {
  private readonly runs = new Map<string, Live>();
  private readonly emitState: (project: string, state: RunState) => void;
  private readonly emitRuns: (runs: RunSummary[]) => void;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private scheduling: Promise<void> = Promise.resolve();
  private phaseCache = new Map<HistoryKind, { at: number; minutes: Partial<Record<(typeof PHASES)[number], number>> }>();

  constructor(opts: { emit: (project: string, state: RunState) => void; emitRuns: (runs: RunSummary[]) => void; now?: () => number }) {
    this.emitState = opts.emit;
    this.emitRuns = opts.emitRuns;
    this.now = opts.now ?? Date.now;
  }

  // ---------- reading ----------

  get(runId: string): RunState | undefined {
    return this.runs.get(runId)?.state;
  }

  async latestFor(project: string): Promise<RunState | undefined> {
    if (!isId("project", project)) return undefined;
    const app = await readAppJson(project);
    const rid = app?.runs.at(-1);
    if (!rid) return undefined;
    const live = this.runs.get(rid) ?? (await this.loadById(project, rid));
    return live?.state;
  }

  list(filter: { active?: boolean } = {}): RunSummary[] {
    return [...this.runs.values()]
      .filter((l) => !filter.active || HOLDS_LOCK.has(l.rec.status))
      .map((l) => summarize(l.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async diagnostics(runId: string): Promise<RunDiagnostics> {
    const live = this.mustGet(runId);
    return diagnosticsOf(live.rec, live.facts.warnings);
  }

  /** Re-reads a run's project files now (after the app wrote one, such as a pick). */
  refresh(project: string): void {
    for (const live of this.runs.values()) if (live.rec.project === project) this.kick(live);
  }

  // ---------- lifecycle ----------

  /** Adopts, finishes or interrupts runs found on disk, then schedules the queue (spec §9.10). */
  async reconcile(): Promise<void> {
    for (const rec of await listRunRecords()) {
      if (this.runs.has(rec.id)) continue;
      const live = await this.load(rec, !TERMINAL.has(rec.status));
      const attempt = rec.attempts.at(-1);
      if (rec.status === "stopping") {
        void this.finishCancel(live);
        continue;
      }
      if (rec.status === "starting" || rec.status === "running") {
        if (attempt?.pid && isAlive(attempt.pid) && (await this.sameProcess(attempt.pid, attempt.procStart))) {
          // Adopted: keep reading the stream from where the re-parse ended.
          this.watch(live);
          this.rebuild(live);
          continue;
        }
        if (live.facts.result) {
          await this.finalize(live);
          continue;
        }
        // Gone without a result while nobody watched. Its GPU jobs are left alone: Continue's
        // katana_wait collects them. What it spent is counted from its tokens.
        live.tailer = undefined;
        // It ended when its stream went quiet, not when this server noticed.
        const quiet = live.facts.lastLineAt && attempt && live.facts.lastLineAt > Date.parse(attempt.startedAt) ? live.facts.lastLineAt : undefined;
        if (attempt && !attempt.endedAt) this.closeAttempt(live, quiet);
        rec.status = "interrupted";
        rec.endedAt = iso();
        releaseProjectLock(projectDir(rec.project), rec.id);
        await rm(join(runDir(rec.project, rec.id), RUN_FILES.mcp), { force: true });
        await writeRun(rec);
        this.rebuild(live);
        continue;
      }
      live.tailer = undefined;
      if (HOLDS_LOCK.has(rec.status)) this.watch(live);
      this.rebuild(live);
    }
    await this.sweepLocks();
    this.ensureTimer();
    this.emitAll();
    await this.schedule();
  }

  /** Stops watchers and timers; never kills directors. */
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const live of this.runs.values()) {
      live.watcher?.close();
      live.watcher = undefined;
      clearTimeout(live.emitTimer);
    }
  }

  // ---------- starting ----------

  async start(raw: StartRun): Promise<{ run: RunState; project: string }> {
    const parsed = StartRunSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(422, "Some of the details need fixing.", "BAD_REQUEST", { problems: zodProblems(parsed.error.issues) });
    const req = parsed.data;

    const setup = await setupStatus({ fresh: "gpu" });
    if (setup.blockers.length) throw new HttpError(412, setup.blockers[0]!.message, "SETUP", { setup });
    const a = await analyzeDraft(req, { setup });

    const problems: FieldProblem[] = [...musicProblems(req, a.preset, a.decode?.hasAudio ?? false)];
    if (!a.brief) throw new HttpError(500, "The template's brief could not be read.", "BRIEF");
    problems.push(...a.brief.problems);
    if (req.note && a.preset && req.note.length > a.preset.inputs.instructionsMaxChars) problems.push({ field: "note", message: `Keep the note under ${a.preset.inputs.instructionsMaxChars} characters.` });
    if (a.preset && req.photos.length > a.preset.inputs.images.max) problems.push({ field: "photos", message: `This template takes up to ${a.preset.inputs.images.max} photos.` });
    if (problems.length) throw new HttpError(422, problems[0]!.message, "PROBLEMS", { problems });
    if (a.estimate.key !== req.approval.estimateKey) throw new HttpError(409, "The estimate changed. Check the new numbers.", "ESTIMATE_CHANGED", { estimate: a.estimate });
    if (a.estimate.blockers.length) throw new HttpError(412, a.estimate.blockers[0]!.message, "SETUP", { setup });

    // The project: a new one for a template, the decoded one for a decode run.
    let ws: Workspace;
    let app: AppJson;
    const now = iso();
    if (req.kind === "template") {
      const preset = a.preset!;
      ws = await Workspace.create({ title: req.title ?? preset.title, mode: "remix", preset: preset.slug });
      await ws.writeJson("plan/preset.json", PresetSchema.parse(preset satisfies Preset));
      app = { v: 1, origin: { kind: "template", template: preset.slug }, runs: [], createdAt: now };
    } else {
      const id = req.project!;
      const existing = await readAppJson(id);
      if (existing?.origin.kind !== "decode") throw new HttpError(409, "That isn't a decoded edit.", "BUSY");
      if (existing.runs.length) {
        const last = this.runs.get(existing.runs.at(-1)!);
        throw new HttpError(409, "This edit already has a run. Make another to start again.", "BUSY", last ? { run: summarize(last.state) } : {});
      }
      const decoded = a.decode?.state?.status === "done" || existsSync(join(projectDir(id), "analysis", "pages.json"));
      if (!decoded) throw new HttpError(409, "Still preparing frames for the director. Try again in a moment.", "BUSY");
      ws = await Workspace.open(id);
      app = existing;
    }
    const project = ws.project.id;
    const dir = projectDir(project);
    const rid = newRunId();
    if (!acquireProjectLock(dir, rid)) {
      const holder = lockedBy(dir);
      const live = holder ? this.runs.get(holder) : undefined;
      throw new HttpError(409, "This edit is already being made.", "BUSY", live ? { run: summarize(live.state) } : {});
    }

    const settings = await loadSettings();
    const id = claudeIdentity();
    const rec: RunRecord = {
      v: 1,
      id: rid,
      project,
      kind: req.kind,
      status: "queued",
      title: req.title ?? (a.preset?.title ?? ws.project.title),
      ...(a.preset ? { template: a.preset.slug } : {}),
      sessionId: randomUUID(),
      model: settings.model,
      claude: { path: id.path ?? claudePath() ?? "claude", version: id.version ?? setup.claude.version ?? "unknown", auth: setup.claude.auth ?? id.auth, ...(setup.claude.plan ? { plan: setup.claude.plan } : {}) },
      caps: { gpuMinutes: req.approval.gpuCapMinutes, claudeUsd: req.approval.claudeCapUsd },
      planFirst: req.planFirst,
      overrides: { profiles: a.overrides, commercial: a.commercial },
      attempts: [],
      spentUsd: 0,
      versionsAtStart: ws.project.versions.length,
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      await withProject(project, async (w) => {
        await takeUploads(w, { photos: req.photos, ...(req.musicChoice === "mine" && req.music ? { music: req.music } : {}) });
        // The template's own track (the default choice): plan/brief.json and the prompt name it asset "music".
        if (req.kind === "template" && req.musicChoice === "template") await takeSoundtrack(w, a.preset!);
      });
      const { approval: _approval, consent: _consent, ...draft } = req;
      await writeAppJson(project, { ...app, draft, runs: [...app.runs, rid] });
      await ws.writeJson("plan/brief.json", a.brief.file);
      if (!req.planFirst) await writeApproval(project, rid, rec.caps, a.estimate.key, "start");
      const rdir = runDir(project, rid);
      await mkdir(rdir, { recursive: true });
      await writeFile(join(rdir, RUN_FILES.system), SYSTEM_PROMPT);
      await writeFile(join(rdir, RUN_FILES.prompt(1)), firstPrompt({ ...a.promptInput, project, gpuCapMinutes: rec.caps.gpuMinutes }));
      await writeRun(rec);
    } catch (e) {
      releaseProjectLock(dir, rid);
      // A template run's project was made for this start only: nothing in it is worth keeping.
      if (req.kind === "template") await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    // The licence notes the person saw with this approval are acknowledged (the dialog shows once per profile).
    const shown = req.approval.licencesShown.filter((p) => a.estimate.licences.some((l) => l.profile === p && l.commercial !== "yes"));
    if (shown.length) await saveSettings({ licencesAcknowledged: shown }).catch(() => undefined);

    const live = await this.load(rec, false);
    live.historyKind = a.historyKind;
    this.watch(live);
    this.ensureTimer();
    // Claim a free slot before answering, so the answer says "starting", not "waiting for another edit".
    await this.schedule();
    this.rebuild(live);
    return { run: live.state, project };
  }

  async startNow(runId: string): Promise<RunSummary> {
    const live = this.mustGet(runId);
    if (live.rec.status !== "queued") throw new HttpError(409, "This edit isn't waiting to start.", "NOT_QUEUED");
    live.startNow = true;
    await this.schedule();
    return summarize(live.state);
  }

  // ---------- continuing ----------

  async continue(runId: string, raw: ContinueRun): Promise<RunSummary> {
    const parsed = ContinueRunSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new HttpError(422, "Some of the details need fixing.", "BAD_REQUEST", { problems: zodProblems(parsed.error.issues) });
    const req = parsed.data;
    const live = this.mustGet(runId);
    const rec = live.rec;
    const reply = req.reply?.trim();
    const continuable = rec.status === "paused" || rec.status === "interrupted" || rec.status === "cancelled" || rec.status === "done" || (rec.status === "failed" && rec.failure?.resumable);
    if (!continuable) throw new HttpError(409, "This edit can't be continued now.", "NOT_CONTINUABLE");
    if ((rec.status === "done" || rec.attention?.code === "QUESTION") && !reply) throw new HttpError(422, "Say what should change.", "PROBLEMS", { problems: [{ field: "reply", message: "Say what should change." }] });

    const dir = projectDir(rec.project);
    if (!HOLDS_LOCK.has(rec.status) && !acquireProjectLock(dir, rec.id)) throw new HttpError(409, "Another edit is being made in this project.", "BUSY");
    // A template run that keeps the template's track needs it as asset "music" (runs started before it was imported).
    try {
      await this.ensureSoundtrack(rec);
    } catch (e) {
      if (!HOLDS_LOCK.has(rec.status)) releaseProjectLock(dir, rec.id);
      throw e;
    }

    // New totals: what the person approved, else the defaults of spec §9.13.
    const cap = rec.caps;
    const attention = rec.attention;
    let gpu = req.approval?.gpuCapMinutes ?? cap.gpuMinutes;
    let usd = req.approval?.claudeCapUsd ?? cap.claudeUsd;
    const reasons: ContinueReason[] = [];
    let approvalReason: ApprovalFile["history"][number]["reason"] = "continue";
    if (rec.status === "done") {
      const latest = live.files.project?.versions.at(-1)?.version ?? rec.delivered?.version ?? 1;
      if (!req.approval?.gpuCapMinutes) gpu = up5(Math.max(cap.gpuMinutes, live.files.gpu.committedMin + 10));
      if (!req.approval?.claudeCapUsd) usd = Math.max(cap.claudeUsd, up5(rec.spentUsd + 5));
      reasons.push({ kind: "changes", version: latest, reply: reply! });
      approvalReason = "top-up";
    } else if (rec.status === "paused" && attention) {
      switch (attention.code) {
        case "NEEDS_APPROVAL":
          reasons.push({ kind: "approve", gpuMinutes: gpu });
          approvalReason = "plan-approved";
          break;
        case "BUDGET_CAP":
          if (req.fit) reasons.push({ kind: "fit", gpuMinutes: gpu });
          else {
            if (!req.approval?.gpuCapMinutes) gpu = Math.max(cap.gpuMinutes, up5((attention.needsMinutes ?? cap.gpuMinutes) * 1.1));
            reasons.push({ kind: "approve", gpuMinutes: gpu });
            approvalReason = "top-up";
          }
          break;
        case "OUT_OF_CREDITS":
          reasons.push(req.finishPartial ? { kind: "partial" } : { kind: "credits" });
          break;
        case "BACKEND_DOWN":
          reasons.push({ kind: "backend" });
          break;
        case "USAGE_LIMIT":
          reasons.push({ kind: "usage" });
          break;
        case "USD_CAP":
          if (!req.approval?.claudeCapUsd) usd = cap.claudeUsd + 5;
          reasons.push({ kind: "usd" });
          approvalReason = "top-up";
          break;
        case "QUESTION":
          reasons.push({ kind: "question", reply: reply! });
          break;
      }
    } else {
      const why = rec.status === "interrupted" ? "the computer may have restarted or gone to sleep" : rec.status === "cancelled" ? "the person stopped it in the app" : (rec.failure?.message ?? "it failed").replace(/\s*Everything made so far is saved\.$/, "").replace(/\.$/, "");
      reasons.push({ kind: "stopped", reason: why });
    }
    if (req.finishPartial && !reasons.some((r) => r.kind === "partial")) reasons.push({ kind: "partial" });
    if (reply && !reasons.some((r) => r.kind === "question" || r.kind === "changes")) reasons.push({ kind: "question", reply });
    if (gpu !== cap.gpuMinutes && !reasons.some((r) => r.kind === "approve" || r.kind === "fit")) reasons.unshift({ kind: "approve", gpuMinutes: gpu });
    if (usd > cap.claudeUsd && approvalReason === "continue") approvalReason = "top-up";
    rec.caps = { gpuMinutes: Math.min(600, gpu), claudeUsd: Math.min(200, usd) };

    // The approval file: created on a plan-first approval, updated on every continue that has one.
    const existing = await readApproval(rec.project);
    if (existing || !rec.planFirst || attention?.code === "NEEDS_APPROVAL") await writeApproval(rec.project, rec.id, rec.caps, existing?.estimateKey ?? "continue", approvalReason, existing);

    const n = rec.attempts.length + 1;
    const rdir = runDir(rec.project, rec.id);
    const started = await sessionStarted(rec);
    const first = await readFile(join(rdir, RUN_FILES.prompt(1)), "utf8").catch(() => "");
    const prompt = started ? continuePrompt(rec.project, reasons) : freshSessionPrompt(retarget(first, rec.caps.gpuMinutes), reasons);
    await writeFile(join(rdir, RUN_FILES.prompt(n)), prompt);

    rec.status = "queued";
    rec.attention = undefined;
    rec.failure = undefined;
    rec.endedAt = undefined;
    rec.cancelRequestedAt = undefined;
    await writeRun(rec);
    this.watch(live);
    this.ensureTimer();
    await this.schedule();
    this.rebuild(live);
    return summarize(live.state);
  }

  /** Imports the template's track as asset "music" when the run's draft keeps it and the project lacks it. */
  private async ensureSoundtrack(rec: RunRecord): Promise<void> {
    if (rec.kind !== "template" || !rec.template) return;
    const app = await readAppJson(rec.project);
    if (app?.draft?.musicChoice !== "template") return;
    const preset = await getPreset(rec.template).catch(() => undefined);
    if (!preset?.soundtrack) return;
    await withProject(rec.project, (w) => takeSoundtrack(w, preset));
  }

  // ---------- cancelling ----------

  async cancel(runId: string): Promise<RunSummary> {
    const live = this.mustGet(runId);
    const rec = live.rec;
    if (rec.status === "stopping") return summarize(live.state);
    if (!live.state.canCancel) throw new HttpError(409, "This edit isn't being made.", "NOT_CANCELLABLE");
    if (rec.status === "queued") {
      rec.status = "cancelled";
      rec.endedAt = iso();
      rec.cancelledJobs = 0;
      releaseProjectLock(projectDir(rec.project), rec.id);
      await writeRun(rec);
      this.stopWatching(live);
      this.rebuild(live);
      void this.schedule();
      return summarize(live.state);
    }
    rec.status = "stopping";
    rec.cancelRequestedAt = iso();
    await writeRun(rec);
    this.rebuild(live);
    void this.finishCancel(live);
    return summarize(live.state);
  }

  /**
   * Stops the director's whole process group (TERM, then KILL after 10 s), so its MCP server can no longer
   * write jobs.json, then cancels the open GPU jobs and marks the run cancelled. Idempotent.
   */
  private async finishCancel(live: Live): Promise<void> {
    const rec = live.rec;
    const attempt = rec.attempts.at(-1);
    const pid = attempt?.pid;
    if (pid && isAlive(pid) && (await this.sameProcess(pid, attempt?.procStart))) {
      await killGroup(pid, "SIGTERM");
      if (!(await waitGroupGone(pid, 10_000))) {
        await killGroup(pid, "SIGKILL");
        await waitGroupGone(pid, 2_000);
      }
    }
    this.readStream(live);
    if (attempt && !attempt.endedAt) this.closeAttempt(live);
    await rm(join(runDir(rec.project, rec.id), RUN_FILES.mcp), { force: true });
    const cfg = await loadConfig();
    const { backend } = currentBackend(cfg);
    const warnings: string[] = [];
    let cancelled = 0;
    if (backend && existsSync(join(projectDir(rec.project), "project.json"))) {
      const r = await cancelOpenJobs(await Workspace.open(rec.project), backend, "Cancelled in the app").catch((e: Error) => ({ cancelled: 0, failed: [{ id: "*", error: e.message }], otherTarget: 0, unsent: 0 }));
      cancelled = r.cancelled;
      if (r.failed.length) warnings.push(`${r.failed.length} job${r.failed.length === 1 ? "" : "s"} on ${backend.target} couldn't be cancelled and may still use GPU time.`);
      if (r.unsent) warnings.push(`${r.unsent} job${r.unsent === 1 ? " was" : "s were"} being sent to ${backend.target} when you stopped and may still use GPU time.`);
      if (r.otherTarget) warnings.push(`${r.otherTarget} job${r.otherTarget === 1 ? "" : "s"} on another GPU were left alone.`);
    }
    rec.status = "cancelled";
    rec.cancelledJobs = cancelled;
    rec.warnings = [...new Set([...rec.warnings, ...warnings])];
    rec.endedAt = iso();
    releaseProjectLock(projectDir(rec.project), rec.id);
    await writeRun(rec);
    this.stopWatching(live);
    await this.refreshFiles(live);
    this.rebuild(live);
    void this.schedule();
  }

  // ---------- scheduling and launching ----------

  /** Starts queued runs while slots are free (oldest first); a run marked "start now" goes regardless. */
  async schedule(): Promise<void> {
    const next = this.scheduling.then(async () => {
      if (this.closed) return;
      const settings = await loadSettings();
      let free = settings.maxParallelRuns - [...this.runs.values()].filter((l) => usesSlot(l.rec.status)).length;
      const queued = [...this.runs.values()].filter((l) => l.rec.status === "queued").sort((a, b) => a.rec.updatedAt.localeCompare(b.rec.updatedAt));
      for (const live of queued) {
        if (!live.startNow && free <= 0) continue;
        if (!live.startNow) free--;
        live.startNow = false;
        // Mark it starting before any await, so a second schedule cannot launch it again.
        live.rec.status = "starting";
        void this.launch(live).catch((e: Error) => this.failLaunch(live, "SPAWN_FAILED", e.message));
      }
      for (const live of queued) this.rebuild(live);
    });
    this.scheduling = next.catch(() => undefined);
    return next;
  }

  private async launch(live: Live, reason: RunRecord["attempts"][number]["reason"] = live.rec.attempts.length ? "continue" : "start"): Promise<void> {
    // Until the new attempt's marker is reduced, the facts (result, init) and the exit are the last
    // attempt's: a poll in between would finalize this attempt with them.
    live.launching = true;
    try {
      await this.launchAttempt(live, reason);
    } finally {
      live.launching = false;
      // Catch up on anything that happened meanwhile (a director that already exited).
      if (usesSlot(live.rec.status)) this.kick(live);
    }
  }

  private async launchAttempt(live: Live, reason: RunRecord["attempts"][number]["reason"]): Promise<void> {
    const rec = live.rec;
    rec.status = "starting";
    await writeRun(rec);
    this.rebuild(live);

    // Recheck before any spend: no director starts without a GPU that answers.
    const setup = await setupStatus({ fresh: "gpu" });
    if (rec.status !== "starting") return; // stopped meanwhile
    const pre = preflightFailure(setup);
    if (pre) return this.failLaunch(live, pre.code, pre.message, pre.hint);
    const claude = claudePath();
    if (!claude) return this.failLaunch(live, "CLAUDE_MISSING");

    const settings = await loadSettings();
    const n = rec.attempts.length + 1;
    const rdir = runDir(rec.project, rec.id);
    const promptFile = join(rdir, RUN_FILES.prompt(n));
    if (!existsSync(promptFile)) return this.failLaunch(live, "SPAWN_FAILED", `The prompt for attempt ${n} is missing.`);
    // The approved Claude cap covers every attempt: when it is used up, the person tops it up first.
    if (rec.caps.claudeUsd - rec.spentUsd < MIN_BUDGET_USD) return this.pauseForUsd(live);
    const resume = reason !== "start" && reason !== "fresh-session" && (await sessionStarted(rec));
    const mcpFile = join(rdir, RUN_FILES.mcp);
    const cli = mcpCommand();
    await writeMcpConfig(mcpFile, { runId: rec.id, project: rec.project, home: dataHome(), overrides: rec.overrides.profiles, commercial: rec.overrides.commercial, execPath: process.execPath, execArgv: cli.execArgv, entry: cli.entry, env: process.env });
    const system = await readFile(join(rdir, RUN_FILES.system), "utf8").catch(() => SYSTEM_PROMPT);
    const streamFile = join(rdir, RUN_FILES.stream);
    await writeFile(streamFile, markerLine(n, iso()), { flag: "a" });
    const offset = statSync(streamFile).size;
    rec.attempts.push({ n, reason, startedAt: iso(), streamOffset: offset, promptFile: RUN_FILES.prompt(n), session: rec.sessionId, resumed: resume });
    rec.versionsAtStart = live.files.project?.versions.length ?? rec.versionsAtStart;
    rec.model = settings.model;
    reduce(live.facts, { type: "attempt", attempt: n }, this.ctx(live));
    // A continued attempt starts where the files say the edit is, not at "getting ready".
    if (n > 1) seedPhase(live.facts, live.files, this.ctx(live));
    live.floorPct = 0;
    live.exit = undefined;
    live.resultAt = undefined;
    live.killedForInit = false;
    live.goneSeen = false;
    live.tailer = new LineTailer(streamFile, offset);

    const args = claudeArgs({ sessionId: rec.sessionId, resume, model: settings.model, maxBudgetUsd: budgetFor(rec.caps.claudeUsd, rec.spentUsd), mcpConfig: mcpFile, systemPrompt: system });
    let spawned;
    try {
      spawned = await spawnDirector({ claudePath: claude, args, cwd: rdir, promptFile, streamFile, stderrFile: join(rdir, RUN_FILES.stderr) });
    } catch (e) {
      rec.attempts.at(-1)!.endedAt = iso();
      await rm(mcpFile, { force: true });
      return this.failLaunch(live, "SPAWN_FAILED", (e as Error).message.split("\n")[0]);
    }
    const attempt = rec.attempts.at(-1)!;
    attempt.pid = spawned.pid;
    live.child = spawned.child;
    if (rec.status !== "starting") {
      // Stop arrived while the director was starting: it must not run on.
      await killGroup(spawned.pid, "SIGTERM");
      return;
    }
    spawned.child.once("exit", (code, signal) => {
      live.exit = { code, signal };
      this.kick(live);
    });
    attempt.procStart = await procStart(spawned.pid);
    // A director that already ended (signed out, crashed) has been finalized meanwhile.
    if (rec.status !== "starting" && rec.status !== "running") return;
    if (settings.keepAwake) live.caffeinate = keepAwake(spawned.pid);
    await writeRun(rec);
    this.watch(live);
    this.rebuild(live);
  }

  /** No director starts without Claude budget left: the run pauses on "budget used" for a top-up. */
  private async pauseForUsd(live: Live): Promise<void> {
    const rec = live.rec;
    rec.status = "paused";
    const attention = { code: "USD_CAP" as const, message: "" };
    rec.attention = { ...attention, message: attentionMessage(attention, { gpuCap: rec.caps.gpuMinutes, claudeCap: rec.caps.claudeUsd }) };
    await writeRun(rec);
    this.rebuild(live);
    void this.schedule();
  }

  private async failLaunch(live: Live, code: NonNullable<RunRecord["failure"]>["code"], message?: string, hint?: string): Promise<void> {
    const rec = live.rec;
    const copy = failureCopy(code, { message, target: hint });
    rec.status = "failed";
    rec.failure = { code, message: code === "SPAWN_FAILED" || code === "BLOCKED" ? (message ?? copy.message) : copy.message, ...(hint ? { hint } : {}), resumable: true };
    rec.endedAt = iso();
    releaseProjectLock(projectDir(rec.project), rec.id);
    await writeRun(rec);
    this.stopWatching(live);
    this.rebuild(live);
    void this.schedule();
  }

  // ---------- watching ----------

  private ensureTimer(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      for (const live of this.runs.values()) if (usesSlot(live.rec.status)) this.kick(live);
    }, POLL_MS);
    this.timer.unref();
  }

  private watch(live: Live): void {
    if (live.watcher || this.closed) return;
    live.watcher = new ProjectWatcher(projectDir(live.rec.project), () => this.kick(live), `runs/${live.rec.id}/${RUN_FILES.stream}`);
    live.watcher.start();
  }

  private stopWatching(live: Live): void {
    live.watcher?.close();
    live.watcher = undefined;
  }

  /** Runs a poll now, or once more after the one in progress. */
  private kick(live: Live): void {
    if (this.closed) return;
    if (live.polling) {
      live.again = true;
      return;
    }
    live.polling = this.poll(live)
      .catch((e: Error) => {
        process.stderr.write(`open-katana: run ${live.rec.id}: ${e.message}\n`);
      })
      .finally(() => {
        live.polling = undefined;
        if (live.again) {
          live.again = false;
          this.kick(live);
        }
      });
  }

  private async poll(live: Live): Promise<void> {
    // The timer polls again once the launch is done.
    if (live.launching) return;
    const rec = live.rec;
    const lines = this.readStream(live);
    if (lines) live.files.changedAt = Math.max(live.files.changedAt, this.now());
    await this.refreshFiles(live);
    const f = live.facts;
    if (f.plan.fiveHour !== undefined) notePlanWindow(f.plan);
    const attempt = rec.attempts.at(-1);
    if (rec.status === "starting" && f.initSeen && !f.initProblem) {
      rec.status = "running";
      await writeRun(rec);
    }
    if ((rec.status === "starting" || rec.status === "running") && f.initProblem && !live.killedForInit && attempt?.pid) {
      // The tools did not load: stop before the director spends anything.
      live.killedForInit = true;
      await killGroup(attempt.pid, "SIGTERM");
    }
    if (f.result && !live.resultAt) live.resultAt = this.now();
    if ((rec.status === "starting" || rec.status === "running") && attempt) {
      // Gone = the process exited (or, for an adopted director, its pid vanished) and one more read
      // found nothing new in the stream.
      // Our own child's exit means its writes are all in the file already.
      const gone = Boolean(live.exit) || !isAlive(attempt.pid);
      if (live.exit || (gone && lines === 0 && live.goneSeen)) await this.finalize(live);
      else if (gone) live.goneSeen = true;
      else if (live.resultAt && this.now() - live.resultAt > RESULT_GRACE_MS && attempt.pid) await killGroup(attempt.pid, "SIGTERM");
    }
    this.rebuild(live);
  }

  private readStream(live: Live): number {
    if (!live.tailer) return 0;
    const ctx = this.ctx(live);
    return live.tailer.read((line) => {
      const events = parseLine(line);
      if (!events) {
        live.tailer!.junk++;
        return;
      }
      for (const e of events) reduce(live.facts, e, ctx);
    });
  }

  private async refreshFiles(live: Live, opts: { cutMap?: boolean } = {}): Promise<void> {
    const dir = projectDir(live.rec.project);
    if (!existsSync(dir)) return;
    const cfg = await loadConfig();
    const { backend } = currentBackend(cfg);
    const before = live.files;
    const next = await readSnapshot(dir, before, { kind: backend?.kind ?? "http", target: backend?.target ?? "" }, { cutMap: opts.cutMap ?? !TERMINAL.has(live.rec.status) });
    if (JSON.stringify(next.jobs) !== JSON.stringify(before.jobs) || next.project?.updatedAt !== before.project?.updatedAt || next.preview?.mtime !== before.preview?.mtime) next.changedAt = this.now();
    live.files = next;
  }

  // ---------- ending an attempt ----------

  private closeAttempt(live: Live, endedAt?: number): void {
    const rec = live.rec;
    const attempt = rec.attempts.at(-1);
    if (!attempt) return;
    const r = live.facts.result;
    attempt.endedAt = endedAt ? new Date(endedAt).toISOString() : iso();
    attempt.exitCode = live.exit?.code ?? null;
    attempt.signal = live.exit?.signal ?? null;
    if (r) {
      attempt.resultSubtype = r.subtype;
      if (r.durationMs !== undefined) attempt.durationMs = r.durationMs;
      if (r.turns !== undefined) attempt.turns = r.turns;
    }
    const cost = attemptCost(rec, attempt, live.facts);
    attempt.costUsd = cost.usd;
    attempt.costEstimated = cost.estimated || undefined;
    if (cost.sessionUsd !== undefined) attempt.sessionCostUsd = cost.sessionUsd;
    rec.spentUsd = +rec.attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0).toFixed(4);
    // Phase times add up over the attempts, so a history sample covers the whole run.
    const phases = attemptPhaseSec(live.facts, Date.parse(attempt.endedAt));
    const total = { ...(rec.phaseSec ?? {}) };
    for (const [p, sec] of Object.entries(phases) as [(typeof PHASES)[number], number][]) total[p] = Math.round((total[p] ?? 0) + sec);
    rec.phaseSec = total;
    rec.warnings = [...new Set([...rec.warnings, ...live.facts.warnings])];
    if (live.caffeinate) {
      try {
        process.kill(live.caffeinate);
      } catch {
        // caffeinate -w already ended with the director
      }
      live.caffeinate = undefined;
    }
    live.child = undefined;
  }

  /** Decides how an attempt ended (spec §9.9) once its result is read and its process is gone. */
  private async finalize(live: Live): Promise<void> {
    if (live.finalizing) return;
    live.finalizing = true;
    try {
      const rec = live.rec;
      this.readStream(live);
      const rdir = runDir(rec.project, rec.id);
      const stderrTail = await tail(join(rdir, RUN_FILES.stderr), 4096);
      const attempt = rec.attempts.at(-1);
      this.closeAttempt(live);
      await rm(join(rdir, RUN_FILES.mcp), { force: true });
      if (rec.status === "stopping" || rec.cancelRequestedAt) return;

      // --resume found no conversation: start a fresh session rather than failing.
      if (attempt && attempt.reason === "continue" && resumeMissing(live.facts, stderrTail)) {
        rec.sessionId = randomUUID();
        const first = await readFile(join(rdir, RUN_FILES.prompt(1)), "utf8").catch(() => "");
        const last = await readFile(join(rdir, attempt.promptFile), "utf8").catch(() => "");
        const reasons = last.split("\n").slice(1, -2).filter(Boolean);
        await writeFile(join(rdir, RUN_FILES.prompt(rec.attempts.length + 1)), `${freshSessionPrompt(retarget(first, rec.caps.gpuMinutes)).trimEnd()}\n${reasons.join("\n")}\n`);
        rec.status = "starting";
        await writeRun(rec);
        live.finalizing = false;
        await this.launch(live, "fresh-session");
        return;
      }

      await this.refreshFiles(live);
      const newVersion = (live.files.project?.versions.length ?? 0) > rec.versionsAtStart;
      const planWaiting = rec.planFirst && !live.files.approval && Boolean(live.facts.planEstimate ?? live.files.estimate);
      const end = attemptEnd(live.facts, { newVersion, stderrTail, exitCode: live.exit?.code, planWaiting });
      rec.status = end.status;
      rec.failure = end.failure;
      let attention = end.attention;
      if (attention) {
        const plan = live.facts.planEstimate ?? (live.files.estimate ? { totalMinutes: live.files.estimate.totalMinutes, jobs: live.files.estimate.jobs, ...(live.files.plan?.concept ? { concept: live.files.plan.concept } : {}) } : undefined);
        if (attention.code === "NEEDS_APPROVAL" && plan) attention = { ...attention, plan, needsMinutes: plan.totalMinutes, capMinutes: rec.caps.gpuMinutes };
        if (attention.code === "BUDGET_CAP") attention = { ...attention, capMinutes: attention.capMinutes ?? rec.caps.gpuMinutes };
        attention = { ...attention, message: attentionMessage(attention, { gpuCap: rec.caps.gpuMinutes, claudeCap: rec.caps.claudeUsd, plan }) };
      }
      rec.attention = attention;
      if (end.status === "done") {
        const latest = live.files.project!.versions.at(-1)!;
        rec.delivered = { version: latest.version, path: latest.path, issues: end.issues ?? [], ...(end.report ? { report: end.report } : {}) };
        if (live.files.edl?.audio?.asset === "ref") await writeSilentCopy(join(projectDir(rec.project), latest.path)).catch(() => undefined);
        await appendSample(this.sample(live)).catch(() => undefined);
        this.phaseCache.delete(live.historyKind);
      }
      if (end.status !== "paused") {
        rec.endedAt = iso();
        releaseProjectLock(projectDir(rec.project), rec.id);
        this.stopWatching(live);
      }
      live.tailer = undefined;
      await writeRun(rec);
      await this.refreshFiles(live);
      this.rebuild(live);
      void this.schedule();
    } finally {
      live.finalizing = false;
    }
  }

  private sample(live: Live): Parameters<typeof appendSample>[0] {
    const rec = live.rec;
    const phaseSec = { ...(rec.phaseSec ?? {}) };
    const wallSec = rec.attempts.reduce((s, a) => s + Math.max(0, (Date.parse(a.endedAt ?? iso()) - Date.parse(a.startedAt)) / 1000), 0);
    return { kind: live.historyKind, ...(rec.template ? { template: rec.template } : {}), costUsd: rec.spentUsd, wallMin: +(wallSec / 60).toFixed(1), gpuMin: +live.files.gpu.committedMin.toFixed(1), phaseSec, at: iso() };
  }

  // ---------- state ----------

  private ctx(live: Live) {
    const lineOps = new Map((live.files.plan?.jobs ?? []).map((j) => [j.line, j.operation]));
    return { sessionId: live.rec.sessionId, kind: live.rec.kind, now: this.now(), lineOperation: (line: string) => lineOps.get(line) };
  }

  private phaseMinutes(kind: HistoryKind): Partial<Record<(typeof PHASES)[number], number>> {
    const hit = this.phaseCache.get(kind);
    if (hit && this.now() - hit.at < 60_000) return hit.minutes;
    void loadHistory().then((h) => this.phaseCache.set(kind, { at: this.now(), minutes: phaseMedians(h, kind) }));
    return hit?.minutes ?? {};
  }

  /** 1 for the next queued run to start, 2 for the one after, … (the order schedule() starts them in). */
  private queuePosition(live: Live): number | undefined {
    if (live.rec.status !== "queued") return undefined;
    return 1 + [...this.runs.values()].filter((l) => l !== live && l.rec.status === "queued" && l.rec.updatedAt < live.rec.updatedAt).length;
  }

  private rebuild(live: Live): void {
    const waitingFor = [...this.runs.values()].find((l) => usesSlot(l.rec.status) && l !== live)?.rec.title;
    const queuePosition = this.queuePosition(live);
    live.state = buildState(live.rec, live.facts, live.files, {
      now: this.now(),
      phaseMinutes: this.phaseMinutes(live.historyKind),
      ...(waitingFor ? { waitingFor } : {}),
      ...(queuePosition ? { queuePosition } : {}),
      licences: licencesOf(live.files),
      floorPct: live.floorPct,
    });
    live.floorPct = Math.max(live.floorPct, live.state.pct);
    this.scheduleEmit(live);
  }

  private scheduleEmit(live: Live): void {
    if (this.closed) return;
    const due = live.lastEmit + EMIT_MS - this.now();
    if (due > 0) {
      live.emitTimer ??= setTimeout(() => {
        live.emitTimer = undefined;
        this.emitNow(live);
      }, due);
      return;
    }
    this.emitNow(live);
  }

  private emitNow(live: Live): void {
    if (this.closed) return;
    live.lastEmit = this.now();
    this.emitState(live.rec.project, live.state);
    const s = live.state;
    const key = `${s.status}|${s.headline}|${s.pct}`;
    if (key !== live.summaryKey) {
      live.summaryKey = key;
      this.emitRuns(this.list({ active: true }));
    }
  }

  private emitAll(): void {
    this.emitRuns(this.list({ active: true }));
  }

  private mustGet(runId: string): Live {
    if (!isId("run", runId)) throw new HttpError(400, "That isn't a valid run id.", "BAD_ID");
    const live = this.runs.get(runId);
    if (!live) throw new HttpError(404, "No such run.", "NOT_FOUND");
    return live;
  }

  private async sameProcess(pid: number, start: string | undefined): Promise<boolean> {
    const [now, cmd] = await Promise.all([procStart(pid), procCommand(pid)]);
    return Boolean(now && (!start || now === start) && cmd && /claude/i.test(cmd));
  }

  /** Builds a run's in-memory state from disk; `parse` re-reads its stream for notes and facts. */
  private async load(rec: RunRecord, parse: boolean): Promise<Live> {
    const live: Live = { rec, facts: newFacts(this.now()), files: emptySnapshot(this.now()), state: undefined as unknown as RunState, historyKind: "shot-for-shot", floorPct: 0, lastEmit: 0 };
    this.runs.set(rec.id, live);
    await this.refreshFiles(live);
    live.historyKind = rec.kind === "decode" ? "decode" : live.files.preset ? templateKind(live.files.preset) : "shot-for-shot";
    if (parse) {
      // The whole stream: notes and verdicts of earlier attempts, then this attempt's facts.
      live.tailer = new LineTailer(join(runDir(rec.project, rec.id), RUN_FILES.stream), 0);
      this.readStream(live);
    }
    this.rebuild(live);
    return live;
  }

  private async loadById(project: string, rid: string): Promise<Live | undefined> {
    const rec = await readRun(project, rid);
    return rec ? this.load(rec, false) : undefined;
  }

  /** Removes project locks whose run is over or gone. */
  private async sweepLocks(): Promise<void> {
    const root = projectsRoot();
    if (!existsSync(root)) return;
    for (const project of await readdir(root)) {
      if (!isId("project", project)) continue;
      const dir = projectDir(project);
      if (!existsSync(join(dir, "runs", "active"))) continue;
      const holder = lockedBy(dir);
      const live = holder ? this.runs.get(holder) : undefined;
      if (!live || !HOLDS_LOCK.has(live.rec.status)) await rm(join(dir, "runs", "active"), { force: true });
    }
  }

  // ---------- reads without a manager (a server that doesn't own the app) ----------

  /** A run's state from disk alone. */
  static async readState(runId: string): Promise<RunState | undefined> {
    const rec = await findRun(runId);
    return rec ? stateFromDisk(rec) : undefined;
  }

  static async readList(filter: { active?: boolean } = {}): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const rec of await listRunRecords()) {
      if (filter.active && !HOLDS_LOCK.has(rec.status)) continue;
      // Only a live run's headline and progress come from its stream.
      out.push(summarize(await stateFromDisk(rec, usesSlot(rec.status))));
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  static async readDiagnostics(runId: string): Promise<RunDiagnostics | undefined> {
    const rec = await findRun(runId);
    return rec ? diagnosticsOf(rec, []) : undefined;
  }
}

/** Streams read by servers that don't own the app, kept per run and read on from where they stopped. */
const diskFacts = new Map<string, { facts: StreamFacts; tailer: LineTailer; session: string }>();

/** The stream's facts for a run, read incrementally (a re-created file starts over). */
function readDiskFacts(rec: RunRecord, files: FileSnapshot): StreamFacts {
  const file = join(runDir(rec.project, rec.id), RUN_FILES.stream);
  let entry = diskFacts.get(rec.id);
  const size = existsSync(file) ? statSync(file).size : 0;
  if (!entry || size < entry.tailer.offset || entry.session !== rec.sessionId) {
    entry = { facts: newFacts(), tailer: new LineTailer(file, 0), session: rec.sessionId };
    diskFacts.set(rec.id, entry);
  }
  const lineOps = new Map((files.plan?.jobs ?? []).map((j) => [j.line, j.operation]));
  const ctx = { sessionId: rec.sessionId, kind: rec.kind, now: Date.now(), lineOperation: (line: string) => lineOps.get(line) };
  const e = entry;
  e.tailer.read((line) => {
    for (const ev of parseLine(line) ?? []) reduce(e.facts, ev, ctx);
  });
  return e.facts;
}

/**
 * A run's state from disk, for a server without the app lock. A live run's stream is read too (from where
 * the last read stopped), so its phase, progress and notes match what the owner shows.
 */
async function stateFromDisk(rec: RunRecord, parse = true): Promise<RunState> {
  const files = await readSnapshot(projectDir(rec.project), undefined, { kind: "http", target: "" }).catch(() => emptySnapshot());
  const facts = parse ? readDiskFacts(rec, files) : newFacts();
  return buildState(rec, facts, files, { now: Date.now(), phaseMinutes: {}, licences: licencesOf(files) });
}

/**
 * What an attempt cost on its own. The CLI's total_cost_usd when there is a result (on a resumed session that
 * total includes the session's earlier attempts, so their last reported total is taken off); without a result
 * (a crash, a Stop, sleep, a kill), an estimate from the attempt's streamed tokens, so the next attempt's
 * --max-budget-usd still leaves out what this one spent.
 */
function attemptCost(rec: RunRecord, attempt: RunRecord["attempts"][number], f: StreamFacts): { usd: number; estimated: boolean; sessionUsd?: number } {
  const reported = f.result?.costUsd;
  if (reported !== undefined) {
    // The session's last reported total before this attempt. A start or a fresh session begins a new one;
    // runs recorded before attempts kept the session's total kept the CLI's total as their cost.
    let before = 0;
    for (const a of rec.attempts) {
      if (a === attempt) break;
      if (a.reason !== "continue" || (a.session !== undefined && attempt.session !== undefined && a.session !== attempt.session)) before = 0;
      const total = a.sessionCostUsd ?? (a.session === undefined && a.resultSubtype !== undefined ? a.costUsd : undefined);
      if (total !== undefined) before = total;
    }
    if (!attempt.resumed) before = 0;
    return { usd: +Math.max(0, reported - before).toFixed(4), estimated: false, sessionUsd: reported };
  }
  return { usd: +estimateUsd(f.usage.values(), f.model).toFixed(4), estimated: f.usage.size > 0 };
}

async function diagnosticsOf(rec: RunRecord, warnings: string[]): Promise<RunDiagnostics> {
  const text = redact(await tail(join(runDir(rec.project, rec.id), RUN_FILES.stderr), 64 * 1024));
  const lines = text.split("\n").filter((l) => l.trim());
  const last = rec.attempts.at(-1);
  return {
    stderrTail: lines.slice(-40),
    ...(last ? { exitCode: last.exitCode ?? null, signal: last.signal ?? null } : {}),
    sessionId: rec.sessionId,
    attempts: rec.attempts,
    warnings: [...new Set([...rec.warnings, ...warnings])],
  };
}

/** The licences of the profiles a run actually used (jobs.json, else the plan's estimate). */
function licencesOf(files: FileSnapshot): LicenceNote[] {
  const ids = new Set<string>(files.jobs.length ? files.jobs.map((j) => j.profile) : (files.estimate?.jobs ?? []).map((j) => j.profile));
  return [...ids].map((id) => licenceNote(id, true)).filter((l): l is LicenceNote => Boolean(l));
}

/** The music rules of spec §9.13. */
function musicProblems(req: StartRun, preset: Preset | undefined, refHasAudio: boolean): FieldProblem[] {
  const out: FieldProblem[] = [];
  if (req.musicChoice === "template" && !preset?.soundtrack) out.push({ field: "music", message: "This template doesn't ship a track yet. Add yours." });
  if (req.musicChoice === "mine" && !req.music) out.push({ field: "music", message: "Add your track to start." });
  if (req.musicChoice === "original" && (req.kind !== "decode" || !refHasAudio)) out.push({ field: "music", message: "This edit has no sound of its own. Add your track." });
  if (req.kind === "template" && preset?.inputs.music === "required" && !preset.soundtrack && req.musicChoice !== "mine") out.push({ field: "music", message: "Add your track to start." });
  return out;
}

/** What stops a run before its director starts (spec §9.12): no spawn, no Claude spend. */
function preflightFailure(setup: SetupStatus): { code: NonNullable<RunRecord["failure"]>["code"]; message?: string; hint?: string } | undefined {
  if (setup.claude.state === "missing" || setup.claude.state === "error") return { code: "CLAUDE_MISSING" };
  if (setup.claude.state === "too-old") return { code: "CLAUDE_TOO_OLD", hint: setup.claude.missingFlags?.join(" ") };
  if (setup.claude.state === "logged-out") return { code: "CLAUDE_LOGGED_OUT" };
  if (setup.gpu.state === "not-configured" || setup.gpu.state === "env-secret") return { code: "GPU_NOT_CONFIGURED" };
  if (setup.gpu.state === "unreachable") return { code: "BACKEND_DOWN", hint: setup.gpu.target };
  if (setup.ffmpeg.state === "missing") return { code: "BLOCKED", message: "Install ffmpeg to decode and render edits." };
  return undefined;
}

/**
 * How the director starts the MCP server: this same build, so app and tools never disagree. The app's
 * own entry when it is the CLI (dist/cli.js, or src/cli.ts with tsx in execArgv); otherwise the CLI
 * next to this module.
 */
function mcpCommand(): { execArgv: string[]; entry: string } {
  const entry = process.argv[1];
  if (entry && /[/\\]cli\.(t|j)s$/.test(entry)) return { execArgv: process.execArgv, entry };
  const built = fileURLToPath(new URL("../../cli.js", import.meta.url));
  if (existsSync(built)) return { execArgv: [], entry: built };
  return { execArgv: ["--import", "tsx"], entry: fileURLToPath(new URL("../../cli.ts", import.meta.url)) };
}

/** The first prompt with a new GPU total, and without the plan-first stop once the plan is approved. */
function retarget(first: string, gpuMinutes: number): string {
  return first.replace(/^SPEND: up to \d+ GPU minutes for this project\..*$/m, `SPEND: up to ${Math.round(gpuMinutes)} GPU minutes for this project.`);
}

/** True when the stream shows the director started this run's session (so --resume can find it). */
async function sessionStarted(rec: RunRecord): Promise<boolean> {
  const file = join(runDir(rec.project, rec.id), RUN_FILES.stream);
  if (!existsSync(file)) return false;
  let found = false;
  new LineTailer(file, 0).read((line) => {
    if (found || !line.includes('"init"') || !line.includes(rec.sessionId)) return;
    const events = parseLine(line);
    if (events?.some((e) => e.type === "init" && e.sessionId === rec.sessionId)) found = true;
  });
  return found;
}

async function readApproval(project: string): Promise<ApprovalFile | undefined> {
  try {
    return JSON.parse(await readFile(join(projectDir(project), "plan", "approval.json"), "utf8")) as ApprovalFile;
  } catch {
    return undefined;
  }
}

async function writeApproval(project: string, run: string, caps: { gpuMinutes: number; claudeUsd: number }, estimateKey: string, reason: ApprovalFile["history"][number]["reason"], prev?: ApprovalFile): Promise<void> {
  const at = iso();
  const file: ApprovalFile = {
    v: 1,
    run,
    gpuMinutes: caps.gpuMinutes,
    claudeUsd: caps.claudeUsd,
    approvedAt: at,
    estimateKey,
    history: [...(prev?.history ?? []), { at, gpuMinutes: caps.gpuMinutes, claudeUsd: caps.claudeUsd, reason }],
  };
  await writeFileAtomic(join(projectDir(project), "plan", "approval.json"), `${JSON.stringify(file, null, 2)}\n`);
}
