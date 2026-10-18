/**
 * Shared contract between the open-katana app server (src/app/**), the MCP app-run mode
 * (src/server/**) and the client (studio/src/app/**). Types only: the client imports it with
 * `import type`. Persisted files have matching zod schemas in src/app/schemas.ts.
 * Change rule: additive changes only, in a PR that touches nothing else.
 */

export type Iso = string;

// ---------- enums ----------
export type TemplateKind = "shot-for-shot" | "freestyle";
export type RunKind = "template" | "decode";
export type EditMode = "remix" | "recreate";
export type MusicChoice = "template" | "mine" | "original";
export type Commercial = "yes" | "no" | "restricted";
export type ClaudeAuth = "subscription" | "api-key" | "other" | "unknown";
export type BackendWhere = "cloud" | "local" | "remote";
export type BriefValue = string | string[] | boolean;

// ---------- Cut Map ----------
export type CutCellState = "sketch" | "empty" | "making" | "still" | "clip" | "final";
export interface CutMapShot {
  start: number;
  end: number;
  color?: string;
  slot?: string;
  label?: string;
  thumb?: string;
  state?: CutCellState;
  yours?: boolean;
}
export interface CutMapData {
  durationSec: number;
  aspect: number; // width / height
  shots: CutMapShot[];
  flashes: { t: number; durationSec: number; color: string }[];
  beats: number[];
  downbeats: number[];
  text: { index: number; start: number; end: number; text: string }[];
  dropSec?: number;
  energy?: number[]; // per second, 0..1 (decode)
  sketch?: { start: number; end: number; label: string }[]; // freestyle recipe blocks
  camera?: { t: number; end: number; type: "zoom-in" | "zoom-out" | "punch" | "shake" | "pan" | "tilt" | "roll"; direction?: string }[];
  approximate?: boolean; // beats assumed (no grid, no audio)
}

// ---------- templates ----------
export interface TitleStyle { font: string; weight: number; italic: boolean; case: "upper" | "lower" | "as-typed"; color: string }
export interface BriefBind { index: number; format?: string } // format: "{value}." etc.
export interface BriefRecolor { from: string; lightness?: number } // replace colour `from`; optional OKLCH L for this entry
export interface BriefField {
  id: string;
  label: string;
  help?: string;
  kind: "text" | "words" | "choice" | "color" | "toggle";
  required: boolean;
  default?: BriefValue;
  placeholder?: string | string[];
  options?: string[]; // choice
  allowOther?: boolean; // choice: free text
  optionPrompts?: Record<string, string>; // choice: BRIEF line per option
  suggestions: (string | string[])[];
  maxChars?: number; // per entry
  count?: number; // words without binds: max entries
  binds: BriefBind[]; // skeleton text cards (words: one per entry, in order)
  verbatim: boolean; // freestyle/decode: each entry must appear on some text card
  recolor?: BriefRecolor[]; // color
  prompt?: string; // text/choice/color: BRIEF line, "{value}" substituted
  promptOn?: string; // toggle
  promptOff?: string; // toggle
  collapsed: boolean;
}
export interface TemplateCard {
  slug: string;
  title: string;
  description: string;
  source: "built-in" | "user";
  kind: TemplateKind;
  format: { aspect: string; aspectValue: number; durationSec?: number; fps: number };
  stats: { shots?: number; texts?: number; flashes?: number; bpm?: number; slots?: number };
  titleStyle: TitleStyle;
  media: { poster?: string; example?: string }; // URLs under /templates/<slug>/
  credit?: string;
  flashing: boolean;
  cutMap: CutMapData;
  inputs: { images: { min: number; max: number; title: string }; music: "required" | "optional"; instructionsMaxChars: number };
}
export interface TemplateDetail extends TemplateCard {
  structure: { at: string; role: string; guidance: string }[];
  slots: { id: string; kind: string; description: string; uses: number }[];
  words: { index: number; text: string; startSec: number; endSec: number; font: string; weight: number; italic: boolean; uppercase: boolean }[];
  brief: BriefField[];
  soundtrack?: { url: string; title: string; artist?: string; licence: string; bpm?: number; dropSec?: number };
  look?: string;
  estimate: Estimate; // default: no photos counted, template track or no track, current backend
}

// ---------- uploads ----------
export type UploadPurpose = "photo" | "edit" | "music";
export interface UploadCheck { id: "small" | "tiny" | "wide" | "long" | "no-audio" | "heic-converted"; level: "ok" | "warn" | "error"; message: string }
export interface Upload {
  id: string;
  purpose: UploadPurpose;
  name: string;
  kind: "image" | "video" | "audio";
  bytes: number;
  url: string; // /uploads/<id>/media
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  hasAudio?: boolean;
  track?: { bpm: number; confidence: number; dropSec?: number; durationSec: number }; // music
  hash: string; // sha256 hex
  checks: UploadCheck[];
  createdAt: Iso;
}
export interface TrackFit {
  ok: boolean; // a steady beat was found
  bpm: number;
  aligned: boolean; // the drop was lined up
  offsetSec: number;
  dropSec?: number; // in the track
  durationSec: number; // edit length after retiming
  grid: { bpm: number; phase: number };
  note: string; // receipt copy
}

// ---------- drafts, estimates, starting ----------
export interface RunDraft {
  kind: RunKind;
  template?: string; // kind template
  project?: string; // kind decode: the decoded project
  photos: string[]; // upload ids or "<projectId>:<assetId>" (Make another); first = face
  music?: string; // upload id or "<projectId>:music"
  musicChoice: MusicChoice;
  alignDrop: boolean;
  mode: EditMode; // template runs: "remix"
  brief: Record<string, BriefValue>;
  note?: string;
  planFirst: boolean;
  commercial: boolean;
  clipsModel: "configured" | "wan22";
  title?: string;
}
export interface FieldProblem { field: string; message: string }
export interface LicenceNote {
  profile: string;
  title: string;
  role: string; // "keyframes", "clips", "cut-outs", …
  name: string;
  commercial: Commercial;
  note?: string;
  url?: string;
  acknowledged: boolean;
}
export interface Estimate {
  key: string; // sha256 (16 hex) of the inputs and numbers; caps are not part of it
  basis: "skeleton" | "recipe" | "decode" | "plan";
  gpu: { lowMin: number; highMin: number; suggestedCapMin: number; where: BackendWhere; target: string; note: string };
  claude: { lowUsd: number; highUsd: number; suggestedCapUsd: number; auth: ClaudeAuth; plan?: string; note: string; fiveHourUtilization?: number };
  wall: { lowMin: number; highMin: number };
  groups: { label: string; detail: string; profile: string; profileTitle: string; minutes: { low: number; high: number } }[];
  jobs: { line: string; operation: string; profile: string; takes: number; videoSec?: number; minutes: number }[];
  licences: LicenceNote[];
  canUseWan22: boolean;
  track?: TrackFit;
  warnings: { code: string; message: string }[];
  blockers: { code: SetupCode; message: string; action?: string }[];
}
export interface StartRun extends RunDraft {
  approval: { estimateKey: string; gpuCapMinutes: number; claudeCapUsd: number; licencesShown: string[] };
  consent: true;
}
export interface ContinueRun {
  approval?: { gpuCapMinutes?: number; claudeCapUsd?: number }; // new totals
  fit?: boolean; // "Make it fit"
  finishPartial?: boolean; // "Finish with what's made"
  reply?: string; // QUESTION reply or "ask for changes" (≤ 2000)
}

// ---------- runs ----------
export type RunStatus = "queued" | "starting" | "running" | "paused" | "stopping" | "cancelled" | "interrupted" | "failed" | "done";
export type AttentionCode = "NEEDS_APPROVAL" | "BUDGET_CAP" | "OUT_OF_CREDITS" | "BACKEND_DOWN" | "USAGE_LIMIT" | "USD_CAP" | "QUESTION";
export type FailureCode =
  | "CLAUDE_MISSING" | "CLAUDE_TOO_OLD" | "CLAUDE_LOGGED_OUT" | "TOOLS_NOT_LOADED" | "GPU_NOT_CONFIGURED"
  | "BACKEND_DOWN" | "MODELS_MISSING" | "SPAWN_FAILED" | "AGENT_ERROR" | "CRASHED" | "BLOCKED";
export type PhaseId = "setup" | "study" | "plan" | "stills" | "clips" | "mattes" | "cut" | "render" | "check" | "deliver";
export interface Take {
  asset: string;
  line: string;
  slot?: string;
  kind: "still" | "clip" | "matte";
  state: "making" | "ready" | "error";
  thumb?: string;
  url?: string;
  panel?: string; // identity panel URL
  verdict?: { by: "director" | "you"; verdict: "accept" | "reject"; reason?: string };
  at: Iso;
}
export interface PlanEstimate { totalMinutes: number; jobs: { line: string; operation: string; profile: string; takes: number; video: string; minutes: number }[]; concept?: string }
export interface RunState {
  id: string;
  project: string;
  kind: RunKind;
  status: RunStatus;
  title: string;
  template?: string;
  createdAt: Iso;
  startedAt?: Iso;
  endedAt?: Iso;
  updatedAt: Iso;
  phase?: PhaseId;
  phases: { id: PhaseId; state: "todo" | "now" | "done" | "skipped" }[];
  headline: string;
  detail?: string;
  pct: number; // 0..100, never decreases within an attempt
  etaMin?: [number, number];
  elapsedSec: number;
  study?: { page: number; pages: number };
  jobs: { pending: number; running: number; completed: number; error: number; cancelled: number; total: number; gpuMinCommitted: number; gpuMinPlanned?: number };
  takes: Take[];
  notes: { at: Iso; text: string }[]; // newest last, ≤ 200
  cutMap?: CutMapData;
  preview?: { url: string; mtime: number };
  caps: { gpuMinutes: number; claudeUsd: number };
  /** claudeUsdEstimated: part of the total is estimated from tokens (an attempt that ended without the CLI's own total). */
  usage: { claudeUsd: number; claudeUsdEstimated?: boolean; turns: number; plan?: { fiveHour?: number; sevenDay?: number; resetsAt?: Iso } };
  attention?: { code: AttentionCode; message: string; needsMinutes?: number; capMinutes?: number; resetsAt?: Iso; question?: string; plan?: PlanEstimate };
  failure?: { code: FailureCode; message: string; hint?: string; resumable: boolean };
  result?: {
    version: number; url: string; silentUrl?: string; sizeMB: number; durationSec: number; width: number; height: number; fps: number;
    report?: string; issues: string[]; costUsd: number; costEstimated?: boolean; gpuMinutes: number; wallMin: number; licences: LicenceNote[];
  };
  queuePosition?: number;
  warnings: string[];
  stalled: boolean;
  canContinue: boolean;
  canCancel: boolean;
}
export interface RunSummary {
  id: string;
  project: string;
  title: string;
  status: RunStatus;
  headline: string;
  pct: number;
  attention?: AttentionCode;
  failure?: FailureCode;
  queuePosition?: number;
  poster?: string;
  updatedAt: Iso;
}
export interface RunDiagnostics { stderrTail: string[]; exitCode?: number | null; signal?: string | null; sessionId: string; attempts: RunRecord["attempts"]; warnings: string[] }

// ---------- decode ----------
export type DecodePhase = "upload" | "probe" | "frames" | "cuts" | "motion" | "audio" | "energy" | "palette" | "pages" | "overview";
export interface DecodeState {
  project: string;
  name: string;
  videoUrl: string;
  status: "running" | "ready" | "done" | "error";
  phases: { id: DecodePhase; state: "todo" | "now" | "done"; done?: number; total?: number }[];
  tookMs?: number; // at "ready"
  format?: { width: number; height: number; fps: number; durationSec: number; hasAudio: boolean };
  stats?: { shots: number; cuts: number; flashes: number; bpm?: number; tempoSource?: "audio" | "cuts"; cutsOnBeat: number; cutsPerSec: number; meanShotSec: number; punches: number; shakeSec: number };
  read?: string[];
  cutMap?: CutMapData;
  shots?: { index: number; start: number; end: number; thumb: string; color: string }[];
  pages?: number;
  error?: { code: "NO_VIDEO_STREAM" | "DECODE_FAILED" | "TOO_LONG" | "TOO_SHORT"; message: string };
}

// ---------- projects ----------
export interface ProjectCard {
  id: string;
  title: string;
  stage: string;
  updatedAt: Iso;
  createdAt: Iso;
  versions: number;
  origin: "template" | "decode" | "chat";
  template?: string;
  state: "making" | "queued" | "needs-you" | "ready" | "decoded" | "stopped" | "failed" | "chat";
  progress?: { pct: number; headline: string };
  activeRun?: string;
  poster?: string;
  latest?: { url: string; version: number };
  aspect?: number;
  cutMap?: CutMapData;
}
export interface ProjectPageData {
  card: ProjectCard;
  run?: RunState; // latest run
  decode?: DecodeState;
  brief?: BriefField[]; // decode projects: the decoded-edit brief
  versions: { version: number; url: string; silentUrl?: string; sizeMB?: number; createdAt: Iso; note?: string }[];
  words?: { index: number; text: string; startSec: number; font: string; weight: number; italic: boolean; uppercase: boolean }[];
  canSaveTemplate: { ok: boolean; reason?: string };
  draft?: RunDraft; // for Make another
  locked: boolean;
}
export interface UserPick { line: string; asset: string; at: Iso }
export interface SaveTemplateRequest { fromProject: string; title: string; slug?: string; description?: string }

// ---------- setup, settings, info ----------
export type SetupCode = "CLAUDE_MISSING" | "CLAUDE_TOO_OLD" | "CLAUDE_LOGGED_OUT" | "GPU_NOT_CONFIGURED" | "GPU_UNREACHABLE" | "GPU_ENV_SECRET" | "FFMPEG_MISSING" | "MODELS_MISSING";
export interface SetupStatus {
  version: string;
  checkedAt: Iso;
  claude: { state: "ok" | "missing" | "too-old" | "logged-out" | "error"; version?: string; auth?: ClaudeAuth; plan?: string; missingFlags?: string[]; message?: string };
  gpu: {
    state: "ok" | "not-configured" | "unreachable" | "env-secret";
    kind?: "http" | "cloud" | "comfy-cli";
    where?: BackendWhere;
    target?: string;
    detail?: string;
    onDemandModels?: boolean;
    keySaved?: boolean;
    profiles: { id: string; operation: string; title: string; ready: boolean; missing: string[]; links: string[]; neededBy?: string[] }[]; // neededBy: titles of templates that use this operation
  };
  ffmpeg: { state: "ok" | "missing"; version?: string };
  ready: { browse: true; decode: boolean; make: boolean };
  blockers: { code: SetupCode; message: string }[];
}
export interface GpuSetupRequest { kind: "http" | "cloud" | "comfy-cli"; url?: string; apiKey?: string; saveEnvSecret?: boolean }
export interface AppSettings {
  model: "opus" | "sonnet";
  maxParallelRuns: 1 | 2 | 3;
  defaultClaudeCapUsd: number;
  keepAwake: boolean;
  licencesAcknowledged: string[];
  /** Instagram links: the account whose saved instaloader session to use ("" for none). Never a password. */
  instagramUser?: string;
  /** Instagram links: a browser to borrow the Instagram login from ("" for none). */
  instagramBrowser?: string;
}
/** GET /api/links: whether Instagram links can be fetched, and how the app signs in to Instagram. */
export interface LinkStatus {
  instaloader: { found: boolean; version?: string; install: string };
  /** A saved instaloader session, a browser's cookies, or signed out (public posts, often rate-limited). */
  login: { mode: "session" | "browser" | "none"; username?: string; browser?: string; sessionFound?: boolean };
}
export interface Info { name: "open-katana"; version: string; port: number; pid: number; owner: boolean; features: string[] } // features: "app","runs","decode","templates","heic" (macOS only)

// ---------- events ----------
export type ProjectEvent =
  | { type: "run"; state: RunState }
  | { type: "decode"; state: DecodeState }
  | { type: "export"; state: "rendering" | "done" | "error"; done?: number; total?: number; version?: number; url?: string; error?: string };
export type GlobalEvent = { type: "runs"; runs: RunSummary[] } | { type: "projects" } | { type: "setup" } | { type: "templates" };

// ---------- persisted files (schemas in src/app/schemas.ts) ----------
export interface AppLock { pid: number; port: number; version: string; procStart: string; startedAt: Iso }
export interface ProjectLock { run: string; since: Iso }
export interface AppJson {
  v: 1;
  origin: { kind: "template" | "decode"; template?: string; sourceName?: string; uploadHash?: string };
  draft?: RunDraft;
  runs: string[]; // newest last
  createdAt: Iso;
}
export interface ApprovalFile {
  v: 1;
  run: string;
  gpuMinutes: number; // total cap for the project
  claudeUsd: number;
  approvedAt: Iso;
  estimateKey: string;
  history: { at: Iso; gpuMinutes: number; claudeUsd: number; reason: "start" | "plan-approved" | "top-up" | "continue" }[];
}
export interface BriefFile {
  v: 1;
  template?: string;
  words: { index: number; start: string | number; text: string }[]; // bound skeleton cards (start copied from the skeleton)
  verbatim: string[]; // must appear on some text card
  recolor: { from: string; to: string }[];
  grid?: { bpm: number; phase: number };
  durationSec?: number;
  audio?: { asset: "music" | "ref"; offset: number };
  promptLines: string[];
}
export interface UserPicksFile { v: 1; picks: UserPick[] }
export interface RunRecord {
  v: 1;
  id: string;
  project: string;
  kind: RunKind;
  status: RunStatus;
  title: string;
  template?: string;
  sessionId: string; // uuid chosen by the app
  model: string;
  claude: { path: string; version: string; auth: ClaudeAuth; plan?: string };
  caps: { gpuMinutes: number; claudeUsd: number };
  planFirst: boolean;
  overrides: { profiles: Record<string, string | null>; commercial: boolean };
  attempts: {
    n: number;
    reason: "start" | "continue" | "fresh-session";
    pid?: number;
    procStart?: string;
    startedAt: Iso;
    endedAt?: Iso;
    streamOffset: number;
    exitCode?: number | null;
    signal?: string | null;
    resultSubtype?: string;
    /** What this attempt cost on its own; `costEstimated` when it ended without a result and was counted from its tokens. */
    costUsd?: number;
    costEstimated?: boolean;
    /** The session the attempt ran in, and whether it resumed it (the CLI's total then includes the earlier attempts). */
    session?: string;
    resumed?: boolean;
    /** The CLI's own total_cost_usd for the session at the end of this attempt. */
    sessionCostUsd?: number;
    durationMs?: number;
    turns?: number;
    promptFile: string;
  }[];
  /** Seconds per phase over the attempts that ended (for history samples). */
  phaseSec?: Partial<Record<PhaseId, number>>;
  spentUsd: number;
  versionsAtStart: number; // versions when the current attempt started
  attention?: RunState["attention"];
  failure?: RunState["failure"];
  delivered?: { version: number; path: string; issues: string[]; report?: string };
  cancelRequestedAt?: Iso;
  cancelledJobs?: number;
  warnings: string[];
  createdAt: Iso;
  updatedAt: Iso;
  endedAt?: Iso;
}
export interface HistorySample { kind: "shot-for-shot" | "freestyle" | "decode"; template?: string; costUsd: number; wallMin: number; gpuMin: number; phaseSec: Partial<Record<PhaseId, number>>; at: Iso }
export interface HistoryFile { v: 1; samples: HistorySample[] } // ≤ 30 per kind
