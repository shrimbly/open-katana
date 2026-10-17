import { describe, expect, it } from "vitest";
import {
  AppJsonSchema,
  AppLockSchema,
  AppSettingsPatchSchema,
  AppSettingsSchema,
  ApprovalFileSchema,
  BriefFileSchema,
  ContinueRunSchema,
  DEFAULT_APP_SETTINGS,
  GpuSetupRequestSchema,
  HistoryFileSchema,
  ID_PATTERNS,
  ProjectLockSchema,
  RunDraftSchema,
  RunRecordSchema,
  SaveTemplateRequestSchema,
  StartRunSchema,
  UserPicksFileSchema,
} from "../src/app/schemas.js";
import type { AttentionCode, BriefField, FailureCode, RunDraft, RunRecord, RunStatus, StartRun } from "../src/app/types.js";
import { BriefFieldSchema, listPresets } from "../src/presets/library.js";
import { DECODE_BRIEF } from "../src/presets/brief.js";
import { hypeBrief, hypeDetail, hypeEstimate, setupNoGpu, setupReady, templates } from "../studio/src/app/fixtures/browse.js";
import { decodedPage, decodeDone, decodeRunning, failedRuns, hypeDraft, pausedRuns, projects, resultPage, runs } from "../studio/src/app/fixtures/run.js";

const PROJECT = "20261017-hype-energy-a1b2";
const RUN = "r-20261017142233-a1b2";
const AT = "2026-10-17T14:22:33.000Z";

const draft: RunDraft = {
  kind: "template",
  template: "hype-energy",
  photos: ["0123456789abcdef", "fedcba9876543210"],
  music: "00112233aabbccdd",
  musicChoice: "mine",
  alignDrop: true,
  mode: "remix",
  brief: { who: "NOTHING NEW", drop: ["BORN", "DIFFERENT"], outfit: true },
  note: "make the spin really clean",
  planFirst: false,
  commercial: false,
  clipsModel: "configured",
};
const start: StartRun = { ...draft, approval: { estimateKey: "3f9a1c27b0d84e65", gpuCapMinutes: 50, claudeCapUsd: 15, licencesShown: ["qwen21-edit"] }, consent: true };

const record: RunRecord = {
  v: 1,
  id: RUN,
  project: PROJECT,
  kind: "template",
  status: "paused",
  title: "Hype Energy · rooftop car park",
  template: "hype-energy",
  sessionId: "6f1c2b9e-3a47-4d2e-9f0b-1c8e7a5d4b21",
  model: "opus",
  claude: { path: "/usr/local/bin/claude", version: "2.1.302", auth: "subscription", plan: "Claude Max" },
  caps: { gpuMinutes: 50, claudeUsd: 15 },
  planFirst: false,
  overrides: { profiles: { "clip.i2v": null }, commercial: false },
  attempts: [
    { n: 1, reason: "start", pid: 4242, procStart: "Fri Oct 17 14:22:36 2026", startedAt: AT, endedAt: AT, streamOffset: 58, exitCode: 0, signal: null, resultSubtype: "success", costUsd: 1.7, durationMs: 840000, turns: 41, promptFile: "prompt-1.txt" },
  ],
  spentUsd: 1.7,
  versionsAtStart: 0,
  attention: { code: "BUDGET_CAP", message: "The plan needs about 52 GPU min in total. You approved 45.", needsMinutes: 52, capMinutes: 45 },
  warnings: [],
  createdAt: AT,
  updatedAt: AT,
};

describe("persisted files", () => {
  it("parses a sample of every file the app writes", () => {
    expect(AppLockSchema.parse({ pid: 4242, port: 4310, version: "0.1.0", procStart: "Fri Oct 17 14:20:01 2026", startedAt: AT }).port).toBe(4310);
    expect(ProjectLockSchema.parse({ run: RUN, since: AT }).run).toBe(RUN);
    expect(AppJsonSchema.parse({ v: 1, origin: { kind: "template", template: "hype-energy" }, draft, runs: [RUN], createdAt: AT }).draft?.photos).toHaveLength(2);
    expect(
      ApprovalFileSchema.parse({ v: 1, run: RUN, gpuMinutes: 50, claudeUsd: 15, approvedAt: AT, estimateKey: "3f9a1c27b0d84e65", history: [{ at: AT, gpuMinutes: 50, claudeUsd: 15, reason: "start" }] }).gpuMinutes,
    ).toBe(50);
    expect(
      BriefFileSchema.parse({
        v: 1,
        template: "hype-energy",
        words: [{ index: 0, start: "b1.28", text: "NOTHING NEW" }],
        verbatim: [],
        recolor: [{ from: "#15319B", to: "#B0172A" }],
        grid: { bpm: 128, phase: 0.5 },
        durationSec: 18.42,
        audio: { asset: "music", offset: 38.86 },
        promptLines: ["Place: a rooftop car park, the whole edit happens here, soft overcast daylight."],
      }).words[0]!.start,
    ).toBe("b1.28");
    expect(UserPicksFileSchema.parse({ v: 1, picks: [{ line: "temple-key", asset: "temple-key_t2", at: AT }] }).picks).toHaveLength(1);
    expect(RunRecordSchema.parse(record)).toEqual(record);
    expect(HistoryFileSchema.parse({ v: 1, samples: [{ kind: "shot-for-shot", template: "hype-energy", costUsd: 5.12, wallMin: 24, gpuMin: 31.4, phaseSec: { setup: 60, clips: 480 }, at: AT }] }).samples).toHaveLength(1);
  });

  it("fills settings defaults and keeps patches partial", () => {
    expect(AppSettingsSchema.parse({})).toEqual(DEFAULT_APP_SETTINGS);
    expect(AppSettingsSchema.parse({ maxParallelRuns: 2 }).maxParallelRuns).toBe(2);
    expect(AppSettingsSchema.safeParse({ maxParallelRuns: 4 }).success).toBe(false);
    expect(AppSettingsPatchSchema.parse({ keepAwake: false })).toEqual({ keepAwake: false });
  });

  it("refuses files from another version", () => {
    expect(UserPicksFileSchema.safeParse({ v: 2, picks: [] }).success).toBe(false);
    expect(RunRecordSchema.safeParse({ ...record, id: "../../etc" }).success).toBe(false);
  });
});

describe("requests", () => {
  it("accepts a full draft, start, continue, setup and save request", () => {
    expect(RunDraftSchema.parse(draft)).toEqual(draft);
    expect(StartRunSchema.parse(start).approval.gpuCapMinutes).toBe(50);
    expect(ContinueRunSchema.parse({ approval: { gpuCapMinutes: 60 } }).approval?.gpuCapMinutes).toBe(60);
    expect(ContinueRunSchema.parse({ reply: "Use the second photo." }).reply).toBe("Use the second photo.");
    expect(GpuSetupRequestSchema.parse({ kind: "http", url: "http://127.0.0.1:8188" }).kind).toBe("http");
    expect(SaveTemplateRequestSchema.parse({ fromProject: PROJECT, title: "My edit", slug: "my-edit" }).slug).toBe("my-edit");
  });

  it("enforces the request limits", () => {
    const bad = (patch: Partial<RunDraft>) => RunDraftSchema.safeParse({ ...draft, ...patch }).success;
    expect(bad({ photos: [] })).toBe(false);
    expect(bad({ photos: Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(16, "0")) })).toBe(false);
    expect(bad({ note: "x".repeat(2001) })).toBe(false);
    expect(bad({ title: "x".repeat(81) })).toBe(false);
    expect(bad({ brief: { who: "x".repeat(201) } })).toBe(false);
    expect(bad({ brief: { drop: ["x".repeat(201)] } })).toBe(false);
    expect(bad({ brief: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}`, "x"])) })).toBe(false);
    expect(ContinueRunSchema.safeParse({ reply: "x".repeat(2001) }).success).toBe(false);
    const cap = (approval: Partial<StartRun["approval"]>) => StartRunSchema.safeParse({ ...start, approval: { ...start.approval, ...approval } }).success;
    expect(cap({ gpuCapMinutes: 4 })).toBe(false);
    expect(cap({ gpuCapMinutes: 601 })).toBe(false);
    expect(cap({ claudeCapUsd: 4 })).toBe(false);
    expect(cap({ claudeCapUsd: 201 })).toBe(false);
    expect(cap({ licencesShown: Array.from({ length: 41 }, (_, i) => `p${i}`) })).toBe(false);
    expect(StartRunSchema.safeParse({ ...start, consent: false }).success).toBe(false);
  });

  it("takes only ids, never paths", () => {
    const ok = (photos: string[]) => RunDraftSchema.safeParse({ ...draft, photos }).success;
    expect(ok([`${PROJECT}:s1`])).toBe(true);
    expect(ok(["../../etc/passwd"])).toBe(false);
    expect(ok([`${PROJECT}:s1:x`])).toBe(false);
    expect(ok(["/Users/me/photo.jpg"])).toBe(false);
    expect(RunDraftSchema.safeParse({ ...draft, kind: "decode", project: "/tmp/project" }).success).toBe(false);
    expect(ID_PATTERNS.run.test(RUN)).toBe(true);
    expect(ID_PATTERNS.project.test(PROJECT)).toBe(true);
  });
});

describe("template briefs", () => {
  it("parses the brief fields and every built-in preset", async () => {
    for (const f of [...hypeBrief, ...DECODE_BRIEF]) {
      const parsed: BriefField = BriefFieldSchema.parse(f);
      expect(parsed).toEqual(f);
    }
    const presets = await listPresets();
    expect(presets.filter((p) => p.source === "built-in")).toHaveLength(7);
    for (const p of presets) expect(Array.isArray(p.brief)).toBe(true);
  });
});

describe("step-0 UI fixtures", () => {
  it("covers the 7 templates, the receipt and setup", () => {
    expect(templates.map((t) => t.slug)).toEqual(["cold-stare", "golden-hour", "hype-energy", "iron-mindset", "neon-rain", "night-stare", "phonk-velocity"]);
    expect(templates.every((t) => t.inputs.music === "required" && t.media.example === undefined)).toBe(true);
    expect(hypeDetail.cutMap.shots).toHaveLength(49);
    expect(hypeDetail.cutMap.flashes).toHaveLength(7);
    expect(hypeDetail.cutMap.durationSec).toBeCloseTo(16.433, 3);
    expect(hypeDetail.words.map((w) => w.text)).toEqual(["NOTHING NEW", "SAME OLD DAY", "IS THAT ALL?", "BORN", "DIFFERENT", "PERIOD", "CROWN ACCEPTED"]);
    expect(hypeEstimate.jobs.reduce((s, j) => s + j.minutes, 0)).toBeCloseTo(30, 0);
    expect(setupReady.ready.make).toBe(true);
    expect(setupNoGpu.ready.make).toBe(false);
  });

  it("has a run per status, attention code and failure code, and valid drafts", () => {
    const statuses: RunStatus[] = ["queued", "starting", "running", "paused", "stopping", "cancelled", "interrupted", "failed", "done"];
    for (const s of statuses) expect(runs[s].status).toBe(s);
    const codes: AttentionCode[] = ["NEEDS_APPROVAL", "BUDGET_CAP", "OUT_OF_CREDITS", "BACKEND_DOWN", "USAGE_LIMIT", "USD_CAP", "QUESTION"];
    for (const c of codes) expect(pausedRuns[c].attention?.code).toBe(c);
    const failures = Object.keys(failedRuns) as FailureCode[];
    for (const f of failures) expect(failedRuns[f].failure?.code).toBe(f);
    expect(failures).toHaveLength(11);
    expect(RunDraftSchema.parse(hypeDraft)).toEqual(hypeDraft);
    expect(RunDraftSchema.parse(resultPage.draft)).toEqual(hypeDraft);
    for (const id of [...projects.map((p) => p.id), ...Object.values(runs).map((r) => r.project)]) expect(ID_PATTERNS.project.test(id), id).toBe(true);
    for (const r of [...Object.values(runs), ...Object.values(pausedRuns)]) expect(ID_PATTERNS.run.test(r.id), r.id).toBe(true);
    expect(new Set(projects.map((p) => p.state)).size).toBe(8);
    expect(decodeRunning.status).toBe("running");
    expect(decodeDone.status).toBe("done");
    expect(decodeDone.cutMap?.shots).toHaveLength(decodeDone.stats!.shots);
    for (const f of decodedPage.brief ?? []) expect(BriefFieldSchema.parse(f)).toEqual(f);
  });
});
