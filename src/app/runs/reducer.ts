import type {
  AttentionCode,
  CutMapData,
  FailureCode,
  LicenceNote,
  PhaseId,
  PlanEstimate,
  RunKind,
  RunRecord,
  RunState,
  RunStatus,
  RunSummary,
  Take,
} from "../types.js";
import { errorCode, type MessageUsage, reportIssues, type StreamEvent, withoutReport } from "./stream.js";
import type { FileSnapshot } from "./watch.js";

/**
 * Turns stream events and the project's files into the RunState the app shows (spec §9.7, §9.8).
 * Pure: the manager feeds it events and snapshots and decides what happens next.
 */

export const PHASES: PhaseId[] = ["setup", "study", "plan", "stills", "clips", "mattes", "cut", "render", "check", "deliver"];

const NOTES_MAX = 200;
const NOTE_CHARS = 240;
export const STALL_MS = 10 * 60_000;

export const PHASE_WORDS: Record<PhaseId, string> = {
  setup: "GETTING READY",
  study: "STUDYING THE EDIT",
  plan: "PLANNING SHOTS",
  stills: "SHOOTING STILLS",
  clips: "ROLLING CLIPS",
  mattes: "CUTTING YOU OUT",
  cut: "CUTTING THE EDIT",
  render: "RENDERING",
  check: "FINAL CHECK",
  deliver: "READY",
};

/** The phase names in running text ("Exit code 1 during 'Rolling clips'"). */
const PHASE_TEXT: Record<PhaseId, string> = {
  setup: "Getting ready", study: "Studying the edit", plan: "Planning shots", stills: "Shooting stills", clips: "Rolling clips",
  mattes: "Cutting you out", cut: "Cutting the edit", render: "Rendering", check: "Final check", deliver: "Delivering",
};

const WEIGHTS: Record<PhaseId, number> = { setup: 3, study: 15, plan: 6, stills: 20, clips: 35, mattes: 4, cut: 5, render: 7, check: 3, deliver: 2 };

/**
 * Minutes per phase before history has three samples of the kind. From the same recorded runs as the
 * estimate seeds: planning 0.1–1.6 min, stills and clips 8–16 together, cut ~2, render 0.3–2.9, check 1–5.
 */
export const SEED_PHASE_MIN: Record<PhaseId, number> = { setup: 1, study: 6, plan: 1.5, stills: 7, clips: 8, mattes: 1, cut: 2, render: 2, check: 2, deliver: 0.5 };

export const ATTENTION_HEADLINES: Record<AttentionCode, string> = {
  NEEDS_APPROVAL: "YOUR CALL",
  BUDGET_CAP: "NEEDS YOUR OK",
  OUT_OF_CREDITS: "OUT OF CREDITS",
  BACKEND_DOWN: "GPU OFFLINE",
  USAGE_LIMIT: "PLAN LIMIT",
  USD_CAP: "BUDGET USED",
  QUESTION: "THE DIRECTOR ASKS",
};

export const FAILURE_TITLES: Record<FailureCode, string> = {
  CLAUDE_MISSING: "Claude Code isn't installed",
  CLAUDE_TOO_OLD: "Update Claude Code",
  CLAUDE_LOGGED_OUT: "Claude Code isn't signed in",
  GPU_NOT_CONFIGURED: "Connect a GPU to make edits",
  BACKEND_DOWN: "Can't reach your GPU",
  MODELS_MISSING: "Your ComfyUI is missing models",
  TOOLS_NOT_LOADED: "The open-katana tools didn't load",
  SPAWN_FAILED: "The director couldn't start",
  AGENT_ERROR: "The director hit an error",
  CRASHED: "The director stopped unexpectedly",
  BLOCKED: "The director stopped",
};

export const COPY = {
  outOfCredits: "Comfy Cloud is out of credits. Credits are shared across your Comfy workspace. Top up, then continue. Everything made so far is saved.",
  interrupted: "This edit stopped before it finished. The computer may have restarted or gone to sleep. Everything made so far is saved.",
  hooks: "Your Claude Code settings leaked into this run: hooks ran.",
  retrying: "The director hit an error and is retrying.",
  claudeMissing: "open-katana uses Claude Code as the director: it plans the shots, judges every take and cuts the edit. Install it, run `claude` once to sign in, then check again.",
  claudeTooOld: "This version can't run edits headlessly. Update it, then check again.",
  claudeLoggedOut: "Run `claude` in a terminal and sign in. Everything made so far is saved.",
  gpuNotConfigured: "Use Comfy Cloud, this computer's ComfyUI, or another computer's.",
  toolsNotLoaded: "Claude Code started without them, so nothing was spent.",
} as const;

const HOLDS_SLOT = new Set<RunStatus>(["starting", "running", "stopping"]);
/** Statuses that hold the project lock: the run is active (spec §3.4). */
export const HOLDS_LOCK = new Set<RunStatus>(["queued", "starting", "running", "stopping", "paused"]);
export const usesSlot = (s: RunStatus) => HOLDS_SLOT.has(s);

export type PhaseClass = "stills" | "clips" | "mattes";
export const classOf = (operation: string): PhaseClass => (operation.startsWith("clip.") ? "clips" : operation === "matte" ? "mattes" : "stills");

export type Attention = NonNullable<RunState["attention"]>;

/** What the stream has said so far. One per run; `attempt` events reset the per-attempt parts. */
export interface StreamFacts {
  attempt: number;
  initSeen: boolean;
  /** Why the init assertion failed; the manager kills the director when set. */
  initProblem?: string;
  reportedSession?: string;
  phase?: PhaseId;
  /** When the current phase was entered (ms, the line's own time when it has one). */
  phaseAt?: number;
  /** Seconds spent in each phase this attempt before the current one was entered, for history. */
  phaseSec: Partial<Record<PhaseId, number>>;
  /** The model the director runs on (from its init). */
  model?: string;
  /** This attempt's tokens per assistant message id, to estimate its cost when it ends without a result. */
  usage: Map<string, { model?: string; usage: MessageUsage }>;
  setupDetail?: string;
  render?: "preview" | "final";
  notes: { at: string; text: string }[];
  /** The director's last words: the text after its last tool call (or the result text). */
  lastText: string;
  tools: Map<string, ToolCall>;
  /** line → operation, from the director's katana_plan calls. */
  planLines: Map<string, string>;
  planEstimate?: PlanEstimate;
  attention?: Attention;
  pendingFailure?: { code: "BLOCKED"; message: string };
  rateLimited?: { resetsAt?: string };
  plan: { fiveHour?: number; sevenDay?: number; resetsAt?: string };
  judged: Map<string, { verdict: "accept" | "reject"; reason?: string; at: string }>;
  study?: { page: number; pages: number };
  delivered?: { version: number; path: string; sizeMB?: number; durationSec?: number };
  result?: { subtype: string; isError: boolean; costUsd?: number; durationMs?: number; turns?: number; text: string; apiError?: string; apiErrorStatus?: number };
  warnings: string[];
  lastActivity: number;
  /** The latest time a line carried (ms): when an attempt nobody watched actually went quiet. */
  lastLineAt?: number;
  lines: number;
}

/** A tool call the director made, and the phase it moved the run to (undone if the call fails). */
export interface ToolCall {
  name: string;
  tool?: string;
  input: Record<string, unknown>;
  moved?: { phase: PhaseId; at: number; before: { phase?: PhaseId; phaseAt?: number; phaseSec: Partial<Record<PhaseId, number>> } };
}

export function newFacts(now = Date.now()): StreamFacts {
  return {
    attempt: 0,
    initSeen: false,
    phaseSec: {},
    usage: new Map(),
    notes: [],
    lastText: "",
    tools: new Map(),
    planLines: new Map(),
    plan: {},
    judged: new Map(),
    warnings: [],
    lastActivity: now,
    lines: 0,
  };
}

export interface ReduceContext {
  /** The session the app asked for. */
  sessionId: string;
  kind: RunKind;
  now: number;
  /** Operation of a saved plan line (plan/plan.json), when the stream has not shown it. */
  lineOperation?: (line: string) => string | undefined;
}

function warn(f: StreamFacts, text: string): void {
  if (!f.warnings.includes(text)) f.warnings.push(text);
}

function note(f: StreamFacts, text: string, at: number): void {
  const clean = withoutReport(text).replace(/\s+/g, " ").trim();
  if (!clean) return;
  const short = clean.length > NOTE_CHARS ? `${clean.slice(0, NOTE_CHARS - 1)}…` : clean;
  if (f.notes.at(-1)?.text === short) return;
  f.notes.push({ at: new Date(at).toISOString(), text: short });
  if (f.notes.length > NOTES_MAX) f.notes.splice(0, f.notes.length - NOTES_MAX);
}

/**
 * Moves the phase forward. Within an attempt it goes back only with `back` (new GPU work after a cut is
 * that work again), never for a status check or a view (a status check mid-run is not "setup").
 * Returns true when the phase changed.
 */
function enter(f: StreamFacts, phase: PhaseId, ctx: ReduceContext, at: number, back = false): boolean {
  if (phase === "study" && ctx.kind !== "decode") return false;
  if (f.phase === phase) return false;
  if (f.phase && !back && PHASES.indexOf(phase) < PHASES.indexOf(f.phase)) return false;
  if (f.phase && f.phaseAt !== undefined) f.phaseSec[f.phase] = (f.phaseSec[f.phase] ?? 0) + Math.max(0, (at - f.phaseAt) / 1000);
  f.phase = phase;
  f.phaseAt = at;
  return true;
}

/** Seconds per phase of the current attempt, the current phase counted up to `until` (ms). */
export function attemptPhaseSec(f: StreamFacts, until: number): Partial<Record<PhaseId, number>> {
  const out = { ...f.phaseSec };
  if (f.phase && f.phaseAt !== undefined) out[f.phase] = (out[f.phase] ?? 0) + Math.max(0, (until - f.phaseAt) / 1000);
  return out;
}

/**
 * The phase a continued attempt starts in, from the project's files: GPU work still open, else the saved
 * edit, else the last kind of work done, else the saved plan. So a resumed run doesn't show "getting
 * ready" at 0% when it is about to cut.
 */
export function seedPhase(f: StreamFacts, files: FileSnapshot, ctx: ReduceContext): void {
  const latest = (jobs: FileSnapshot["jobs"]) => [...jobs].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1);
  const open = latest(files.jobs.filter((j) => j.state === "pending" || j.state === "running"));
  const done = latest(files.jobs.filter((j) => j.state === "completed"));
  const phase: PhaseId | undefined = open ? classOf(open.spec.operation) : files.edl ? "cut" : done ? classOf(done.spec.operation) : files.estimate || files.plan ? "plan" : undefined;
  if (phase) enter(f, phase, ctx, ctx.now);
}

function generatePhase(f: StreamFacts, input: Record<string, unknown>, ctx: ReduceContext): PhaseId {
  const ops: string[] = [];
  for (const j of Array.isArray(input.jobs) ? input.jobs : []) {
    const op = (j as { operation?: unknown }).operation;
    if (typeof op === "string") ops.push(op);
  }
  for (const l of Array.isArray(input.lines) ? input.lines : []) {
    if (typeof l !== "string") continue;
    const op = f.planLines.get(l) ?? ctx.lineOperation?.(l);
    if (op) ops.push(op);
  }
  if (ops.some((o) => o.startsWith("clip."))) return "clips";
  if (ops.includes("matte")) return "mattes";
  return "stills";
}

const VIEW_STUDY = new Set(["page", "overview", "shot", "frames"]);
/** Views of the render. "compare" (a take next to the subject photo) judges identity, during stills and clips. */
const VIEW_CHECK = new Set(["render", "render-pages"]);

/**
 * The phase a tool call moves the run to; `back` when it may go back (new GPU work after the edit was cut),
 * `undo` when a failed call means the run never got there (an early katana_edit probe, a render that failed).
 */
function toolPhase(f: StreamFacts, tool: string, input: Record<string, unknown>, ctx: ReduceContext): { phase: PhaseId; back?: boolean; undo?: boolean } | undefined {
  switch (tool) {
    case "katana_guide":
      f.setupDetail = "Reading the guide";
      return { phase: "setup" };
    case "katana_backend":
      f.setupDetail = "Checking your GPU";
      return { phase: "setup" };
    case "katana_status":
      return { phase: "setup" };
    case "katana_analyze":
    case "katana_review":
      return { phase: "study" };
    case "katana_view": {
      const target = typeof input.target === "string" ? input.target : "";
      if (VIEW_STUDY.has(target)) {
        if (target === "page" && Array.isArray(input.pages) && ctx.kind === "decode") {
          const pages = input.pages.filter((p): p is number => typeof p === "number");
          if (pages.length) f.study = { page: Math.max(f.study?.page ?? 0, ...pages), pages: f.study?.pages ?? 0 };
        }
        return { phase: "study" };
      }
      return VIEW_CHECK.has(target) ? { phase: "check", undo: true } : undefined;
    }
    case "katana_plan": {
      const plan = input.plan as { jobs?: { line?: unknown; operation?: unknown }[] } | undefined;
      for (const j of plan?.jobs ?? []) if (typeof j.line === "string" && typeof j.operation === "string") f.planLines.set(j.line, j.operation);
      return { phase: "plan" };
    }
    case "katana_generate":
      // New GPU work after the cut is what the run is doing now (a retake), so the phase goes back to it.
      // A retake that fails to submit goes back to where the run was; a failed first submit of a class stays (the run is generating).
      {
        const back = Boolean(f.phase && PHASES.indexOf(f.phase) >= PHASES.indexOf("cut"));
        return { phase: generatePhase(f, input, ctx), back, undo: back };
      }
    case "katana_edit":
      return { phase: "cut", undo: true };
    case "katana_render":
      f.render = input.preview === false ? "final" : "preview";
      return { phase: "render", undo: true };
    case "katana_deliver":
      return { phase: "deliver", undo: true };
    default:
      return undefined; // katana_wait, katana_judge: the phase stays
  }
}

/** Enters the call's phase when it is made; a call that fails puts the phase back (see onToolError). */
function onTool(f: StreamFacts, call: ToolCall, ctx: ReduceContext, at: number): void {
  const target = toolPhase(f, call.tool!, call.input, ctx);
  if (!target) return;
  const before = { phase: f.phase, phaseAt: f.phaseAt, phaseSec: { ...f.phaseSec } };
  if (enter(f, target.phase, ctx, at, target.back) && target.undo) call.moved = { phase: target.phase, at, before };
}

/** A failed call did not reach its phase: undo the move, unless something else moved the phase since. */
function undoMove(f: StreamFacts, call: ToolCall | undefined): void {
  const m = call?.moved;
  if (!m || f.phase !== m.phase || f.phaseAt !== m.at) return;
  f.phase = m.before.phase;
  f.phaseAt = m.before.phaseAt;
  f.phaseSec = m.before.phaseSec;
  call!.moved = undefined;
}

function backendTarget(text: string): string | undefined {
  const m = /^\[BACKEND\]\s*(.+?):\s/.exec(text.trim());
  return m?.[1];
}

function onToolError(f: StreamFacts, tool: string | undefined, text: string, at: number): void {
  const c = errorCode(text);
  const body = text.replace(/^\[[A-Z_]+\]\s*/, "");
  switch (c?.code) {
    case "APPROVAL":
      f.attention = { code: "NEEDS_APPROVAL", message: "" };
      return;
    case "BUDGET":
      f.attention = { code: "BUDGET_CAP", message: "", needsMinutes: c.needs, capMinutes: c.cap };
      return;
    case "OUT_OF_CREDITS":
      f.attention = { code: "OUT_OF_CREDITS", message: COPY.outOfCredits };
      return;
    case "BACKEND": {
      const target = backendTarget(text);
      f.attention = { code: "BACKEND_DOWN", message: target ? `Lost your GPU at ${target}. Start ComfyUI, then continue. Everything made so far is saved.` : "Lost your GPU. Start ComfyUI, then continue. Everything made so far is saved." };
      return;
    }
    case "LOCKED":
    case "STOPPED":
      f.pendingFailure = { code: "BLOCKED", message: body.split("\n")[0]!.slice(0, 300) };
      return;
    case "WORDS":
    case "USER_PICK":
    case "APP":
      note(f, body, at);
      return;
    default:
      if (tool) note(f, COPY.retrying, at);
  }
}

function onToolOk(f: StreamFacts, call: ToolCall | undefined, e: Extract<StreamEvent, { type: "toolOk" }>, ctx: ReduceContext, at: number): void {
  const s = e.structured;
  switch (call?.tool) {
    case "katana_plan": {
      const jobs = Array.isArray(s?.jobs) ? (s.jobs as Record<string, unknown>[]) : [];
      const plan = call.input.plan as { concept?: unknown } | undefined;
      f.planEstimate = {
        totalMinutes: typeof s?.totalMinutes === "number" ? s.totalMinutes : 0,
        jobs: jobs.map((j) => ({
          line: String(j.line ?? ""),
          operation: String(j.operation ?? ""),
          profile: String(j.profile ?? ""),
          takes: Number(j.takes ?? 1),
          video: String(j.video ?? ""),
          minutes: Number(j.minutes ?? 0),
        })),
        ...(typeof plan?.concept === "string" ? { concept: plan.concept } : {}),
      };
      return;
    }
    case "katana_generate":
      if (f.attention && ["BUDGET_CAP", "NEEDS_APPROVAL", "OUT_OF_CREDITS", "BACKEND_DOWN"].includes(f.attention.code)) f.attention = undefined;
      return;
    case "katana_judge": {
      const asset = call.input.asset;
      const verdict = call.input.verdict;
      if (typeof asset === "string" && (verdict === "accept" || verdict === "reject")) {
        f.judged.set(asset, { verdict, reason: typeof call.input.reason === "string" ? call.input.reason.slice(0, 300) : undefined, at: new Date(at).toISOString() });
      }
      return;
    }
    case "katana_analyze":
      if (ctx.kind === "decode" && typeof s?.pages === "number") f.study = { page: f.study?.page ?? 0, pages: s.pages };
      return;
    case "katana_view": {
      const m = /Page \d+\/(\d+)/.exec(e.text);
      if (m && f.study && !f.study.pages) f.study.pages = Number(m[1]);
      return;
    }
    case "katana_deliver":
      if (typeof s?.version === "number") {
        f.delivered = {
          version: s.version,
          path: String(s.path ?? ""),
          ...(typeof s.sizeMB === "number" ? { sizeMB: s.sizeMB } : {}),
          ...(typeof s.durationSec === "number" ? { durationSec: s.durationSec } : {}),
        };
      }
      return;
  }
}

/** Applies one event. Mutates `f` (the manager keeps one per run) and returns it. */
export function reduce(f: StreamFacts, e: StreamEvent, ctx: ReduceContext): StreamFacts {
  f.lines++;
  f.lastActivity = ctx.now;
  // The line's own time when it has one: a stream re-read after a restart keeps each note's time.
  const at = e.at ?? ctx.now;
  if (e.at !== undefined) f.lastLineAt = Math.max(f.lastLineAt ?? 0, e.at);
  switch (e.type) {
    case "attempt":
      f.attempt = e.attempt;
      f.initSeen = false;
      f.initProblem = undefined;
      f.phase = undefined;
      f.phaseAt = undefined;
      f.phaseSec = {};
      f.usage = new Map();
      f.setupDetail = undefined;
      f.render = undefined;
      f.attention = undefined;
      f.pendingFailure = undefined;
      f.rateLimited = undefined;
      f.result = undefined;
      f.delivered = undefined;
      f.lastText = "";
      return f;
    case "init": {
      f.initSeen = true;
      f.reportedSession = e.sessionId;
      if (e.model) f.model = e.model;
      const connected = e.mcpServers.some((s) => s.name === "open-katana" && s.status === "connected");
      const tools = ["katana_status", "katana_generate"].every((t) => e.tools.includes(`mcp__open-katana__${t}`));
      if (!connected || !tools) f.initProblem = !connected ? "The open-katana MCP server did not connect." : "The open-katana tools were missing.";
      if (e.sessionId && e.sessionId !== ctx.sessionId) warn(f, "The director started a different session than the app asked for.");
      if (e.plugins.length) warn(f, `Your Claude Code plugins loaded in this run: ${e.plugins.join(", ")}.`);
      const extra = e.tools.filter((t) => !t.startsWith("mcp__open-katana__"));
      if (extra.length) warn(f, `Tools outside open-katana were available to the director: ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? "…" : ""}.`);
      enter(f, "setup", ctx, at);
      return f;
    }
    case "hook":
      warn(f, COPY.hooks);
      return f;
    case "say":
      note(f, e.text, at);
      f.lastText = f.lastText ? `${f.lastText}\n${e.text}` : e.text;
      return f;
    case "tool": {
      const call: ToolCall = { name: e.name, tool: e.tool, input: e.input };
      f.tools.set(e.id, call);
      f.lastText = "";
      if (e.tool) onTool(f, call, ctx, at);
      return f;
    }
    case "toolError": {
      const call = f.tools.get(e.id);
      undoMove(f, call);
      onToolError(f, call?.tool, e.text, at);
      return f;
    }
    case "toolOk":
      onToolOk(f, f.tools.get(e.id), e, ctx, at);
      return f;
    case "usage":
      f.usage.set(e.id, { model: e.model, usage: e.usage });
      return f;
    case "rateLimit":
      f.plan = { fiveHour: e.fiveHour ?? f.plan.fiveHour, sevenDay: e.sevenDay ?? f.plan.sevenDay, resetsAt: e.resetsAt ?? f.plan.resetsAt };
      if (e.status === "rejected") f.rateLimited = { resetsAt: e.resetsAt };
      return f;
    case "result":
      f.result = { subtype: e.subtype, isError: e.isError, costUsd: e.costUsd, durationMs: e.durationMs, turns: e.turns, text: e.text, ...(e.apiError ? { apiError: e.apiError } : {}), ...(e.apiErrorStatus !== undefined ? { apiErrorStatus: e.apiErrorStatus } : {}) };
      if (e.text) f.lastText = e.text;
      return f;
    default:
      return f; // heartbeat, activity: only activity
  }
}

// ---------- how an attempt ends (spec §9.9) ----------

export interface AttemptEnd {
  status: RunStatus;
  attention?: Attention;
  failure?: NonNullable<RunState["failure"]>;
  issues?: string[];
  report?: string;
}

const LOGGED_OUT = /not logged in|please run \/login|invalid api key|authentication/i;
/** API errors that mean Claude Code's sign-in or key no longer works (the CLI's `api_error` values). */
const CREDENTIAL_ERRORS = new Set(["api_key_auth_disabled", "org_disabled_credential", "invalid_credential_header", "gateway_signin_required", "gateway_session_expired", "provider_credentials"]);

/**
 * The status an attempt ends in. `newVersion`: project.versions grew during the attempt.
 * `planWaiting`: a plan-first run whose plan is saved and not yet approved.
 */
export function attemptEnd(f: StreamFacts, o: { newVersion: boolean; stderrTail: string; exitCode?: number | null; planWaiting: boolean }): AttemptEnd {
  const r = f.result;
  const during = f.phase ? ` during '${PHASE_TEXT[f.phase]}'` : "";
  // A director without the katana tools is stopped whatever it said afterwards.
  if (f.initProblem) return { status: "failed", failure: { code: "TOOLS_NOT_LOADED", message: COPY.toolsNotLoaded, hint: f.initProblem, resumable: true } };
  if (r) {
    if (r.subtype === "success" && !r.isError) {
      if (o.newVersion) return { status: "done", attention: f.attention, issues: reportIssues(f.lastText), report: withoutReport(f.lastText).slice(0, 4000) || undefined };
      if (f.attention) return { status: "paused", attention: f.attention };
      if (f.pendingFailure) return { status: "failed", failure: { code: "BLOCKED", message: f.pendingFailure.message, resumable: true } };
      if (o.planWaiting) return { status: "paused", attention: { code: "NEEDS_APPROVAL", message: "" } };
      return { status: "paused", attention: { code: "QUESTION", message: "", question: withoutReport(f.lastText).slice(0, 1000) } };
    }
    if (r.subtype === "error_max_budget_usd") return { status: "paused", attention: { code: "USD_CAP", message: "" } };
    // A turn that ended on the plan's usage limit, or on a sign-in that stopped working: the CLI still writes a result.
    if (r.apiError === "usage_limit_reached" || r.apiErrorStatus === 429 || f.rateLimited) return { status: "paused", attention: { code: "USAGE_LIMIT", message: "", resetsAt: f.rateLimited?.resetsAt ?? f.plan.resetsAt } };
    if ((r.apiError && CREDENTIAL_ERRORS.has(r.apiError)) || r.apiErrorStatus === 401 || (r.isError && LOGGED_OUT.test(r.text))) return { status: "failed", failure: { code: "CLAUDE_LOGGED_OUT", message: COPY.claudeLoggedOut, resumable: true } };
    const line = (withoutReport(r.text).split("\n")[0] || r.subtype.replace(/_/g, " ")).slice(0, 200);
    return { status: "failed", failure: { code: "AGENT_ERROR", message: `${line.replace(/\.$/, "")}. Everything made so far is saved.`, resumable: true } };
  }
  if (LOGGED_OUT.test(o.stderrTail)) return { status: "failed", failure: { code: "CLAUDE_LOGGED_OUT", message: COPY.claudeLoggedOut, resumable: true } };
  if (f.rateLimited) return { status: "paused", attention: { code: "USAGE_LIMIT", message: "", resetsAt: f.rateLimited.resetsAt } };
  const code = o.exitCode === undefined || o.exitCode === null ? "The director's process ended" : `Exit code ${o.exitCode}`;
  return { status: "failed", failure: { code: "CRASHED", message: `${code}${during}. Everything made so far is saved.`, resumable: true } };
}

/** `--resume` found nothing to resume: the app starts a fresh session instead of failing. */
export function resumeMissing(f: StreamFacts, stderrTail: string): boolean {
  return !f.initSeen && /no conversation found|session.*not found/i.test(stderrTail);
}

// ---------- RunState ----------

export interface BuildContext {
  now: number;
  /** Seconds per phase from history (≥ 3 samples), else the seeds. */
  phaseMinutes: Partial<Record<PhaseId, number>>;
  /** Title of the run a queued run waits for. */
  waitingFor?: string;
  queuePosition?: number;
  licences?: LicenceNote[];
  /** The highest pct shown in this attempt: progress never goes back within one. */
  floorPct?: number;
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The paused card's body for an attention code. */
export function attentionMessage(a: Attention, o: { gpuCap: number; claudeCap: number; plan?: PlanEstimate }): string {
  switch (a.code) {
    case "NEEDS_APPROVAL": {
      const p = a.plan ?? o.plan;
      return p ? `The director's plan is ready: ${p.jobs.length} jobs, about ${Math.round(p.totalMinutes)} GPU min.` : "The director's plan is ready.";
    }
    case "BUDGET_CAP":
      return `The plan needs about ${Math.round(a.needsMinutes ?? 0)} GPU min in total. You approved ${Math.round(a.capMinutes ?? o.gpuCap)}.`;
    case "OUT_OF_CREDITS":
      return COPY.outOfCredits;
    case "BACKEND_DOWN":
      return a.message || "Lost your GPU. Start ComfyUI, then continue. Everything made so far is saved.";
    case "USAGE_LIMIT":
      return a.resetsAt ? `Your Claude plan's limit was reached. It resets at ${clock(a.resetsAt)}. Everything made so far is saved.` : "Your Claude plan's limit was reached. Everything made so far is saved.";
    case "USD_CAP":
      return `The director used the $${+o.claudeCap.toFixed(2)} you approved before finishing.`;
    case "QUESTION":
      return a.question || a.message || "The director stopped with a question.";
  }
}

function takeKind(operation: string): Take["kind"] {
  return operation.startsWith("clip.") ? "clip" : operation === "matte" ? "matte" : "still";
}

function slotOf(line: string, slots: Set<string>): string | undefined {
  const base = line.replace(/-key$/, "");
  return slots.has(base) ? base : slots.has(line) ? line : undefined;
}

/** Takes from jobs.json (outputs and in-flight placeholders); without it, from the director's verdicts. */
export function buildTakes(project: string, f: StreamFacts, files: FileSnapshot): Take[] {
  const slots = new Set((files.preset?.slots ?? []).map((s) => s.id));
  const picks = new Map(files.picks.map((p) => [p.line, p.asset]));
  const verdicts = new Map(files.verdicts.map((v) => [v.asset, v]));
  const assets = new Map((files.project?.assets ?? []).map((a) => [a.id, a]));
  const verdictFor = (asset: string, line: string): Take["verdict"] => {
    if (picks.get(line) === asset) return { by: "you", verdict: "accept" };
    const v = verdicts.get(asset) ?? f.judged.get(asset);
    return v ? { by: "director", verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}) } : undefined;
  };
  const media = (asset: string) => {
    const a = assets.get(asset);
    return {
      thumb: `/api/projects/${project}/thumb?asset=${encodeURIComponent(asset)}&t=0.5&h=160`,
      ...(a ? { url: `/media/${project}/${a.path.split("/").map(encodeURIComponent).join("/")}` } : {}),
    };
  };
  // Panels are named "<id>+<id>…-vs-<subject>.jpg": match whole ids, so t1 never matches t10.
  const panel = (asset: string) => {
    const name = files.panels.find((p) => p.split("-vs-")[0]!.split("+").includes(asset));
    return name ? { panel: `/media/${project}/qa/${encodeURIComponent(name)}` } : {};
  };
  const takes: Take[] = [];
  if (files.jobs.length) {
    for (const j of files.jobs) {
      const kind = takeKind(j.spec.operation);
      const slot = slotOf(j.line, slots);
      if (j.state === "completed") {
        for (const asset of j.outputs) {
          const verdict = verdictFor(asset, j.line);
          takes.push({ asset, line: j.line, ...(slot ? { slot } : {}), kind, state: "ready", ...media(asset), ...panel(asset), ...(verdict ? { verdict } : {}), at: j.finishedAt ?? j.submittedAt });
        }
      } else if (j.state === "pending" || j.state === "running") {
        takes.push({ asset: j.id, line: j.line, ...(slot ? { slot } : {}), kind, state: "making", at: j.submittedAt });
      }
    }
    return takes;
  }
  for (const [asset, v] of f.judged) {
    const line = asset.replace(/_t\d+(?:_\d+)?$/, "");
    const slot = slotOf(line, slots);
    const kind: Take["kind"] = /matte/.test(line) ? "matte" : /(^|-)key$|^k-|^face$|^plate/.test(line) ? "still" : "clip";
    takes.push({ asset, line, ...(slot ? { slot } : {}), kind, state: "ready", verdict: picks.get(line) === asset ? { by: "you", verdict: "accept" } : { by: "director", verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}) }, ...media(asset), ...panel(asset), at: v.at });
  }
  return takes;
}

/** The template's map with cells filled as the person's shots arrive (spec §4.8). */
export function fillCutMap(base: CutMapData | undefined, takes: Take[], files: FileSnapshot): CutMapData | undefined {
  if (!base || files.edl) return base;
  if (!base.shots.some((s) => s.slot)) return base;
  const kept = (line: string) => takes.filter((t) => t.line === line && t.state === "ready" && t.verdict?.verdict === "accept").at(-1);
  const making = (line: string) => takes.some((t) => t.line === line && t.state === "making");
  const yours = new Set(files.picks.map((p) => p.line));
  return {
    ...base,
    shots: base.shots.map((s) => {
      if (!s.slot) return s;
      const key = `${s.slot}-key`;
      const clip = kept(s.slot);
      const still = kept(key);
      const state = clip && clip.kind !== "still" ? "clip" : still || clip ? "still" : making(key) || making(s.slot) ? "making" : "empty";
      const thumb = (still ?? clip)?.thumb;
      return { ...s, state, ...(thumb ? { thumb } : {}), ...(yours.has(key) || yours.has(s.slot) ? { yours: true } : {}) };
    }),
  };
}

function phaseList(kind: RunKind, current: PhaseId | undefined, status: RunStatus): RunState["phases"] {
  const at = current ? PHASES.indexOf(current) : -1;
  return PHASES.map((id, i) => ({
    id,
    state: id === "study" && kind !== "decode" ? "skipped" : status === "done" ? "done" : i < at ? "done" : i === at ? "now" : "todo",
  }));
}

/** 0..100 over the non-skipped phases; inside stills/clips/mattes, by finished GPU seconds of the class. */
export function progress(kind: RunKind, phase: PhaseId | undefined, f: StreamFacts, files: FileSnapshot): number {
  const phases = PHASES.filter((p) => p !== "study" || kind === "decode");
  const total = phases.reduce((s, p) => s + WEIGHTS[p], 0);
  if (!phase) return 0;
  let done = 0;
  for (const p of phases) {
    if (p === phase) break;
    done += WEIGHTS[p];
  }
  return Math.min(99, Math.max(0, ((done + WEIGHTS[phase] * phaseFraction(phase, f, files)) / total) * 100));
}

function phaseFraction(phase: PhaseId, f: StreamFacts, files: FileSnapshot): number {
  if (phase === "study") return f.study?.pages ? Math.min(1, f.study.page / f.study.pages) : 0;
  if (phase === "stills" || phase === "clips" || phase === "mattes") {
    const planned = files.gpu.plannedSec[phase];
    return planned > 0 ? Math.min(1, files.gpu.doneSec[phase] / planned) : 0;
  }
  return 0;
}

function eta(kind: RunKind, phase: PhaseId | undefined, f: StreamFacts, files: FileSnapshot, minutes: Partial<Record<PhaseId, number>>): [number, number] | undefined {
  const phases = PHASES.filter((p) => p !== "study" || kind === "decode");
  const at = phase ? phases.indexOf(phase) : 0;
  let left = 0;
  for (const [i, p] of phases.entries()) {
    const m = minutes[p] ?? SEED_PHASE_MIN[p];
    if (i > at) left += m;
    else if (i === at) left += m * (1 - phaseFraction(p, f, files));
  }
  if (left <= 0) return undefined;
  return [Math.max(1, Math.floor(left * 0.7)), Math.max(1, Math.ceil(left * 1.3))];
}

function phaseDetail(phase: PhaseId, f: StreamFacts, files: FileSnapshot): string | undefined {
  const counts = (cls: PhaseClass) => {
    const jobs = files.jobs.filter((j) => classOf(j.spec.operation) === cls && j.state !== "cancelled");
    const plannedTakes = (files.estimate?.jobs ?? []).filter((j) => classOf(j.operation) === cls).reduce((s, j) => s + (j.takes ?? 1), 0);
    return { done: jobs.filter((j) => j.state === "completed").length, total: Math.max(plannedTakes, jobs.length) };
  };
  switch (phase) {
    case "setup":
      return f.setupDetail ?? "Checking your GPU";
    case "study":
      return f.study?.pages ? `Frame by frame · page ${f.study.page || 1} of ${f.study.pages}` : "Frame by frame";
    case "plan": {
      const p = f.planEstimate ?? (files.estimate ? { totalMinutes: files.estimate.totalMinutes, jobs: files.estimate.jobs } : undefined);
      return p ? `${p.jobs.length} jobs · ${p.totalMinutes.toFixed(1)} GPU min` : "Writing the shot list";
    }
    case "stills": {
      const c = counts("stills");
      const picked = [...files.verdicts].reverse().find((v) => v.verdict === "accept")?.asset ?? [...f.judged].reverse().find(([, v]) => v.verdict === "accept")?.[0];
      return `${c.done} of ${c.total} stills${picked ? ` · picked ${picked}` : ""}`;
    }
    case "clips": {
      const c = counts("clips");
      return `${c.done} of ${c.total} clips`;
    }
    case "mattes": {
      const c = counts("mattes");
      return `${c.total} cut-out${c.total === 1 ? "" : "s"}`;
    }
    case "cut": {
      const e = files.edl;
      if (!e) return undefined;
      const bpm = e.grid?.bpm;
      return `${e.shots.length} shots${bpm ? ` on the ${Math.round(bpm)} BPM grid` : ""}`;
    }
    case "render":
      return f.render === "final" && files.edl ? `Final · ${files.edl.canvas.width}×${files.edl.canvas.height}` : f.render === "final" ? "Final" : "Preview";
    case "check":
      return "Checking every frame";
    case "deliver":
      return undefined;
  }
}

/** The failure card's title and body. */
export function failureCopy(code: FailureCode, o: { message?: string; target?: string } = {}): { headline: string; message: string } {
  switch (code) {
    case "CLAUDE_MISSING":
      return { headline: FAILURE_TITLES[code], message: COPY.claudeMissing };
    case "CLAUDE_TOO_OLD":
      return { headline: FAILURE_TITLES[code], message: COPY.claudeTooOld };
    case "CLAUDE_LOGGED_OUT":
      return { headline: FAILURE_TITLES[code], message: COPY.claudeLoggedOut };
    case "GPU_NOT_CONFIGURED":
      return { headline: FAILURE_TITLES[code], message: COPY.gpuNotConfigured };
    case "BACKEND_DOWN":
      return { headline: o.target ? `Can't reach your GPU at ${o.target}` : FAILURE_TITLES[code], message: "Start ComfyUI and try again. Nothing was spent." };
    case "TOOLS_NOT_LOADED":
      return { headline: FAILURE_TITLES[code], message: COPY.toolsNotLoaded };
    default:
      return { headline: FAILURE_TITLES[code], message: o.message ?? "" };
  }
}

/** The full RunState: the record, what the stream said and what the files hold. */
export function buildState(rec: RunRecord, f: StreamFacts, files: FileSnapshot, ctx: BuildContext): RunState {
  const status = rec.status;
  const takes = buildTakes(rec.project, f, files);
  const phase = status === "done" ? "deliver" : f.phase;
  const counts = { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0 };
  for (const j of files.jobs) counts[j.state]++;
  const planEstimate = f.planEstimate ?? (files.estimate ? { totalMinutes: files.estimate.totalMinutes, jobs: files.estimate.jobs, ...(files.plan?.concept ? { concept: files.plan.concept } : {}) } : undefined);

  let headline: string;
  let detail: string | undefined;
  let attention = rec.attention;
  if (attention) attention = { ...attention, message: attention.message || attentionMessage(attention, { gpuCap: rec.caps.gpuMinutes, claudeCap: rec.caps.claudeUsd, plan: planEstimate }) };
  if (attention?.code === "NEEDS_APPROVAL" && !attention.plan && planEstimate) attention = { ...attention, plan: planEstimate };
  switch (status) {
    case "queued":
      // Waiting only while another edit holds a slot; otherwise it is about to start.
      if (ctx.waitingFor) {
        headline = "UP NEXT";
        detail = `Starts when ${ctx.waitingFor} finishes.`;
      } else {
        headline = "GETTING READY";
        detail = "Starting…";
      }
      break;
    case "starting":
      headline = "GETTING READY";
      detail = "Waking the director…";
      break;
    case "stopping":
      headline = "STOPPING";
      detail = `Cancelling ${counts.pending + counts.running} GPU job${counts.pending + counts.running === 1 ? "" : "s"}…`;
      break;
    case "paused":
      headline = attention ? ATTENTION_HEADLINES[attention.code] : "PAUSED";
      detail = attention?.message;
      break;
    case "done":
      headline = "READY.";
      break;
    case "cancelled": {
      headline = "STOPPED";
      const kept = takes.filter((t) => t.state === "ready" && t.verdict?.verdict !== "reject").length;
      detail = `Stopped by you. ${kept} finished shot${kept === 1 ? "" : "s"} kept.${rec.cancelledJobs ? ` ${rec.cancelledJobs} GPU job${rec.cancelledJobs === 1 ? "" : "s"} cancelled.` : ""}`;
      break;
    }
    case "interrupted":
      headline = "INTERRUPTED";
      detail = COPY.interrupted;
      break;
    case "failed": {
      const target = rec.failure?.code === "BACKEND_DOWN" ? rec.failure.hint : undefined;
      headline = rec.failure ? failureCopy(rec.failure.code, { message: rec.failure.message, target }).headline : "FAILED";
      detail = rec.failure?.message;
      break;
    }
    default:
      headline = phase ? PHASE_WORDS[phase] : "GETTING READY";
      detail = phase ? phaseDetail(phase, f, files) : undefined;
  }

  const elapsedSec = rec.attempts.reduce((s, a) => {
    const end = a.endedAt ? Date.parse(a.endedAt) : status === "starting" || status === "running" || status === "stopping" ? ctx.now : Date.parse(a.startedAt);
    return s + Math.max(0, (end - Date.parse(a.startedAt)) / 1000);
  }, 0);
  const running = status === "running" || status === "starting";
  const pct = status === "done" ? 100 : Math.max(ctx.floorPct ?? 0, Math.round(progress(rec.kind, phase, f, files)));
  const latest = files.project?.versions.at(-1);
  const delivered = rec.delivered;
  const estimatedUsd = rec.attempts.some((a) => a.costEstimated);
  const edl = files.edl;
  const result =
    status === "done" && latest
      ? {
          version: latest.version,
          url: `/media/${rec.project}/${latest.path.split("/").map(encodeURIComponent).join("/")}`,
          ...(files.silent[latest.version] ? { silentUrl: `/media/${rec.project}/${files.silent[latest.version]!.split("/").map(encodeURIComponent).join("/")}` } : {}),
          sizeMB: files.sizes[latest.version] ?? f.delivered?.sizeMB ?? 0,
          durationSec: f.delivered?.durationSec ?? edl?.canvas.durationSec ?? 0,
          width: edl?.canvas.width ?? 0,
          height: edl?.canvas.height ?? 0,
          fps: edl?.canvas.fps ?? 0,
          ...(delivered?.report ? { report: delivered.report } : {}),
          issues: delivered?.issues ?? [],
          costUsd: +rec.spentUsd.toFixed(2),
          ...(estimatedUsd ? { costEstimated: true } : {}),
          gpuMinutes: +files.gpu.committedMin.toFixed(1),
          wallMin: Math.round(elapsedSec / 60),
          licences: ctx.licences ?? [],
        }
      : undefined;

  return {
    id: rec.id,
    project: rec.project,
    kind: rec.kind,
    status,
    title: rec.title,
    ...(rec.template ? { template: rec.template } : {}),
    createdAt: rec.createdAt,
    ...(rec.attempts[0] ? { startedAt: rec.attempts[0].startedAt } : {}),
    ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
    updatedAt: rec.updatedAt,
    ...(phase ? { phase } : {}),
    phases: phaseList(rec.kind, phase, status),
    headline,
    ...(detail ? { detail } : {}),
    pct,
    ...(running && phase ? (() => {
      const e = eta(rec.kind, phase, f, files, ctx.phaseMinutes);
      return e ? { etaMin: e } : {};
    })() : {}),
    elapsedSec: Math.round(elapsedSec),
    ...(rec.kind === "decode" && f.study ? { study: f.study } : {}),
    jobs: { ...counts, total: files.jobs.length, gpuMinCommitted: +files.gpu.committedMin.toFixed(1), ...(files.estimate ? { gpuMinPlanned: files.estimate.totalMinutes } : {}) },
    takes,
    notes: f.notes,
    ...(files.cutMap ? { cutMap: fillCutMap(files.cutMap, takes, files) } : {}),
    ...(files.preview ? { preview: { url: `/media/${rec.project}/render/preview.mp4?v=${Math.round(files.preview.mtime)}`, mtime: files.preview.mtime } } : {}),
    caps: rec.caps,
    usage: {
      claudeUsd: +rec.spentUsd.toFixed(2),
      ...(estimatedUsd ? { claudeUsdEstimated: true } : {}),
      turns: rec.attempts.reduce((s, a) => s + (a.turns ?? 0), 0),
      ...(f.plan.fiveHour !== undefined || f.plan.sevenDay !== undefined ? { plan: f.plan } : {}),
    },
    ...(attention ? { attention } : {}),
    ...(rec.failure ? { failure: rec.failure } : {}),
    ...(result ? { result } : {}),
    ...(status === "queued" && ctx.queuePosition ? { queuePosition: ctx.queuePosition } : {}),
    warnings: [...new Set([...rec.warnings, ...f.warnings])],
    stalled: status === "running" && ctx.now - Math.max(f.lastActivity, files.changedAt) > STALL_MS,
    canContinue: status === "paused" || status === "interrupted" || status === "cancelled" || status === "done" || (status === "failed" && Boolean(rec.failure?.resumable)),
    canCancel: status === "queued" || status === "starting" || status === "running" || status === "paused",
  };
}

/** The short form for lists, the Making-now rail and the global channel. */
export function summarize(s: RunState): RunSummary {
  const extra =
    s.status === "running" && s.detail
      ? ` · ${s.detail}`
      : s.status === "paused" && s.attention?.code === "BUDGET_CAP" && s.attention.needsMinutes
        ? ` · approve ${Math.ceil((s.attention.needsMinutes * 1.1) / 5) * 5} GPU min`
        : "";
  return {
    id: s.id,
    project: s.project,
    title: s.title,
    status: s.status,
    headline: `${s.headline}${extra}`,
    pct: s.pct,
    ...(s.attention ? { attention: s.attention.code } : {}),
    ...(s.failure ? { failure: s.failure.code } : {}),
    ...(s.queuePosition ? { queuePosition: s.queuePosition } : {}),
    poster: `/api/projects/${s.project}/poster?h=240`,
    updatedAt: s.updatedAt,
  };
}
