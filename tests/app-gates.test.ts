import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BriefField, RunRecord } from "../src/app/types.js";
import type { JobRecord } from "../src/comfy/jobs.js";
import { briefDefaults, resolveBrief } from "../src/presets/brief.js";
import { getPreset } from "../src/presets/library.js";
import { Workspace } from "../src/project/workspace.js";
import type { Edl } from "../src/render/edl.js";
import { run } from "../src/util/proc.js";
import { tempDir } from "./helpers/synth.js";

type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

const RUN = "r-20261017120000-ab12";

/** A ComfyUI stand-in: records every call; /prompt can be slowed down. */
function fakeComfy() {
  const calls: { path: string; body: string }[] = [];
  const state = { promptDelayMs: 0, prompts: 0 };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    calls.push({ path: `${req.method} ${req.url}`, body: Buffer.concat(chunks).toString() });
    const json = (data: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.url === "/prompt") {
      const id = `p${++state.prompts}`;
      if (state.promptDelayMs) await new Promise((r) => setTimeout(r, state.promptDelayMs));
      return json({ prompt_id: id });
    }
    if (req.url === "/upload/image") return json({ name: `up-${calls.length}.png`, subfolder: "" });
    if (req.url === "/queue") return json({ queue_running: [], queue_pending: [] });
    if (req.url?.startsWith("/history/")) return json({});
    if (req.url === "/system_stats") return json({ system: { comfyui_version: "0.0.test" }, devices: [{ name: "fake" }] });
    res.writeHead(404).end();
  });
  return { server, calls, state };
}

describe("MCP app-run mode", () => {
  let home: string;
  let comfy: ReturnType<typeof fakeComfy>;
  let comfyUrl: string;
  let app: Client;
  let chat: Client;
  let pinned: Workspace;
  let other: Workspace;

  const root = () => join(home, "projects");
  const open = (ws: Workspace) => Workspace.open(ws.dir);
  const connect = async (env: Record<string, string>) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "mcp"],
      env: { ...getDefaultEnvironment(), OPEN_KATANA_HOME: home, OPEN_KATANA_BACKEND: "http", COMFYUI_URL: comfyUrl, ...env },
      stderr: "ignore",
    });
    const client = new Client({ name: "app-gates", version: "0" });
    await client.connect(transport);
    return { client, transport };
  };
  const appEnv = (project: string) => ({ OPEN_KATANA_RUN: RUN, OPEN_KATANA_PROJECT: project, OPEN_KATANA_APPROVAL: "file" });
  const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const approve = (ws: Workspace, gpuMinutes: number) =>
    ws.writeJson("plan/approval.json", { v: 1, run: RUN, gpuMinutes, claudeUsd: 15, approvedAt: new Date().toISOString(), estimateKey: "0123456789abcdef", history: [] });
  const still = (line: string, extra: Record<string, unknown> = {}) => ({ line, operation: "still.generate" as const, prompt: "an empty stairwell at night, no people", takes: 1, ...extra });

  beforeAll(async () => {
    home = await tempDir("ok-gates-home-");
    const media = await tempDir("ok-gates-media-");
    comfy = fakeComfy();
    await new Promise<void>((r) => comfy.server.listen(0, "127.0.0.1", r));
    comfyUrl = `http://127.0.0.1:${(comfy.server.address() as { port: number }).port}`;

    // The pinned project: a Night Stare (4:3) template run with no reference, a photo, a track and two takes of one line.
    const nightStare = await getPreset("night-stare");
    pinned = await Workspace.create({ title: "night stare gates", preset: "night-stare", root: root() });
    const { dir: _d, source: _s, referencePath: _r, thumbnailPath: _t, ...preset } = nightStare;
    await pinned.writeJson("plan/preset.json", preset);
    const photo = join(media, "hero.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=768x1024", "-frames:v", "1", photo]);
    await pinned.import(photo, "subject");
    const track = join(media, "track.wav");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=12", track]);
    await pinned.import(track, "audio", { id: "music" });
    await mkdir(pinned.path("gen", "street-key"), { recursive: true });
    for (const take of [1, 2]) {
      const file = pinned.path("gen", "street-key", `street-key_t${take}.png`);
      await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${take}0${take}0${take}0:s=320x240`, "-frames:v", "1", file]);
      await pinned.register({ path: file, role: "generated", id: `street-key_t${take}`, lineId: "street-key", jobId: `street-key_t${take}` });
    }
    other = await Workspace.create({ title: "someone else", root: root() });

    app = (await connect(appEnv(pinned.project.id))).client;
    chat = (await connect({})).client;
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await chat?.close().catch(() => undefined);
    comfy?.server.close();
  });

  it("works on its own project only", async () => {
    const r = await call(app, "katana_status", { project: other.project.id });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`[LOCKED] This run only works on project ${pinned.project.id}.`);
    const mine = await call(app, "katana_status", {});
    expect(mine.isError).toBeFalsy();
    expect(textOf(mine)).toContain(`Project ${pinned.project.id}`);
    expect(textOf(await call(app, "katana_status", { project: pinned.dir }))).toMatch(/^\[LOCKED\]/);
  });

  it("refuses starts, imports, presets, the studio and backend changes", async () => {
    const refused: [string, Record<string, unknown>][] = [
      ["katana_start", { preset: "night-stare" }],
      ["katana_import", { project: pinned.project.id, source: "/etc/hosts", role: "style" }],
      ["katana_presets", {}],
      ["katana_preset_save", { slug: "x", title: "x", description: "x", category: "personalized_edits" }],
      ["katana_studio", { project: pinned.project.id }],
      ["katana_backend", { action: "set", kind: "http", url: "http://evil.example:8188" }],
    ];
    for (const [name, args] of refused) {
      const r = await call(app, name, args);
      expect(r.isError, name).toBe(true);
      expect(textOf(r), name).toBe("[APP] Not available in app runs.");
    }
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect((await call(app, "katana_backend", { action: "status" })).isError).toBeFalsy();
  });

  it("refuses to spend without the person's approval", async () => {
    const r = await call(app, "katana_generate", { project: pinned.project.id, approved: true, jobs: [still("plate")] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("[APPROVAL] The person approves spending in the app. Stop now and summarise the plan in two lines.");
    expect(comfy.calls.some((c) => c.path === "POST /prompt")).toBe(false);
  });

  it("makes lines at the template's aspect when there is no reference", async () => {
    const plan = await call(app, "katana_plan", {
      project: pinned.project.id,
      plan: { concept: "Stairs at night", shots: [{ at: "0-11", role: "plate", description: "stairwell", route: "still", lines: ["plate"] }], jobs: [still("plate")] },
    });
    expect(plan.isError, textOf(plan)).toBeFalsy();
    const [w, h] = String((plan.structuredContent!.jobs as { size: string }[])[0]!.size).split("×").map(Number);
    expect(w! / h!).toBeCloseTo(4 / 3, 1);
    const saved = (await open(pinned).then((ws) => ws.readJson<{ jobs: { aspect?: number }[] }>("plan/plan.json")))!;
    expect(saved.jobs[0]!.aspect).toBeCloseTo(4 / 3, 4);
    // Before the person approves, the plan names no budget of its own (config.budgetMinutes isn't theirs).
    expect(plan.structuredContent!.budgetMinutes).toBeUndefined();
    expect(textOf(plan)).toContain("the person approves the spend in the app");
    expect(textOf(plan)).not.toContain("ask for approval");

    await approve(pinned, 50);
    // With an approval, the plan reports the cap katana_generate enforces.
    const again = await call(app, "katana_plan", {
      project: pinned.project.id,
      plan: { concept: "Stairs at night", shots: [{ at: "0-11", role: "plate", description: "stairwell", route: "still", lines: ["plate"] }], jobs: [still("plate")] },
    });
    expect(again.structuredContent!.budgetMinutes).toBe(50);
    expect(textOf(again)).toContain("the person approved 50 GPU min in total");
    const gen = await call(app, "katana_generate", { project: pinned.project.id, approved: true, jobs: [still("plate2")] });
    expect(gen.isError, textOf(gen)).toBeFalsy();
    const jobs = (await (await open(pinned)).readJson<JobRecord[]>("plan/jobs.json"))!;
    const job = jobs.find((j) => j.line === "plate2")!;
    expect(job.width / job.height).toBeCloseTo(4 / 3, 1);
  });

  it("stops at the approved GPU cap with a machine-readable error, and lets the agent lower it", async () => {
    const ws = await open(pinned);
    const big: JobRecord = { ...(await ws.readJson<JobRecord[]>("plan/jobs.json"))![0]!, id: "big_t1", line: "big", estimateSec: 600, state: "completed" };
    await ws.writeJson("plan/jobs.json", [big]);
    await approve(ws, 5);
    const r = await call(app, "katana_generate", { project: pinned.project.id, approved: true, jobs: [still("plate3")] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^\[BUDGET\] needs=1\d\.\d cap=5 This needs about 1\d GPU minutes in total; the person approved 5\. Stop now\.$/);
    await ws.writeJson("plan/jobs.json", []);
    await approve(ws, 50);
    const lowered = await call(app, "katana_generate", { project: pinned.project.id, approved: true, budgetMinutes: 0.1, jobs: [still("plate3")] });
    expect(textOf(lowered)).toMatch(/^\[BUDGET\] needs=\d+\.\d cap=0\.1 /);
    const raised = await call(app, "katana_generate", { project: pinned.project.id, approved: true, budgetMinutes: 500, jobs: [still("plate3")] });
    expect(raised.isError, textOf(raised)).toBeFalsy();
  });

  it("keeps the person's take pick in katana_judge, @line references and katana_edit", async () => {
    const ws = await open(pinned);
    await approve(ws, 50);
    const done = (take: number): JobRecord => ({
      id: `street-key_t${take}`, line: "street-key", take, spec: still("street-key"), profile: "z-image-turbo", backend: comfyUrl, promptId: `k${take}`,
      state: "completed", seed: take, width: 320, height: 240, estimateSec: 5, submittedAt: new Date().toISOString(), outputs: [`street-key_t${take}`],
    });
    await ws.writeJson("plan/jobs.json", [done(1), done(2)]);
    await ws.writeJson("qa/verdicts.json", [{ asset: "street-key_t1", verdict: "accept", at: new Date().toISOString() }]);
    await ws.writeJson("qa/user-picks.json", { v: 1, picks: [{ line: "street-key", asset: "street-key_t2", at: new Date().toISOString() }] });

    const keep = "[USER_PICK] The person picked street-key_t2 for line street-key in the app; keep it.";
    expect(textOf(await call(app, "katana_judge", { project: pinned.project.id, asset: "street-key_t1", verdict: "accept" }))).toBe(keep);
    expect(textOf(await call(app, "katana_judge", { project: pinned.project.id, asset: "street-key_t2", verdict: "reject", reason: "jaw" }))).toBe(keep);
    expect((await call(app, "katana_judge", { project: pinned.project.id, asset: "street-key_t1", verdict: "reject", reason: "jaw" })).isError).toBeFalsy();
    expect((await call(app, "katana_judge", { project: pinned.project.id, asset: "street-key_t2", verdict: "accept" })).isError).toBeFalsy();

    // The director had accepted take 1, but "@street-key" now means the person's pick.
    await ws.writeJson("qa/verdicts.json", [{ asset: "street-key_t1", verdict: "accept", at: new Date().toISOString() }]);
    const gen = await call(app, "katana_generate", {
      project: pinned.project.id,
      approved: true,
      jobs: [{ line: "street", operation: "still.compose", prompt: "the person on the stairs", images: ["s1", "@street-key"], takes: 1 }],
    });
    expect(gen.isError, textOf(gen)).toBeFalsy();
    const street = (await (await open(pinned)).readJson<JobRecord[]>("plan/jobs.json"))!.find((j) => j.line === "street")!;
    expect(street.spec.images).toEqual(["s1", "street-key_t2"]);

    const edl = { canvas: { width: 320, height: 240, fps: 24 }, audio: null, shots: [{ start: 0, end: 1, source: { asset: "street-key_t1" } }] };
    const edit = await call(app, "katana_edit", { project: pinned.project.id, edl });
    expect(edit.isError).toBe(true);
    expect(textOf(edit)).toBe("[USER_PICK] Use street-key_t2 instead of street-key_t1 (the person's pick for line street-key).");
    edl.shots[0]!.source.asset = "street-key_t2";
    expect((await call(app, "katana_edit", { project: pinned.project.id, edl })).isError).toBeFalsy();
    await ws.writeJson("qa/user-picks.json", { v: 1, picks: [] });
  });

  it("builds the edit with the person's words and refuses an edit that changes them", async () => {
    const preset = await getPreset("night-stare");
    const values = { ...briefDefaults(preset.brief as BriefField[]), line: ["WORK", "WHILE", "THEY", "SLEEP"] };
    const fit = { ok: true, bpm: 120, aligned: false, offsetSec: 0, durationSec: 11, grid: { bpm: 120, phase: 0 }, note: "" };
    const { file, problems } = resolveBrief(preset, values, { fit, musicChoice: "mine" });
    expect(problems).toEqual([]);
    const ws = await open(pinned);
    await ws.writeJson("plan/brief.json", file);
    const slots = Object.fromEntries(preset.slots.map((s) => [s.id, "s1"]));
    const built = await call(app, "katana_edit", { project: pinned.project.id, fromPreset: { slots } });
    expect(built.isError, textOf(built)).toBeFalsy();
    expect(textOf(built)).toContain("Built from the skeleton with the person's words, soundtrack and grid already applied. Keep the words exactly; adjust only takes or timing if needed.");
    expect(textOf(built)).not.toContain("Adapt the wording");
    const edl = (await (await open(pinned)).readJson<Edl>("render/edl.json"))!;
    expect(edl.text.slice(0, 4).map((t) => t.text)).toEqual(["WORK", "WHILE", "THEY", "SLEEP"]);
    expect(edl.audio).toMatchObject({ asset: "music", offset: 0 });
    expect(edl.grid).toEqual({ bpm: 120, phase: 0 });

    edl.text[0]!.text = "BUILT";
    edl.text[3]!.start = "b21";
    const changed = await call(app, "katana_edit", { project: pinned.project.id, edl });
    expect(changed.isError).toBe(true);
    expect(textOf(changed)).toBe(`[WORDS] Keep the person's words: the card at b19.7 must read "WORK". Keep the person's words: the card at b20.9 must read "SLEEP".`);
    await ws.writeJson("plan/brief.json", { ...file, words: [], verbatim: ["DAWN"] });
    const missing = await call(app, "katana_edit", { project: pinned.project.id, edl });
    expect(textOf(missing)).toBe(`[WORDS] Keep the person's words: "DAWN" must be on a card.`);
    await rm(ws.path("plan", "brief.json"));
  });

  it("leaves a project the app is making alone in chat sessions", async () => {
    const ws = await open(pinned);
    const now = new Date().toISOString();
    const record: RunRecord = {
      v: 1, id: RUN, project: ws.project.id, kind: "template", status: "running", title: "Night Stare", sessionId: "6f1c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6", model: "opus",
      claude: { path: "/usr/local/bin/claude", version: "2.1.302", auth: "subscription", plan: "max" }, caps: { gpuMinutes: 50, claudeUsd: 15 }, planFirst: false,
      overrides: { profiles: {}, commercial: false }, attempts: [], spentUsd: 0, versionsAtStart: 0, warnings: [], createdAt: now, updatedAt: now,
    };
    await mkdir(ws.path("runs", RUN), { recursive: true });
    await writeFile(ws.path("runs", RUN, "run.json"), JSON.stringify(record));
    await writeFile(ws.path("runs", "active"), JSON.stringify({ run: RUN, since: now }));
    try {
      const locked = "[LOCKED] This edit is being made in the open-katana app. Stop it there first.";
      const edl = { canvas: { width: 320, height: 240, fps: 24 }, audio: null, shots: [{ start: 0, end: 1, source: { asset: "s1" } }] };
      for (const [name, args] of [
        ["katana_generate", { project: ws.project.id, approved: true, jobs: [still("chat")] }],
        ["katana_judge", { project: ws.project.id, asset: "street-key_t1", verdict: "accept" }],
        ["katana_edit", { project: ws.project.id, edl }],
        ["katana_render", { project: ws.project.id }],
        ["katana_deliver", { project: ws.project.id }],
        ["katana_cancel", { project: ws.project.id }],
      ] as const) {
        const r = await call(chat, name, args);
        expect(textOf(r), name).toBe(locked);
      }
      // Reading still works, and the app's own director is not locked out of its project.
      expect((await call(chat, "katana_status", { project: ws.project.id })).isError).toBeFalsy();
      expect((await call(app, "katana_judge", { project: ws.project.id, asset: "street-key_t2", verdict: "accept" })).isError).toBeFalsy();
    } finally {
      await rm(ws.path("runs"), { recursive: true, force: true });
    }
    // Once the run is over, chat sessions work on it as before.
    expect((await call(chat, "katana_judge", { project: ws.project.id, asset: "street-key_t2", verdict: "accept" })).isError).toBeFalsy();
  });

  it("finishes the submit in flight on SIGTERM, so the job is in jobs.json before the server exits", async () => {
    const ws = await Workspace.create({ title: "drain", root: root() });
    await approve(ws, 50);
    const { client, transport } = await connect(appEnv(ws.project.id));
    const pid = transport.pid!;
    comfy.state.promptDelayMs = 1500;
    const before = comfy.calls.filter((c) => c.path === "POST /prompt").length;
    const pending = call(client, "katana_generate", { project: ws.project.id, approved: true, jobs: [still("drain", { takes: 2 })] }).catch(() => undefined);
    const deadline = Date.now() + 20_000;
    while (comfy.calls.filter((c) => c.path === "POST /prompt").length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const signalled = Date.now();
    process.kill(pid, "SIGTERM");
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() - signalled < 15_000) await new Promise((r) => setTimeout(r, 25));
    comfy.state.promptDelayMs = 0;
    await pending;
    await client.close().catch(() => undefined);
    expect(alive()).toBe(false);
    // It waited for the slow submit rather than dying with it unrecorded.
    expect(Date.now() - signalled).toBeGreaterThan(1000);
    const jobs = JSON.parse(await readFile(ws.path("plan", "jobs.json"), "utf8")) as JobRecord[];
    expect(jobs.map((j) => [j.line, j.state, Boolean(j.promptId)])).toEqual([["drain", "pending", true]]);
    // The second take was never sent.
    expect(comfy.calls.filter((c) => c.path === "POST /prompt").length).toBe(before + 1);
  }, 60_000);
});
