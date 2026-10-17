/**
 * Step-0 UI fixtures for the run side: one RunState per status, per attention code and per failure code,
 * a decode in progress and done, the project list and two project pages. Served by `?mock=1`.
 */
import type {
  AttentionCode,
  CutMapData,
  DecodeState,
  FailureCode,
  LicenceNote,
  PhaseId,
  ProjectCard,
  ProjectPageData,
  RunDraft,
  RunState,
  RunStatus,
  Take,
} from "../../../../src/app/types.js";
import { hypeDetail, templates } from "./browse.js";

export const PROJECT = "20261017-hype-energy-rooftop-a1b2";
export const DECODED_PROJECT = "20261017-my-fav-edit-9c3d";
const RUN = "r-20261017142233-a1b2";
const media = (project: string, rel: string) => `/media/${project}/${rel}`;
const thumb = (asset: string, project = PROJECT) => `/api/projects/${project}/thumb?asset=${encodeURIComponent(asset)}&t=0.5&h=160`;

const ORDER: PhaseId[] = ["setup", "study", "plan", "stills", "clips", "mattes", "cut", "render", "check", "deliver"];

/** Phase rail for a template run (no study) with `now` the current phase; "deliver" done means finished. */
function phases(now: PhaseId | "finished"): RunState["phases"] {
  const at = now === "finished" ? ORDER.length : ORDER.indexOf(now);
  return ORDER.map((id, i) => ({ id, state: id === "study" ? "skipped" : i < at ? "done" : i === at ? "now" : "todo" }));
}

const qwenLicence: LicenceNote = {
  profile: "qwen21-edit",
  title: "Qwen-Image 2.1 (identity keyframes, 25 steps)",
  role: "keyframes",
  name: "Qwen Research License",
  commercial: "no",
  note: "Research and evaluation use only.",
  url: "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE",
  acknowledged: true,
};

const SLOTS = ["temple", "detail", "sneaker", "low-angle", "top-down", "stand-wide", "spin", "walk", "smirk", "head-turn", "throne"];

/** Takes so far: three keyframe takes per slot (the director keeps one), clips for the first five slots. */
const takes: Take[] = [
  { asset: "face_t1", line: "face", kind: "still", state: "ready", thumb: thumb("face_t1"), url: media(PROJECT, "gen/face_t1.png"), verdict: { by: "director", verdict: "accept" }, at: "2026-10-17T14:25:10.000Z" },
  ...SLOTS.flatMap((slot, i): Take[] =>
    [1, 2, 3].map((n) => {
      const asset = `${slot}-key_t${n}`;
      const kept = n === (i % 3) + 1;
      const verdict: Take["verdict"] =
        slot === "smirk" && n === 1
          ? { by: "you", verdict: "accept" }
          : kept
            ? { by: "director", verdict: "accept" }
            : { by: "director", verdict: "reject", reason: n === 2 ? "different jaw" : "hands warped" };
      return { asset, line: `${slot}-key`, slot, kind: "still", state: "ready", thumb: thumb(asset), url: media(PROJECT, `gen/${asset}.png`), panel: media(PROJECT, `qa/${asset}-vs-s1.jpg`), verdict, at: "2026-10-17T14:31:00.000Z" };
    }),
  ),
  ...SLOTS.slice(0, 5).map((slot): Take => ({ asset: `${slot}_t1`, line: slot, slot, kind: "clip", state: "ready", thumb: thumb(`${slot}_t1`), url: media(PROJECT, `gen/${slot}_t1.mp4`), verdict: { by: "director", verdict: "accept" }, at: "2026-10-17T14:36:00.000Z" })),
  ...SLOTS.slice(5, 7).map((slot): Take => ({ asset: `${slot}_t1`, line: slot, slot, kind: "clip", state: "making", at: "2026-10-17T14:37:30.000Z" })),
];

/** The Hype Energy map filling in: kept keyframes show as stills, the first five slots also have clips. */
const fillingMap: CutMapData = {
  ...hypeDetail.cutMap,
  shots: hypeDetail.cutMap.shots.map((s) => {
    const i = SLOTS.indexOf(s.slot ?? "");
    if (i < 0) return { ...s, state: "empty" };
    const state = i < 5 ? "clip" : i < 7 ? "making" : "still";
    return { ...s, state, thumb: thumb(`${s.slot}-key_t${(i % 3) + 1}`), yours: s.slot === "smirk" };
  }),
};

const notes: RunState["notes"] = [
  { at: "2026-10-17T14:22:40.000Z", text: "Checking the GPU and reading the guide." },
  { at: "2026-10-17T14:24:05.000Z", text: "Planning 25 lines: 11 keyframes, 11 clips, the face crop and 2 cut-outs." },
  { at: "2026-10-17T14:25:30.000Z", text: "Shooting three takes of every keyframe against your face photo." },
  { at: "2026-10-17T14:33:10.000Z", text: "Kept one keyframe per slot; temple-key_t2 has the closest jaw and eyes." },
  { at: "2026-10-17T14:34:00.000Z", text: "Rolling clips from the kept keyframes, Wan 2.2 at 60 fps." },
];

const base: RunState = {
  id: RUN,
  project: PROJECT,
  kind: "template",
  status: "running",
  title: "Hype Energy · rooftop car park",
  template: "hype-energy",
  createdAt: "2026-10-17T14:22:33.000Z",
  startedAt: "2026-10-17T14:22:36.000Z",
  updatedAt: "2026-10-17T14:36:42.000Z",
  phase: "clips",
  phases: phases("clips"),
  headline: "ROLLING CLIPS",
  detail: "5 of 11 clips",
  pct: 62,
  etaMin: [6, 10],
  elapsedSec: 846,
  jobs: { pending: 4, running: 2, completed: 19, error: 0, cancelled: 0, total: 25, gpuMinCommitted: 18.2, gpuMinPlanned: 31.4 },
  takes,
  notes,
  cutMap: fillingMap,
  caps: { gpuMinutes: 50, claudeUsd: 15 },
  usage: { claudeUsd: 0, turns: 41, plan: { fiveHour: 0.41, sevenDay: 0.18, resetsAt: "2026-10-17T17:30:00.000Z" } },
  warnings: [],
  stalled: false,
  canContinue: false,
  canCancel: true,
};

const run = (o: Partial<RunState>): RunState => ({ ...base, ...o });

const planEstimate: NonNullable<RunState["attention"]>["plan"] = {
  totalMinutes: 34.1,
  concept: "An ordinary rooftop car park at noon; the drop turns it into their stage.",
  jobs: [
    { line: "face", operation: "still.face", profile: "face-crop", takes: 1, video: "", minutes: 0.2 },
    ...SLOTS.flatMap((slot) => [
      { line: `${slot}-key`, operation: "still.compose", profile: "qwen21-edit", takes: 3, video: "", minutes: 1.3 },
      { line: slot, operation: "clip.i2v", profile: "wan22-14b-i2v", takes: 1, video: "2.5 s", minutes: 1.5 },
    ]),
    { line: "spin-matte", operation: "matte", profile: "birefnet", takes: 1, video: "3 s", minutes: 0.6 },
    { line: "head-turn-matte", operation: "matte", profile: "birefnet", takes: 1, video: "2 s", minutes: 0.6 },
  ],
};

const paused = (attention: NonNullable<RunState["attention"]>, headline: string, o: Partial<RunState> = {}): RunState =>
  run({ status: "paused", headline, detail: undefined, attention, etaMin: undefined, canContinue: true, canCancel: true, usage: { ...base.usage, claudeUsd: 1.7 }, ...o });

/** One paused run per attention code (spec §4.8, paused cards). */
export const pausedRuns: Record<AttentionCode, RunState> = {
  NEEDS_APPROVAL: paused({ code: "NEEDS_APPROVAL", message: "The director's plan is ready: 47 jobs, about 34 GPU min.", plan: planEstimate }, "YOUR CALL", {
    phase: "plan",
    phases: phases("plan"),
    pct: 9,
    takes: [],
    notes: notes.slice(0, 2),
    cutMap: hypeDetail.cutMap,
    usage: { claudeUsd: 1.1, turns: 22, plan: { fiveHour: 0.38 } },
    jobs: { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0, total: 0, gpuMinCommitted: 0, gpuMinPlanned: 34.1 },
  }),
  BUDGET_CAP: paused({ code: "BUDGET_CAP", message: "The plan needs about 52 GPU min in total. You approved 45.", needsMinutes: 52, capMinutes: 45 }, "NEEDS YOUR OK", { caps: { gpuMinutes: 45, claudeUsd: 15 } }),
  OUT_OF_CREDITS: paused(
    { code: "OUT_OF_CREDITS", message: "Comfy Cloud is out of credits. Credits are shared across your Comfy workspace. Top up, then continue. Everything made so far is saved." },
    "OUT OF CREDITS",
  ),
  BACKEND_DOWN: paused({ code: "BACKEND_DOWN", message: "Lost your GPU at 127.0.0.1:8188. Start ComfyUI, then continue. Everything made so far is saved." }, "GPU OFFLINE"),
  USAGE_LIMIT: paused(
    { code: "USAGE_LIMIT", message: "Your Claude plan's limit was reached. It resets at 17:30. Everything made so far is saved.", resetsAt: "2026-10-17T17:30:00.000Z" },
    "PLAN LIMIT",
    { usage: { claudeUsd: 4.1, turns: 88, plan: { fiveHour: 1, sevenDay: 0.31, resetsAt: "2026-10-17T17:30:00.000Z" } } },
  ),
  USD_CAP: paused({ code: "USD_CAP", message: "The director used the $15 you approved before finishing." }, "BUDGET USED", { usage: { claudeUsd: 15, turns: 140 } }),
  QUESTION: paused(
    {
      code: "QUESTION",
      message: "The director has a question.",
      question: "None of the photos shows the face clearly enough to keep the likeness: the front one is blurred and the others are in profile. Can you add a sharp, front-facing photo?",
    },
    "THE DIRECTOR ASKS",
    { phase: "setup", phases: phases("setup"), pct: 3, takes: [], notes: notes.slice(0, 1), cutMap: hypeDetail.cutMap, jobs: { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0, total: 0, gpuMinCommitted: 0 } },
  ),
};

const failed = (code: FailureCode, message: string, resumable: boolean, hint?: string): RunState =>
  run({ status: "failed", headline: "STOPPED", detail: undefined, etaMin: undefined, failure: { code, message, hint, resumable }, canContinue: resumable, canCancel: false, endedAt: "2026-10-17T14:37:02.000Z" });

/** One failed run per failure code (spec §4.8, ended cards). */
export const failedRuns: Record<FailureCode, RunState> = {
  CLAUDE_MISSING: failed("CLAUDE_MISSING", "Claude Code isn't installed", false),
  CLAUDE_TOO_OLD: failed("CLAUDE_TOO_OLD", "This version can't run edits headlessly.", false, "Missing --setting-sources, --tools"),
  CLAUDE_LOGGED_OUT: failed("CLAUDE_LOGGED_OUT", "Claude Code isn't signed in", true),
  TOOLS_NOT_LOADED: failed("TOOLS_NOT_LOADED", "Claude Code started without the open-katana tools, so nothing was spent.", true),
  GPU_NOT_CONFIGURED: failed("GPU_NOT_CONFIGURED", "Connect a GPU to make edits", false),
  BACKEND_DOWN: failed("BACKEND_DOWN", "Can't reach your GPU at 127.0.0.1:8188", true),
  MODELS_MISSING: failed("MODELS_MISSING", "MiniMax H3 (clips). Download links are on the setup page.", false),
  SPAWN_FAILED: failed("SPAWN_FAILED", "spawn claude ENOENT", true),
  AGENT_ERROR: failed("AGENT_ERROR", "The director hit an error (error_during_execution)", true),
  CRASHED: failed("CRASHED", "Exit code 1 during 'Rolling clips'.", true),
  BLOCKED: failed("BLOCKED", "This edit is being made in another session.", true),
};

const result: NonNullable<RunState["result"]> = {
  version: 1,
  url: media(PROJECT, "deliver/hype-energy-rooftop-car-park_v1.mp4"),
  sizeMB: 22.5,
  durationSec: 16.433,
  width: 1080,
  height: 1920,
  fps: 60,
  // Shaped like a real director's report: a sentence, then Markdown bullets (the result shows it as plain text).
  report:
    "They own an ordinary rooftop car park: plain setup, a slow spin into black, then the drop flips it into a throne.\n- **Length:** 16.4 s at 60 fps on the 144 BPM grid.\n- **Generated:** 11 shots and 2 cut-outs of you.\n- **Known flaws:** the hands warp briefly in the spin, and the walk clip loops once at 0:12.",
  issues: ["Hands warp briefly in the spin.", "The walk clip loops once at 0:12."],
  costUsd: 5.12,
  gpuMinutes: 31.4,
  wallMin: 24,
  licences: [qwenLicence],
};

/** One run per status. `paused` and `failed` are the BUDGET_CAP and CRASHED cases; see pausedRuns and failedRuns. */
export const runs: Record<RunStatus, RunState> = {
  queued: run({
    id: "r-20261017143010-c3d4",
    status: "queued",
    phase: undefined,
    phases: phases("setup").map((p) => ({ ...p, state: p.id === "study" ? "skipped" : "todo" })),
    headline: "UP NEXT",
    detail: "Starts when Night Stare · stairs finishes.",
    pct: 0,
    etaMin: undefined,
    elapsedSec: 0,
    startedAt: undefined,
    takes: [],
    notes: [],
    cutMap: hypeDetail.cutMap,
    jobs: { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0, total: 0, gpuMinCommitted: 0 },
    usage: { claudeUsd: 0, turns: 0 },
    queuePosition: 1,
  }),
  starting: run({
    status: "starting",
    phase: "setup",
    phases: phases("setup"),
    headline: "GETTING READY",
    detail: "Waking the director…",
    pct: 1,
    elapsedSec: 4,
    takes: [],
    notes: [],
    cutMap: hypeDetail.cutMap,
    jobs: { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0, total: 0, gpuMinCommitted: 0 },
    usage: { claudeUsd: 0, turns: 0 },
  }),
  running: base,
  paused: pausedRuns.BUDGET_CAP,
  stopping: run({ status: "stopping", headline: "STOPPING", detail: "Cancelling 3 GPU jobs…", etaMin: undefined, canCancel: false }),
  cancelled: run({
    status: "cancelled",
    headline: "STOPPED",
    detail: "Stopped by you. 9 finished shots kept.",
    etaMin: undefined,
    canContinue: true,
    canCancel: false,
    endedAt: "2026-10-17T14:37:20.000Z",
    jobs: { ...base.jobs, pending: 0, running: 0, cancelled: 6 },
    takes: takes.filter((t) => t.state === "ready"),
  }),
  interrupted: run({
    status: "interrupted",
    headline: "INTERRUPTED",
    detail: undefined,
    etaMin: undefined,
    canContinue: true,
    canCancel: false,
    endedAt: "2026-10-17T14:41:00.000Z",
    takes: takes.filter((t) => t.state === "ready"),
  }),
  failed: failedRuns.CRASHED,
  done: run({
    status: "done",
    phase: "deliver",
    phases: phases("finished"),
    headline: "READY",
    detail: undefined,
    pct: 100,
    etaMin: undefined,
    elapsedSec: 1440,
    endedAt: "2026-10-17T14:46:33.000Z",
    jobs: { pending: 0, running: 0, completed: 25, error: 0, cancelled: 0, total: 25, gpuMinCommitted: 31.4, gpuMinPlanned: 31.4 },
    takes: takes.map((t) => (t.state === "making" ? { ...t, state: "ready", thumb: thumb(t.asset), verdict: { by: "director", verdict: "accept" } } : t)),
    cutMap: { ...hypeDetail.cutMap, shots: hypeDetail.cutMap.shots.map((s) => ({ ...s, state: "final" })) },
    preview: { url: media(PROJECT, "render/preview.mp4"), mtime: 1792247100000 },
    usage: { claudeUsd: 5.12, turns: 163, plan: { fiveHour: 0.52, sevenDay: 0.2, resetsAt: "2026-10-17T17:30:00.000Z" } },
    result,
    canContinue: true,
    canCancel: false,
  }),
};

// ---------- decode ----------

/** Shot lengths in beats at 144 BPM (0.417 s each), cut to 16.4 s. */
const BEATS_PER_SHOT = [2, 1, 1, 2, 1, 3, 1, 1, 2, 1, 1, 1, 2, 4, 1, 1, 1, 2, 1, 1, 3, 1, 2, 3];
const COLOURS = ["#2b3640", "#4a3b2f", "#1d2a33", "#6b5a44", "#202326", "#3c4b57", "#7a6650", "#262f38"];
const BEAT = 60 / 144;

const decodedShots = BEATS_PER_SHOT.reduce<{ start: number; end: number; color: string }[]>((acc, n, i) => {
  const start = acc.at(-1)?.end ?? 0;
  const end = i === BEATS_PER_SHOT.length - 1 ? 16.4 : +(start + n * BEAT).toFixed(3);
  return [...acc, { start, end, color: COLOURS[i % COLOURS.length]! }];
}, []);

const decodedBeats = Array.from({ length: 40 }, (_, i) => +(i * BEAT).toFixed(3)).filter((t) => t < 16.4);

const decodedMap: CutMapData = {
  durationSec: 16.4,
  aspect: 0.5625,
  shots: decodedShots.map((s) => ({ ...s, state: "final" })),
  flashes: [7.92, 8.33, 9.17, 10, 11.67, 13.33, 15].map((t) => ({ t, durationSec: 0.05, color: "#FFFFFF" })),
  beats: decodedBeats,
  downbeats: decodedBeats.filter((_, i) => i % 4 === 0),
  text: [
    { index: 0, start: 1.25, end: 2.5, text: "MAIN" },
    { index: 1, start: 8.33, end: 9.6, text: "EVENT" },
  ],
  dropSec: 8.1,
  energy: [0.22, 0.25, 0.3, 0.28, 0.35, 0.4, 0.46, 0.55, 1, 0.92, 0.88, 0.9, 0.85, 0.8, 0.86, 0.95, 0.7],
  camera: [
    { t: 3.33, end: 3.5, type: "punch", direction: "in" },
    { t: 5.0, end: 6.1, type: "zoom-in" },
    { t: 8.33, end: 9.2, type: "shake" },
    { t: 10.0, end: 10.2, type: "punch", direction: "in" },
    { t: 11.25, end: 12.3, type: "pan", direction: "pan_left" },
    { t: 13.33, end: 13.5, type: "punch", direction: "in" },
  ],
};

const decodePhases = (upTo: number): DecodeState["phases"] =>
  (["upload", "probe", "frames", "cuts", "motion", "audio", "energy", "palette", "pages", "overview"] as const).map((id, i) => ({
    id,
    state: i < upTo ? "done" : i === upTo ? "now" : "todo",
    ...(id === "frames" ? { done: i < upTo ? 984 : 612, total: 984 } : id === "pages" && i <= upTo ? { done: i < upTo ? 17 : 9, total: 17 } : {}),
  }));

const decodeFormat: DecodeState["format"] = { width: 1080, height: 1920, fps: 60, durationSec: 16.4, hasAudio: true };

/** Decoding: frames read, cuts being found. */
export const decodeRunning: DecodeState = {
  project: DECODED_PROJECT,
  name: "my-fav-edit.mp4",
  videoUrl: media(DECODED_PROJECT, "media/ref-5e1c0a.mp4"),
  status: "running",
  phases: decodePhases(3),
  format: decodeFormat,
};

/** Decoded, review pages ready for the director. */
export const decodeDone: DecodeState = {
  ...decodeRunning,
  status: "done",
  phases: decodePhases(10),
  tookMs: 3400,
  stats: { shots: 24, cuts: 23, flashes: 7, bpm: 144, tempoSource: "audio", cutsOnBeat: 0.89, cutsPerSec: 1.4, meanShotSec: 0.68, punches: 3, shakeSec: 0.9 },
  read: ["Fast and punchy.", "Cuts land on the beat, flashes hit the drops, and the camera punches in 3 times.", "The drop lands at 0:08."],
  cutMap: decodedMap,
  shots: decodedShots.map((s, index) => ({ index, start: s.start, end: s.end, color: s.color, thumb: `/api/projects/${DECODED_PROJECT}/thumb?asset=ref&t=${((s.start + s.end) / 2).toFixed(2)}&h=120` })),
  pages: 17,
};

// ---------- projects ----------

const card = (o: Partial<ProjectCard> & Pick<ProjectCard, "id" | "title" | "state">): ProjectCard => ({
  stage: "generating",
  updatedAt: "2026-10-17T14:36:42.000Z",
  createdAt: "2026-10-17T14:22:33.000Z",
  versions: 0,
  origin: "template",
  template: "hype-energy",
  poster: `/api/projects/${o.id}/poster?h=480`,
  aspect: 0.5625,
  ...o,
});

/** Your edits: one card per state, newest first with making and needs-you pinned on top. */
export const projects: ProjectCard[] = [
  card({ id: PROJECT, title: "Hype Energy · rooftop car park", state: "making", progress: { pct: 62, headline: "ROLLING CLIPS" }, activeRun: RUN, cutMap: fillingMap }),
  card({ id: "20261017-iron-mindset-track-7c21", title: "Iron Mindset · track", state: "needs-you", template: "iron-mindset", aspect: 1.778, progress: { pct: 48, headline: "NEEDS YOUR OK" }, activeRun: "r-20261017120501-7c21", cutMap: templates[3]!.cutMap }),
  card({ id: "20261017-night-stare-stairs-0f3e", title: "Night Stare · stairs", state: "queued", template: "night-stare", aspect: 1.333, stage: "intake", activeRun: "r-20261017143010-c3d4", cutMap: templates[5]!.cutMap }),
  card({
    id: "20261016-hype-energy-laundromat-b9a0",
    title: "Hype Energy · laundromat",
    state: "ready",
    stage: "delivered",
    versions: 2,
    latest: { url: media("20261016-hype-energy-laundromat-b9a0", "deliver/hype-energy-laundromat_v2.mp4"), version: 2 },
    updatedAt: "2026-10-16T21:12:00.000Z",
    createdAt: "2026-10-16T20:31:00.000Z",
    cutMap: { ...hypeDetail.cutMap, shots: hypeDetail.cutMap.shots.map((s) => ({ ...s, state: "final" })) },
  }),
  card({ id: DECODED_PROJECT, title: "my-fav-edit", state: "decoded", origin: "decode", template: undefined, stage: "analyzed", cutMap: decodedMap, updatedAt: "2026-10-16T18:02:00.000Z", createdAt: "2026-10-16T18:01:50.000Z" }),
  card({ id: "20261015-golden-hour-beach-4d2a", title: "Golden Hour · beach path", state: "stopped", template: "golden-hour", stage: "generating", updatedAt: "2026-10-15T19:40:00.000Z", createdAt: "2026-10-15T19:20:00.000Z", cutMap: templates[1]!.cutMap }),
  card({ id: "20261015-neon-rain-subway-e801", title: "Neon Rain · subway", state: "failed", template: "neon-rain", stage: "planned", updatedAt: "2026-10-15T09:12:00.000Z", createdAt: "2026-10-15T09:00:00.000Z", cutMap: templates[4]!.cutMap }),
  card({ id: "20261014-aura-remix-21f8", title: "Aura remix", state: "chat", origin: "chat", template: undefined, stage: "delivered", versions: 1, aspect: 1.333, updatedAt: "2026-10-14T22:10:00.000Z", createdAt: "2026-10-14T21:51:00.000Z" }),
];

/** The draft behind the hype run, reused by Make another. */
export const hypeDraft: RunDraft = {
  kind: "template",
  template: "hype-energy",
  photos: [`${PROJECT}:s1`, `${PROJECT}:s2`],
  music: `${PROJECT}:music`,
  musicChoice: "mine",
  alignDrop: true,
  mode: "remix",
  brief: { who: "NOTHING NEW", day: "SAME OLD DAY", doubt: "IS THAT ALL?", drop: ["BORN", "DIFFERENT"], slam: "PERIOD", closer: "CROWN ACCEPTED", place: "a rooftop car park", outfit: true },
  note: "make the spin really clean",
  planFirst: false,
  commercial: false,
  clipsModel: "configured",
  title: "Hype Energy · rooftop car park",
};

/** The result page of the finished hype run. */
export const resultPage: ProjectPageData = {
  card: card({ id: PROJECT, title: "Hype Energy · rooftop car park", state: "ready", stage: "delivered", versions: 1, latest: { url: result.url, version: 1 }, cutMap: runs.done.cutMap }),
  run: runs.done,
  versions: [{ version: 1, url: result.url, sizeMB: 22.5, createdAt: "2026-10-17T14:46:30.000Z", note: "delivered by the director" }],
  words: hypeDetail.words.map(({ endSec: _end, ...w }) => w),
  canSaveTemplate: { ok: false, reason: "Only edits made from a decoded video can be saved as templates." },
  draft: hypeDraft,
  locked: false,
};

/** A decoded edit before its first run: the make sheet's page. */
export const decodedPage: ProjectPageData = {
  card: projects.find((p) => p.id === DECODED_PROJECT)!,
  decode: decodeDone,
  brief: [
    {
      id: "words",
      label: "Your words",
      kind: "words",
      required: false,
      allowOther: false,
      placeholder: "Leave empty and the director writes new words in the same style",
      suggestions: [],
      maxChars: 16,
      count: 6,
      binds: [],
      verbatim: true,
      collapsed: false,
    },
    {
      id: "place",
      label: "Where should it happen?",
      kind: "text",
      required: false,
      allowOther: false,
      placeholder: "Same kind of places as the original",
      suggestions: [],
      maxChars: 80,
      binds: [],
      verbatim: false,
      prompt: "Place: {value}",
      collapsed: false,
    },
  ],
  versions: [],
  canSaveTemplate: { ok: false, reason: "Make your edit first. Saving it as a template is instant and free." },
  locked: false,
};

// ---------- more states (WP-E): stalled, chat, a decoded result, decode variants ----------

/** A run with no sign of progress for 12 minutes. */
export const stalledRun: RunState = run({ stalled: true, updatedAt: "2026-10-17T14:24:42.000Z" });

/** A run that made its first preview render. */
export const previewRun: RunState = run({
  phase: "render",
  phases: phases("render"),
  headline: "RENDERING",
  detail: "Preview",
  pct: 88,
  etaMin: [2, 4],
  preview: { url: media(PROJECT, "render/preview.mp4"), mtime: 1792246800000 },
  cutMap: runs.done.cutMap,
  takes: runs.done.takes,
});

/** A project made in a Claude Code chat: no app.json, no run. */
export const chatPage: ProjectPageData = {
  card: projects.find((p) => p.origin === "chat")!,
  versions: [
    { version: 1, url: media("20261014-aura-remix-21f8", "deliver/aura-remix_v1.mp4"), sizeMB: 14.2, createdAt: "2026-10-14T22:08:00.000Z", note: "delivered by the agent" },
  ],
  canSaveTemplate: { ok: false, reason: "Only edits made from a decoded video can be saved as templates." },
  locked: false,
};

const decodedResult: NonNullable<RunState["result"]> = {
  ...result,
  url: media(DECODED_PROJECT, "deliver/my-fav-edit_v1.mp4"),
  silentUrl: media(DECODED_PROJECT, "deliver/my-fav-edit_v1_silent.mp4"),
  durationSec: 16.4,
  sizeMB: 19.8,
  report: "A remix of the reference: the same 144 BPM rhythm and flash hits on the drop, with them in a night car park instead of the original's rooftop.",
  issues: ["The second clip drifts slightly off the beat at 0:05."],
  costUsd: 7.4,
  gpuMinutes: 38.2,
  wallMin: 31,
};

/** A decoded edit after its first run: the result has the original sound, so a silent copy too. */
export const decodedResultPage: ProjectPageData = {
  card: { ...projects.find((p) => p.id === DECODED_PROJECT)!, state: "ready", stage: "delivered", versions: 1, latest: { url: decodedResult.url, version: 1 } },
  run: {
    ...runs.done,
    id: "r-20261016181203-9c3d",
    project: DECODED_PROJECT,
    kind: "decode",
    template: undefined,
    title: "my-fav-edit",
    phases: phases("finished").map((p) => (p.id === "study" ? { ...p, state: "done" } : p)),
    cutMap: decodedMap,
    result: decodedResult,
  },
  decode: decodeDone,
  versions: [{ version: 1, url: decodedResult.url, silentUrl: decodedResult.silentUrl, sizeMB: 19.8, createdAt: "2026-10-16T18:44:00.000Z", note: "delivered by the director" }],
  words: [
    { index: 0, text: "MAIN", startSec: 1.25, font: "Anton", weight: 400, italic: false, uppercase: true },
    { index: 1, text: "EVENT", startSec: 8.33, font: "Anton", weight: 400, italic: false, uppercase: true },
  ],
  canSaveTemplate: { ok: true },
  locked: false,
};

/** Decoded far enough for the stats ("ready"), review pages still being prepared. */
export const decodeReady: DecodeState = { ...decodeDone, status: "ready", phases: decodePhases(8) };

/** A decoded clip with no sound and longer than 30 s. */
export const decodeNoAudio: DecodeState = {
  ...decodeDone,
  name: "skate-montage.mov",
  format: { ...decodeFormat, durationSec: 42.6, hasAudio: false },
  stats: { ...decodeDone.stats!, bpm: undefined, tempoSource: "cuts", cutsOnBeat: 0.31 },
  read: ["Steady.", "Cuts follow the picture, not the beat, and the camera punches in 3 times."],
  cutMap: { ...decodedMap, durationSec: 42.6, beats: [], downbeats: [], dropSec: undefined, approximate: true },
};

/** A file that turned out to have no picture. */
export const decodeError: DecodeState = {
  ...decodeRunning,
  status: "error",
  phases: decodePhases(1),
  error: { code: "NO_VIDEO_STREAM", message: "We couldn't find any picture in that file." },
};

/** `?mock=1&fixture=<name>` names for the project page: a status, `paused:<code>`, `failed:<code>`, or a page. */
export function fixturePage(name: string): ProjectPageData {
  const withRun = (r: RunState, o: Partial<ProjectPageData> = {}): ProjectPageData => ({
    ...resultPage,
    card: { ...resultPage.card, state: r.status === "done" ? "ready" : r.status === "paused" ? "needs-you" : r.status === "queued" ? "queued" : "making" },
    run: r,
    locked: ["queued", "starting", "running", "stopping", "paused"].includes(r.status),
    ...(r.status === "done" ? {} : { versions: [] }),
    ...o,
  });
  const [kind, code] = name.split(":");
  if (kind === "paused" && code && code in pausedRuns) return withRun(pausedRuns[code as AttentionCode]);
  if (kind === "failed" && code && code in failedRuns) return withRun(failedRuns[code as FailureCode]);
  if (kind === "stalled") return withRun(stalledRun);
  if (kind === "preview") return withRun(previewRun);
  if (kind === "chat") return chatPage;
  if (kind === "decoded-result") return decodedResultPage;
  if (kind && kind in runs) return withRun(runs[kind as RunStatus]);
  return resultPage;
}

/** `?mock=1&fixture=<name>` names for the decode page. */
export function fixtureDecode(name: string): DecodeState {
  return ({ running: decodeRunning, ready: decodeReady, done: decodeDone, "no-audio": decodeNoAudio, error: decodeError } as Record<string, DecodeState>)[name] ?? decodeDone;
}
