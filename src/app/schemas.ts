/**
 * Zod schemas for the app's persisted files and request bodies. Each is checked against its interface in
 * types.ts (`satisfies z.ZodType<X>`), so the two cannot drift apart.
 */
import { z } from "zod";
import type {
  AppJson,
  AppLock,
  AppSettings,
  ApprovalFile,
  BriefFile,
  ContinueRun,
  GpuSetupRequest,
  HistoryFile,
  ProjectLock,
  RunDraft,
  RunRecord,
  SaveTemplateRequest,
  StartRun,
  UserPicksFile,
} from "./types.js";

/** Id formats (spec §8.3). Validated before any filesystem use: a valid id has no path separators. */
export const ID_PATTERNS = {
  project: /^[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4}$/,
  run: /^r-[0-9]{14}-[0-9a-f]{4}$/,
  upload: /^[0-9a-f]{16}$/,
  asset: /^[A-Za-z0-9_-]{1,64}$/,
  slug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  line: /^[a-z0-9_-]{1,48}$/,
} as const;

const iso = z.string().max(40);
const projectId = z.string().max(100).regex(ID_PATTERNS.project);
const runId = z.string().regex(ID_PATTERNS.run);
const slug = z.string().max(64).regex(ID_PATTERNS.slug);
const lineId = z.string().regex(ID_PATTERNS.line);
const assetId = z.string().regex(ID_PATTERNS.asset);
/** An upload id, or "<projectId>:<assetId>" for media reused from another project (Make another). */
const mediaRef = z.string().refine((s) => {
  if (ID_PATTERNS.upload.test(s)) return true;
  const [project, asset, extra] = s.split(":");
  return extra === undefined && ID_PATTERNS.project.test(project ?? "") && project!.length <= 100 && ID_PATTERNS.asset.test(asset ?? "");
}, "an upload id or <project>:<asset>");

const PHASE_IDS = ["setup", "study", "plan", "stills", "clips", "mattes", "cut", "render", "check", "deliver"] as const;
const RUN_STATUSES = ["queued", "starting", "running", "paused", "stopping", "cancelled", "interrupted", "failed", "done"] as const;
const ATTENTION_CODES = ["NEEDS_APPROVAL", "BUDGET_CAP", "OUT_OF_CREDITS", "BACKEND_DOWN", "USAGE_LIMIT", "USD_CAP", "QUESTION"] as const;
const FAILURE_CODES = [
  "CLAUDE_MISSING", "CLAUDE_TOO_OLD", "CLAUDE_LOGGED_OUT", "TOOLS_NOT_LOADED", "GPU_NOT_CONFIGURED",
  "BACKEND_DOWN", "MODELS_MISSING", "SPAWN_FAILED", "AGENT_ERROR", "CRASHED", "BLOCKED",
] as const;
const RunKindSchema = z.enum(["template", "decode"]);
const ClaudeAuthSchema = z.enum(["subscription", "api-key", "other", "unknown"]);

// ---------- requests ----------

const briefString = z.string().max(200);
export const BriefValueSchema = z.union([briefString, z.array(briefString).max(20), z.boolean()]);
const BriefValuesSchema = z.record(z.string().max(32), BriefValueSchema).refine((r) => Object.keys(r).length <= 40, "at most 40 brief fields");

export const RunDraftSchema = z.object({
  kind: RunKindSchema,
  template: slug.optional(),
  project: projectId.optional(),
  photos: z.array(mediaRef).min(1).max(10),
  music: mediaRef.optional(),
  musicChoice: z.enum(["template", "mine", "original"]),
  alignDrop: z.boolean(),
  mode: z.enum(["remix", "recreate"]),
  brief: BriefValuesSchema,
  note: z.string().max(2000).optional(),
  planFirst: z.boolean(),
  commercial: z.boolean(),
  clipsModel: z.enum(["configured", "wan22"]),
  title: z.string().max(80).optional(),
}) satisfies z.ZodType<RunDraft>;

const gpuCap = z.number().min(5).max(600);
const claudeCap = z.number().min(5).max(200);

export const StartRunSchema = RunDraftSchema.extend({
  approval: z.object({
    estimateKey: z.string().regex(/^[0-9a-f]{16}$/),
    gpuCapMinutes: gpuCap,
    claudeCapUsd: claudeCap,
    licencesShown: z.array(z.string().max(64)).max(40),
  }),
  consent: z.literal(true),
}) satisfies z.ZodType<StartRun>;

export const ContinueRunSchema = z.object({
  approval: z.object({ gpuCapMinutes: gpuCap.optional(), claudeCapUsd: claudeCap.optional() }).optional(),
  fit: z.boolean().optional(),
  finishPartial: z.boolean().optional(),
  reply: z.string().max(2000).optional(),
}) satisfies z.ZodType<ContinueRun>;

export const GpuSetupRequestSchema = z.object({
  kind: z.enum(["http", "cloud", "comfy-cli"]),
  url: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  saveEnvSecret: z.boolean().optional(),
}) satisfies z.ZodType<GpuSetupRequest>;

export const SaveTemplateRequestSchema = z.object({
  fromProject: projectId,
  title: z.string().min(1).max(80),
  slug: slug.optional(),
  description: z.string().max(300).optional(),
}) satisfies z.ZodType<SaveTemplateRequest>;

// ---------- settings ----------

export const DEFAULT_APP_SETTINGS: AppSettings = { model: "opus", maxParallelRuns: 1, defaultClaudeCapUsd: 15, keepAwake: true, licencesAcknowledged: [] };

const settingsFields = {
  model: z.enum(["opus", "sonnet"]),
  maxParallelRuns: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  defaultClaudeCapUsd: claudeCap,
  keepAwake: z.boolean(),
  licencesAcknowledged: z.array(z.string().max(64)).max(200),
  instagramUser: z.string().regex(/^[A-Za-z0-9._]{0,30}$/, "an Instagram username: letters, numbers, dots and underscores"),
  instagramBrowser: z.enum(["", "chrome", "firefox", "safari", "edge", "brave", "opera", "vivaldi", "chromium"]),
};

/** settings.json: missing keys take their defaults. */
export const AppSettingsSchema = z.object({
  model: settingsFields.model.default(DEFAULT_APP_SETTINGS.model),
  maxParallelRuns: settingsFields.maxParallelRuns.default(DEFAULT_APP_SETTINGS.maxParallelRuns),
  defaultClaudeCapUsd: settingsFields.defaultClaudeCapUsd.default(DEFAULT_APP_SETTINGS.defaultClaudeCapUsd),
  keepAwake: settingsFields.keepAwake.default(DEFAULT_APP_SETTINGS.keepAwake),
  licencesAcknowledged: settingsFields.licencesAcknowledged.default([]),
  instagramUser: settingsFields.instagramUser.optional(),
  instagramBrowser: settingsFields.instagramBrowser.optional(),
}) satisfies z.ZodType<AppSettings>;

/** PUT /api/settings body: any subset of the settings, no defaults filled in. */
export const AppSettingsPatchSchema = z.object(settingsFields).partial() satisfies z.ZodType<Partial<AppSettings>>;

// ---------- persisted files ----------

export const AppLockSchema = z.object({
  pid: z.number().int(),
  port: z.number().int(),
  version: z.string(),
  procStart: z.string(),
  startedAt: iso,
}) satisfies z.ZodType<AppLock>;

export const ProjectLockSchema = z.object({ run: runId, since: iso }) satisfies z.ZodType<ProjectLock>;

export const AppJsonSchema = z.object({
  v: z.literal(1),
  origin: z.object({
    kind: z.enum(["template", "decode"]),
    template: slug.optional(),
    sourceName: z.string().optional(),
    uploadHash: z.string().optional(),
  }),
  draft: RunDraftSchema.optional(),
  runs: z.array(runId),
  createdAt: iso,
}) satisfies z.ZodType<AppJson>;

export const ApprovalFileSchema = z.object({
  v: z.literal(1),
  run: runId,
  gpuMinutes: z.number().nonnegative(),
  claudeUsd: z.number().nonnegative(),
  approvedAt: iso,
  estimateKey: z.string(),
  history: z.array(
    z.object({
      at: iso,
      gpuMinutes: z.number().nonnegative(),
      claudeUsd: z.number().nonnegative(),
      reason: z.enum(["start", "plan-approved", "top-up", "continue"]),
    }),
  ),
}) satisfies z.ZodType<ApprovalFile>;

export const BriefFileSchema = z.object({
  v: z.literal(1),
  template: slug.optional(),
  words: z.array(z.object({ index: z.number().int().nonnegative(), start: z.union([z.string(), z.number()]), text: z.string() })),
  verbatim: z.array(z.string()),
  recolor: z.array(z.object({ from: z.string(), to: z.string() })),
  grid: z.object({ bpm: z.number().positive(), phase: z.number() }).optional(),
  durationSec: z.number().positive().optional(),
  audio: z.object({ asset: z.enum(["music", "ref"]), offset: z.number() }).optional(),
  promptLines: z.array(z.string()),
}) satisfies z.ZodType<BriefFile>;

export const UserPickSchema = z.object({ line: lineId, asset: assetId, at: iso });
export const UserPicksFileSchema = z.object({ v: z.literal(1), picks: z.array(UserPickSchema) }) satisfies z.ZodType<UserPicksFile>;

const PlanEstimateSchema = z.object({
  totalMinutes: z.number(),
  jobs: z.array(z.object({ line: z.string(), operation: z.string(), profile: z.string(), takes: z.number(), video: z.string(), minutes: z.number() })),
  concept: z.string().optional(),
});

export const AttentionSchema = z.object({
  code: z.enum(ATTENTION_CODES),
  message: z.string(),
  needsMinutes: z.number().optional(),
  capMinutes: z.number().optional(),
  resetsAt: iso.optional(),
  question: z.string().optional(),
  plan: PlanEstimateSchema.optional(),
});

export const FailureSchema = z.object({
  code: z.enum(FAILURE_CODES),
  message: z.string(),
  hint: z.string().optional(),
  resumable: z.boolean(),
});

export const RunRecordSchema = z.object({
  v: z.literal(1),
  id: runId,
  project: projectId,
  kind: RunKindSchema,
  status: z.enum(RUN_STATUSES),
  title: z.string(),
  template: slug.optional(),
  sessionId: z.string().uuid(),
  model: z.string(),
  claude: z.object({ path: z.string(), version: z.string(), auth: ClaudeAuthSchema, plan: z.string().optional() }),
  caps: z.object({ gpuMinutes: z.number(), claudeUsd: z.number() }),
  planFirst: z.boolean(),
  overrides: z.object({ profiles: z.record(z.string(), z.string().nullable()), commercial: z.boolean() }),
  attempts: z.array(
    z.object({
      n: z.number().int().positive(),
      reason: z.enum(["start", "continue", "fresh-session"]),
      pid: z.number().int().optional(),
      procStart: z.string().optional(),
      startedAt: iso,
      endedAt: iso.optional(),
      streamOffset: z.number().int().nonnegative(),
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().nullable().optional(),
      resultSubtype: z.string().optional(),
      costUsd: z.number().optional(),
      costEstimated: z.boolean().optional(),
      session: z.string().optional(),
      resumed: z.boolean().optional(),
      sessionCostUsd: z.number().optional(),
      durationMs: z.number().optional(),
      turns: z.number().optional(),
      promptFile: z.string(),
    }),
  ),
  phaseSec: z.partialRecord(z.enum(PHASE_IDS), z.number().nonnegative()).optional(),
  spentUsd: z.number().nonnegative(),
  versionsAtStart: z.number().int().nonnegative(),
  attention: AttentionSchema.optional(),
  failure: FailureSchema.optional(),
  delivered: z.object({ version: z.number().int(), path: z.string(), issues: z.array(z.string()), report: z.string().optional() }).optional(),
  cancelRequestedAt: iso.optional(),
  cancelledJobs: z.number().int().optional(),
  warnings: z.array(z.string()),
  createdAt: iso,
  updatedAt: iso,
  endedAt: iso.optional(),
}) satisfies z.ZodType<RunRecord>;

export const HistorySampleSchema = z.object({
  kind: z.enum(["shot-for-shot", "freestyle", "decode"]),
  template: slug.optional(),
  costUsd: z.number().nonnegative(),
  wallMin: z.number().nonnegative(),
  gpuMin: z.number().nonnegative(),
  phaseSec: z.partialRecord(z.enum(PHASE_IDS), z.number().nonnegative()),
  at: iso,
});

export const HistoryFileSchema = z.object({ v: z.literal(1), samples: z.array(HistorySampleSchema) }) satisfies z.ZodType<HistoryFile>;
