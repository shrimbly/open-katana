import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeDraft, estimateDraft, licenceSentence } from "../src/app/runs/estimate.js";
import { saveSettings } from "../src/app/settings.js";
import { resetSetupCache } from "../src/app/setup.js";
import type { DecodeState, RunDraft, SetupStatus } from "../src/app/types.js";
import { adjustedSeconds } from "../src/comfy/jobs.js";
import { type Config, ConfigSchema, saveConfig } from "../src/config.js";
import { getPreset, PresetSchema } from "../src/presets/library.js";
import { Workspace } from "../src/project/workspace.js";
import { State } from "../src/server/state.js";
import { registerGenerationTools } from "../src/server/tools-generate.js";

type Tool = (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean; content: { text?: string }[] }>;

const SETUP: SetupStatus = {
  version: "0.1.0",
  checkedAt: "2026-10-17T10:00:00.000Z",
  claude: { state: "ok", version: "2.1.302", auth: "subscription", plan: "Claude Max" },
  gpu: { state: "ok", kind: "http", where: "local", target: "http://127.0.0.1:9", profiles: [] },
  ffmpeg: { state: "ok", version: "7.1" },
  ready: { browse: true, decode: true, make: true },
  blockers: [],
};

const draft = (over: Partial<RunDraft> = {}): RunDraft => ({
  kind: "template",
  template: "hype-energy",
  photos: [],
  musicChoice: "mine",
  alignDrop: true,
  mode: "remix",
  brief: {},
  planFirst: false,
  commercial: false,
  clipsModel: "configured",
  ...over,
});

const BACKENDS: Record<string, Config["backend"]> = {
  http: { kind: "http", url: "http://127.0.0.1:9" },
  cloud: { kind: "cloud", apiKey: "test-key" },
  "comfy-cli": { kind: "comfy-cli", where: "cloud" },
};

/** GPU minutes [low, high] and line count per preset and backend, measured when the maths was unified (D45). */
const EXPECTED: Record<string, Record<string, [number, number, number]>> = {
  http: { "cold-stare": [11.7, 15.8, 12], "golden-hour": [17.6, 23.7, 18], "hype-energy": [22.1, 29.9, 25], "iron-mindset": [30, 40.5, 29], "neon-rain": [17.6, 23.7, 18], "night-stare": [25.7, 34.7, 23], "phonk-velocity": [15.6, 21.1, 16] },
  cloud: { "cold-stare": [16.5, 22.3, 12], "golden-hour": [24.8, 33.4, 18], "hype-energy": [31.5, 42.5, 25], "iron-mindset": [41, 55.3, 29], "neon-rain": [24.8, 33.4, 18], "night-stare": [34.7, 46.8, 23], "phonk-velocity": [22, 29.7, 16] },
  "comfy-cli": { "cold-stare": [18.5, 25, 12], "golden-hour": [27.8, 37.5, 18], "hype-energy": [35.4, 47.8, 25], "iron-mindset": [45.6, 61.5, 29], "neon-rain": [27.8, 37.5, 18], "night-stare": [38.4, 51.9, 23], "phonk-velocity": [24.7, 33.3, 16] },
};

const cfgOf = (backend: Config["backend"], over: Partial<Config> = {}) => ConfigSchema.parse({ backend, ...over });
const estimate = (d: RunDraft, cfg = cfgOf(BACKENDS.http)) => analyzeDraft(d, { setup: SETUP, cfg });

beforeAll(async () => {
  for (const v of ["OPEN_KATANA_BACKEND", "COMFYUI_URL", "COMFY_CLOUD_API_KEY", "COMFYUI_TOKEN"]) delete process.env[v];
  process.env.OPEN_KATANA_CLAUDE = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
  resetSetupCache();
  await saveConfig(cfgOf(BACKENDS.http));
});

describe("estimates before any agent runs", () => {
  it("gives stable ranges for every built-in template on each backend kind", async () => {
    for (const [kind, backend] of Object.entries(BACKENDS)) {
      for (const [slug, [low, high, lines]] of Object.entries(EXPECTED[kind]!)) {
        const { estimate: e } = await estimate(draft({ template: slug }), cfgOf(backend));
        expect(e.jobs, `${kind} ${slug}`).toHaveLength(lines);
        expect(e.gpu.lowMin, `${kind} ${slug} low`).toBeGreaterThan(low * 0.9);
        expect(e.gpu.lowMin, `${kind} ${slug} low`).toBeLessThan(low * 1.1);
        expect(e.gpu.highMin, `${kind} ${slug} high`).toBeCloseTo(e.gpu.lowMin * 1.35, 0);
        expect(e.gpu.highMin).toBeLessThan(high * 1.1);
        expect(e.gpu.where).toBe(kind === "http" ? "local" : "cloud");
      }
    }
  });

  it("caps: GPU at ceil(high × 1.15 / 5) × 5, Claude at the larger of the default and ceil(high × 1.6 / 5) × 5", async () => {
    const { estimate: e } = await estimate(draft());
    expect(e.gpu.suggestedCapMin).toBe(Math.ceil((e.gpu.highMin * 1.15) / 5) * 5);
    expect(e.claude).toMatchObject({ lowUsd: 4, highUsd: 8, auth: "subscription", plan: "Claude Max", note: "counts toward your Claude Max plan" });
    expect(e.claude.suggestedCapUsd).toBe(Math.max(15, Math.ceil((8 * 1.6) / 5) * 5));
    expect(e.wall).toEqual({ lowMin: 17, highMin: 28 });
    expect(e.gpu.note).toBe("Runs on this computer's GPU.");
    const cloud = (await estimate(draft(), cfgOf(BACKENDS.cloud))).estimate;
    expect(cloud.gpu.note).toBe("Uses Comfy Cloud GPU time from your plan. Credits are shared across your workspace.");
    expect(cloud.warnings.map((w) => w.code)).toContain("SHARED_CREDITS");
    const remote = (await estimate(draft(), cfgOf({ kind: "http", url: "https://gpu.example.net" }))).estimate;
    expect(remote.gpu.note).toBe("Runs on gpu.example.net.");
  });

  it("plans the skeleton's lines: the face crop, a 3-take keyframe and a clip per clip slot, mattes over their parent", async () => {
    const { estimate: e } = await estimate(draft());
    const byLine = new Map(e.jobs.map((j) => [j.line, j]));
    expect(byLine.get("face")).toMatchObject({ operation: "still.face", takes: 1 });
    expect(byLine.get("temple-key")).toMatchObject({ operation: "still.compose", takes: 3, profile: "qwen21-edit" });
    expect(byLine.get("temple")).toMatchObject({ operation: "clip.i2v", takes: 1, profile: "wan22-14b-i2v" });
    expect(byLine.get("spin-matte")).toMatchObject({ operation: "matte", videoSec: byLine.get("spin")!.videoSec });
    for (const j of e.jobs.filter((x) => x.operation.startsWith("clip."))) {
      expect(j.videoSec! % 0.5).toBe(0);
      expect(j.videoSec).toBeGreaterThanOrEqual(1);
      expect(j.videoSec).toBeLessThanOrEqual(10);
    }
    expect(e.groups.map((g) => g.label)).toEqual(["Keyframes", "Face crop", "Clips", "Cut-outs", "Queueing"]);
    const iron = (await estimate(draft({ template: "iron-mindset" }))).estimate;
    expect(iron.jobs.find((j) => j.line === "action")).toMatchObject({ operation: "clip.r2v", profile: "minimax-h3-r2v" });
    const neon = (await estimate(draft({ template: "neon-rain" }))).estimate;
    expect(neon.basis).toBe("recipe");
    expect(neon.jobs.every((j) => (j.operation === "still.compose" && j.takes === 3) || (j.operation === "clip.i2v" && j.videoSec === 3))).toBe(true);
  });

  it("uses the same budget maths as katana_plan for the same lines", async () => {
    const preset = await getPreset("hype-energy");
    const ws = await Workspace.create({ title: "plan maths", preset: preset.slug });
    await ws.writeJson("plan/preset.json", PresetSchema.parse(preset));
    const { estimate: e } = await estimate(draft());
    const tools = new Map<string, Tool>();
    registerGenerationTools({ registerTool: (name: string, _d: unknown, h: Tool) => tools.set(name, h) } as unknown as McpServer, new State());
    const jobs = e.jobs.map((j) => ({ line: j.line, operation: j.operation, prompt: `${j.line} shot`, takes: j.takes, ...(j.videoSec ? { durationSec: j.videoSec } : {}) }));
    const r = await tools.get("katana_plan")!({ project: ws.project.id, plan: { concept: "maths check", shots: [{ at: "0-1", role: "hero", description: "x", route: "i2v", lines: [] }], jobs } });
    expect(r.isError, r.content.map((c) => c.text).join("\n")).toBeFalsy();
    const plan = r.structuredContent as { totalMinutes: number; jobs: { line: string; profile: string; minutes: number }[] };
    expect(plan.totalMinutes).toBe(e.gpu.lowMin);
    for (const j of plan.jobs) {
      const mine = e.jobs.find((x) => x.line === j.line)!;
      expect(j.profile).toBe(mine.profile);
      expect(j.minutes).toBe(mine.minutes);
    }
    expect(adjustedSeconds(100, 3, { ratio: 1.5, kind: "cloud" })).toBe(150 + 45);
  });

  it("changes its key when the inputs change, not when caps, words or the title do", async () => {
    const base = (await estimate(draft())).estimate.key;
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect((await estimate(draft())).estimate.key).toBe(base);
    expect((await estimate(draft({ title: "Rooftop", note: "make the spin clean", brief: { who: "QUIET ONE" } }))).estimate.key).toBe(base);
    for (const changed of [draft({ commercial: true }), draft({ clipsModel: "wan22" }), draft({ planFirst: true }), draft({ template: "night-stare" }), draft({ alignDrop: false })]) {
      expect((await estimate(changed)).estimate.key).not.toBe(base);
    }
    await saveSettings({ defaultClaudeCapUsd: 40 });
    const raised = (await estimate(draft())).estimate;
    expect(raised.claude.suggestedCapUsd).toBe(40);
    expect(raised.key).toBe(base);
    await saveSettings({ defaultClaudeCapUsd: 15 });
  });

  it("Use Wan 2.2 for clips removes the MiniMax H3 licence note", async () => {
    const h3 = cfgOf(BACKENDS.http, { profiles: { "clip.i2v": "minimax-h3-i2v" } });
    const configured = (await estimate(draft(), h3)).estimate;
    expect(configured.canUseWan22).toBe(true);
    expect(configured.licences.map((l) => l.profile)).toContain("minimax-h3-i2v");
    const note = configured.licences.find((l) => l.profile === "minimax-h3-i2v")!;
    expect(note).toMatchObject({ title: "MiniMax H3", role: "clips", commercial: "restricted", note: "not licensed for use in the US, EU, UK or South Korea, on your own GPU or on Comfy Cloud; attribution required." });
    const wan = (await estimate(draft({ clipsModel: "wan22" }), h3)).estimate;
    expect(wan.canUseWan22).toBe(false);
    expect(wan.licences.some((l) => l.profile.startsWith("minimax-h3"))).toBe(false);
    expect(wan.jobs.find((j) => j.line === "temple")!.profile).toBe("wan22-14b-i2v");
    const a = await analyzeDraft(draft({ clipsModel: "wan22" }), { setup: SETUP, cfg: h3 });
    expect(a.overrides).toEqual({ "clip.i2v": null, "clip.flf": null });
  });

  it("paid or commercial work moves keyframes to Boogu Image Edit", async () => {
    const plain = (await estimate(draft())).estimate;
    expect(plain.licences.find((l) => l.profile === "qwen21-edit")).toMatchObject({ title: "Qwen-Image 2.1", role: "keyframes", note: "non-commercial licence, not for paid or commercial work." });
    const paid = await estimate(draft({ commercial: true }));
    expect(paid.estimate.jobs.find((j) => j.line === "temple-key")!.profile).toBe("boogu-edit");
    expect(paid.estimate.licences.some((l) => l.profile === "qwen21-edit")).toBe(false);
    expect(paid.commercial).toBe(true);
    expect(licenceSentence("qwen21-edit")).toBe("non-commercial licence, not for paid or commercial work.");
  });

  it("estimates a decoded edit from its shots, with the study cost per page", async () => {
    const ws = await Workspace.create({ title: "my fav edit" });
    const state: DecodeState = {
      project: ws.project.id,
      name: "my-fav-edit.mp4",
      videoUrl: "",
      status: "done",
      phases: [],
      format: { width: 1080, height: 1920, fps: 60, durationSec: 34, hasAudio: true },
      stats: { shots: 23, cuts: 22, flashes: 7, bpm: 144, cutsOnBeat: 0.89, cutsPerSec: 1.3, meanShotSec: 0.7, punches: 6, shakeSec: 1 },
      pages: 17,
    };
    await ws.writeJson("analysis/decode.json", state);
    await ws.writeJson("app.json", { v: 1, origin: { kind: "decode", sourceName: "my-fav-edit.mp4" }, runs: [], createdAt: "2026-10-17T10:00:00.000Z" });
    const remix = await estimateDraft({ ...draft({ kind: "decode", project: ws.project.id, musicChoice: "original" }), template: undefined });
    expect(remix.estimate.basis).toBe("decode");
    expect(remix.estimate.jobs).toHaveLength(2 * 10);
    expect(remix.estimate.jobs.filter((j) => j.operation === "clip.i2v").every((j) => j.videoSec === 1.5)).toBe(true);
    expect(remix.estimate.claude).toMatchObject({ lowUsd: 6.5, highUsd: 11.5 });
    expect(remix.estimate.warnings.map((w) => w.code)).toContain("LONG_EDIT");
    expect(remix.prompt).toContain(`Make the open-katana edit for project ${ws.project.id}.`);
    expect(remix.prompt).toContain('REFERENCE: asset ref ("my-fav-edit.mp4", 34 s)');
    expect(remix.prompt).toContain("WORDS: none given.");
    const recreate = await analyzeDraft({ ...draft({ kind: "decode", project: ws.project.id, musicChoice: "original", mode: "recreate" }), template: undefined }, { setup: SETUP, cfg: cfgOf(BACKENDS.http) });
    expect(recreate.estimate.jobs).toHaveLength(2 * 14);
  });

  it("previews the exact first prompt with the template's words", async () => {
    const { prompt } = await estimateDraft(draft({ photos: ["0123456789abcdef", "fedcba9876543210"], brief: { who: "QUIET ONE" } }));
    expect(prompt).toContain("Make the open-katana edit for project (new project).");
    expect(prompt).toContain('0 "QUIET ONE" · 1 "SAME OLD DAY"');
    expect(prompt).toContain("s2 is another photo of the person.");
    expect(prompt).not.toContain("0123456789abcdef");
    expect(prompt).toMatch(/SPEND: up to \d+ GPU minutes for this project\.\n$/);
  });
});

describe("the person's track on a freestyle template", () => {
  it("keeps the template's length, so the plan and the warnings describe the edit that will be made", async () => {
    // golden-hour's own soundtrack (15.02 s) as "my track": once retimed against a made-up 120 BPM it became a
    // 16.9 s edit with 11 job pairs and "Your track ends before the edit does".
    const ws = await Workspace.create({ title: "my golden track" });
    await ws.import(join(process.cwd(), "presets", "golden-hour", "soundtrack.m4a"), "audio", { id: "music" });
    const { estimate: e, fit } = await estimate(draft({ template: "golden-hour", music: `${ws.project.id}:music` }));
    expect(fit?.durationSec).toBe(14);
    expect(fit?.offsetSec).toBe(0);
    expect(e.jobs).toHaveLength(18);
    expect(e.warnings.map((w) => w.code)).not.toContain("TRACK_SHORT");
  });
});
