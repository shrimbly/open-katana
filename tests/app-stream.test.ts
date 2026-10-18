import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateUsd } from "../src/app/runs/pricing.js";
import { attemptEnd, attemptPhaseSec, buildState, buildTakes, COPY, newFacts, reduce, type ReduceContext, seedPhase, type StreamFacts } from "../src/app/runs/reducer.js";
import { LineTailer, parseLine, reportIssues, type StreamEvent } from "../src/app/runs/stream.js";
import { emptySnapshot } from "../src/app/runs/watch.js";
import type { PhaseId, RunKind, RunRecord } from "../src/app/types.js";
import { tempDir } from "./helpers/synth.js";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", "stream", `${name}.jsonl`);

/** Plays a stream file through the reducer, recording each phase change. */
function replay(file: string, kind: RunKind = "decode", sessionId?: string): { facts: StreamFacts; phases: PhaseId[]; sessionId: string; junk: number } {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const init = lines.map((l) => JSON.parse(l) as { type: string; subtype?: string; session_id?: string }).find((d) => d.type === "system" && d.subtype === "init");
  const sid = sessionId ?? init?.session_id ?? "";
  const facts = newFacts(0);
  const ctx: ReduceContext = { sessionId: sid, kind, now: 0 };
  const phases: PhaseId[] = [];
  let junk = 0;
  for (const line of lines) {
    const events = parseLine(line);
    if (!events) {
      junk++;
      continue;
    }
    for (const e of events) {
      reduce(facts, e, ctx);
      if (facts.phase && facts.phase !== phases.at(-1)) phases.push(facts.phase);
    }
  }
  return { facts, phases, sessionId: sid, junk };
}

/** Builds stream lines in the CLI's shapes. */
const S = {
  init: (session = "s-1", over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "system", subtype: "init", session_id: session, tools: ["mcp__open-katana__katana_status", "mcp__open-katana__katana_generate"], mcp_servers: [{ name: "open-katana", status: "connected" }], plugins: [], ...over }),
  say: (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  tool: (id: string, tool: string, input: Record<string, unknown> = {}) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__open-katana__${tool}`, input }] } }),
  error: (id: string, text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] }, tool_use_result: `Error: ${text}` }),
  ok: (id: string, structured: Record<string, unknown> = {}) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(structured) }] }, tool_use_result: { structuredContent: structured } }),
  result: (subtype: string, result = "", cost = 1.25) => JSON.stringify({ type: "result", subtype, is_error: subtype !== "success", total_cost_usd: cost, duration_ms: 9000, num_turns: 12, result }),
};

function play(lines: string[], kind: RunKind = "template"): StreamFacts {
  const facts = newFacts(0);
  const ctx: ReduceContext = { sessionId: "s-1", kind, now: 0 };
  for (const l of lines) for (const e of parseLine(l) ?? []) reduce(facts, e, ctx);
  return facts;
}

const end = (f: StreamFacts, o: Partial<Parameters<typeof attemptEnd>[1]> = {}) => attemptEnd(f, { newVersion: false, stderrTail: "", planWaiting: false, ...o });

describe("recorded director runs", () => {
  it("hype: session, phases, the full study, notes in order, takes from verdicts, the result", () => {
    const { facts, phases, sessionId, junk } = replay(fixture("hype"));
    expect(sessionId).toBe("16fa6cd2-a82e-46cb-b41d-e2bc09b4f476");
    expect(junk).toBe(0);
    expect(facts.initSeen).toBe(true);
    expect(facts.initProblem).toBeUndefined();
    // A katana_edit that failed (slots missing) and a retake that failed to submit go back where they were;
    // retakes after the cut show as that GPU work again.
    expect(phases).toEqual(["setup", "study", "plan", "stills", "clips", "cut", "clips", "cut", "render", "clips", "render", "check", "deliver"]);
    expect(facts.study).toEqual({ page: 17, pages: 17 });
    // Notes keep the stream's order, trimmed, with no report line.
    expect(facts.notes[0]!.text).toBe("Mode: **remix** with the `hype-energy` preset. The reference supplies the music and timing.");
    expect(facts.notes[1]!.text).toBe("Backend is ready on Comfy Cloud. Next I'll look up the preset's slots and analyze the reference.");
    expect(facts.notes.every((n) => n.text.length <= 240 && !n.text.includes("KATANA_REPORT"))).toBe(true);
    // Takes come from the director's verdicts when there is no jobs file.
    const takes = buildTakes("20261017-hype-energy-leather-jacket-hero-a577", facts, emptySnapshot(0));
    expect(takes.length).toBe(facts.judged.size);
    expect(takes.find((t) => t.asset === "k-throne_t1")!.verdict).toMatchObject({ by: "director", verdict: "reject" });
    expect(takes.find((t) => t.asset === "c-spin_t1")!.verdict!.verdict).toBe("accept");
    expect(takes.find((t) => t.asset === "plate_t1")!.thumb).toContain("asset=plate_t1");
    expect(facts.delivered).toMatchObject({ version: 1, sizeMB: 21.43, durationSec: 16.433 });
    expect(facts.result).toMatchObject({ subtype: "success", isError: false, costUsd: 7.6231908 });
    expect(facts.plan).toMatchObject({ fiveHour: expect.any(Number), sevenDay: expect.any(Number) });
    expect(facts.rateLimited).toBeUndefined();
    // It ran with the person's own settings: the app flags that.
    expect(facts.warnings).toContain(COPY.hooks);
    expect(facts.warnings.some((w) => w.startsWith("Your Claude Code plugins loaded in this run"))).toBe(true);
    expect(facts.warnings.some((w) => w.startsWith("Tools outside open-katana") && w.includes("Skill"))).toBe(true);
    expect(end(facts, { newVersion: true })).toMatchObject({ status: "done" });
  });

  it("night and iron: phases in order and a delivered version", () => {
    const night = replay(fixture("night"));
    expect(night.sessionId).toBe("81716607-4578-462a-b5a2-a52a6962644b");
    // Its clip lines were never in a saved plan, so without plan/plan.json they count as stills.
    expect(night.phases).toEqual(["setup", "study", "plan", "stills", "cut", "render", "check", "deliver"]);
    expect(night.facts.result?.costUsd).toBeCloseTo(4.99, 2);
    const iron = replay(fixture("iron"));
    expect(iron.sessionId).toBe("6379b2ed-e678-4875-95b5-87463924f8d2");
    // Its first katana_edit failed (two matte slots missing): the run went back to clips until the real cut.
    expect(iron.phases).toEqual(["setup", "study", "plan", "stills", "clips", "cut", "clips", "cut", "render", "check", "deliver"]);
    expect(iron.facts.delivered?.version).toBe(1);
    expect(iron.facts.study?.page).toBe(iron.facts.study?.pages);
    // A failed submit that is not prefixed only says the director is retrying.
    expect(iron.facts.notes.some((n) => n.text === COPY.retrying)).toBe(true);
    expect(iron.facts.attention).toBeUndefined();
  });

  it("a plan-and-ask session pauses with the question; its resume finishes", () => {
    const one = replay(fixture("phase1"));
    expect(one.phases).toEqual(["setup", "study", "plan"]);
    const asked = end(one.facts);
    expect(asked.status).toBe("paused");
    expect(asked.attention?.code).toBe("QUESTION");
    expect(asked.attention?.question).toMatch(/^The plan is saved\./);
    expect(asked.attention!.question!.length).toBeLessThanOrEqual(1000);
    const two = replay(fixture("phase2"), "decode", one.sessionId);
    expect(two.sessionId).toBe(one.sessionId);
    expect(two.phases.slice(0, 2)).toEqual(["setup", "plan"]);
    expect(two.phases.at(-1)).toBe("deliver");
    expect(end(two.facts, { newVersion: true }).status).toBe("done");
  });

  it("a template run skips the study phase", () => {
    const { facts, phases } = replay(fixture("hype"), "template");
    expect(phases).not.toContain("study");
    expect(facts.study).toBeUndefined();
  });
});

describe("stream rules", () => {
  it("turns each prefixed tool error into its pause, or a note", () => {
    const at = (text: string) => play([S.init(), S.tool("t1", "katana_generate", { lines: ["a"] }), S.error("t1", text), S.result("success", "I need more.")]);
    expect(end(at("[APPROVAL] The person approves spending in the app. Stop now and summarise the plan in two lines."))).toMatchObject({ status: "paused", attention: { code: "NEEDS_APPROVAL" } });
    expect(end(at("[BUDGET] needs=52.0 cap=45 This needs about 52 GPU minutes in total; the person approved 45. Stop now."))).toMatchObject({ status: "paused", attention: { code: "BUDGET_CAP", needsMinutes: 52, capMinutes: 45 } });
    expect(end(at("[OUT_OF_CREDITS] Comfy Cloud refused the job."))).toMatchObject({ status: "paused", attention: { code: "OUT_OF_CREDITS", message: COPY.outOfCredits } });
    const down = end(at("[BACKEND] http://127.0.0.1:8188: fetch failed"));
    expect(down).toMatchObject({ status: "paused", attention: { code: "BACKEND_DOWN" } });
    expect(down.attention!.message).toContain("Lost your GPU at http://127.0.0.1:8188.");
    expect(end(at("[LOCKED] This run only works on project x."))).toMatchObject({ status: "failed", failure: { code: "BLOCKED", resumable: true } });
    expect(end(at("[STOPPED] Stopped in the app."))).toMatchObject({ status: "failed", failure: { code: "BLOCKED", message: "Stopped in the app." } });
    for (const prefix of ["[WORDS] Keep the person's words: the card at b1.28 must read \"NOTHING NEW\".", "[USER_PICK] Use a_t2 instead of a_t1.", "[APP] Not available in app runs."]) {
      const f = at(prefix);
      expect(f.attention).toBeUndefined();
      expect(f.pendingFailure).toBeUndefined();
      expect(f.notes.at(-1)!.text).toBe(prefix.replace(/^\[[A-Z_]+\]\s*/, ""));
    }
    expect(at("comfy run failed: exit 1").notes.some((n) => n.text === COPY.retrying)).toBe(true);
  });

  it("clears a GPU pause once a later generate succeeds", () => {
    const f = play([S.init(), S.tool("t1", "katana_generate"), S.error("t1", "[OUT_OF_CREDITS] none left"), S.tool("t2", "katana_generate"), S.ok("t2", { jobs: [] })]);
    expect(f.attention).toBeUndefined();
  });

  it("reads plan limits: a rejected window pauses until it resets; overageStatus is ignored", () => {
    const allowed = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792204200, overageStatus: "rejected", unifiedWindows: { five_hour: { utilization: 0.41, resetsAt: 1792204200 }, seven_day: { utilization: 0.2, resetsAt: 1792692000 } } } });
    const ok = play([S.init(), allowed]);
    expect(ok.rateLimited).toBeUndefined();
    expect(ok.plan).toEqual({ fiveHour: 0.41, sevenDay: 0.2, resetsAt: new Date(1792204200 * 1000).toISOString() });
    const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792204200, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792204200 } } } });
    const f = play([S.init(), allowed, rejected]);
    expect(f.rateLimited).toEqual({ resetsAt: new Date(1792204200 * 1000).toISOString() });
    expect(end(f, { stderrTail: "usage limit reached", exitCode: 1 })).toMatchObject({ status: "paused", attention: { code: "USAGE_LIMIT", resetsAt: new Date(1792204200 * 1000).toISOString() } });
  });

  it("maps result subtypes: budget used, agent errors, success with and without a version", () => {
    expect(end(play([S.init(), S.result("error_max_budget_usd", "", 15.02)]))).toMatchObject({ status: "paused", attention: { code: "USD_CAP" } });
    expect(end(play([S.init(), S.result("error_max_turns", "Reached the turn limit.")]))).toMatchObject({ status: "failed", failure: { code: "AGENT_ERROR", resumable: true } });
    const report = 'Done: 16.4 s.\nKATANA_REPORT {"issues":["Hands warp briefly in the spin."]}';
    const done = end(play([S.init(), S.say(report), S.result("success", report)]), { newVersion: true });
    expect(done).toMatchObject({ status: "done", issues: ["Hands warp briefly in the spin."] });
    expect(done.report).toBe("Done: 16.4 s.");
    const asked = end(play([S.init(), S.say("No clear face in any photo. Can you add one?"), S.result("success", 'No clear face in any photo. Can you add one?\nKATANA_REPORT {"issues":[]}')]));
    expect(asked).toMatchObject({ status: "paused", attention: { code: "QUESTION", question: "No clear face in any photo. Can you add one?" } });
    expect(end(play([S.init(), S.result("success", "Plan saved.")]), { planWaiting: true })).toMatchObject({ status: "paused", attention: { code: "NEEDS_APPROVAL" } });
    expect(reportIssues("KATANA_REPORT {bad json")).toEqual([]);
  });

  it("fails fast when the open-katana tools did not load", () => {
    const f = play([S.init("s-1", { mcp_servers: [{ name: "open-katana", status: "failed" }], tools: ["Bash"] })]);
    expect(f.initProblem).toBeDefined();
    expect(end(f, { exitCode: 143 })).toMatchObject({ status: "failed", failure: { code: "TOOLS_NOT_LOADED" } });
    expect(play([S.init("s-1", { tools: ["mcp__open-katana__katana_status"] })]).initProblem).toBeDefined();
    expect(play([S.init()]).initProblem).toBeUndefined();
  });

  it("tells a sign-in failure and a crash apart when there is no result", () => {
    expect(end(play([]), { stderrTail: "Invalid API key · Please run /login", exitCode: 1 })).toMatchObject({ status: "failed", failure: { code: "CLAUDE_LOGGED_OUT" } });
    const crash = end(play([S.init(), S.tool("t1", "katana_generate", { jobs: [{ operation: "clip.i2v" }] })]), { exitCode: 1 });
    expect(crash).toMatchObject({ status: "failed", failure: { code: "CRASHED", resumable: true } });
    expect(crash.failure!.message).toBe("Exit code 1 during 'Rolling clips'. Everything made so far is saved.");
  });

  it("warns once when hooks ran", () => {
    const hook = JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart" });
    const f = play([hook, JSON.stringify({ type: "system", subtype: "hook_response" }), S.init()]);
    expect(f.warnings.filter((w) => w === COPY.hooks)).toHaveLength(1);
  });

  it("a new attempt marker resets the attempt's pause and result but keeps the notes", () => {
    const f = play([S.init(), S.say("first"), S.tool("t1", "katana_generate"), S.error("t1", "[OUT_OF_CREDITS] x"), S.result("success", "x"), JSON.stringify({ type: "katana_app", attempt: 2, at: "now" })]);
    expect(f.attempt).toBe(2);
    expect(f.attention).toBeUndefined();
    expect(f.result).toBeUndefined();
    expect(f.notes[0]!.text).toBe("first");
  });

  it("ignores non-JSON lines and drops image data", () => {
    expect(parseLine("not json at all")).toBeNull();
    expect(parseLine("[1,2]")).toBeNull();
    const big = "A".repeat(200_000);
    const events = parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: big } }, { type: "text", text: "Page 1/17" }] }] } })) as StreamEvent[];
    expect(events).toHaveLength(1);
    const ok = events[0] as Extract<StreamEvent, { type: "toolOk" }>;
    expect(ok.text).toBe("Page 1/17");
    expect(JSON.stringify(events)).not.toContain("AAAA");
    const long = parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(10_000) }] } }))![0] as Extract<StreamEvent, { type: "toolOk" }>;
    expect(long.text.length).toBe(4096);
  });

  it("buffers a truncated last line until its newline arrives", async () => {
    const file = join(await tempDir(), "stream.jsonl");
    writeFileSync(file, `${S.init()}\n${S.say("hello").slice(0, 20)}`);
    const t = new LineTailer(file, 0);
    const seen: string[] = [];
    expect(t.read((l) => seen.push(l))).toBe(1);
    appendFileSync(file, `${S.say("hello").slice(20)}\nnot json\n`);
    expect(t.read((l) => seen.push(l), 7)).toBe(2);
    expect(seen.map((l) => parseLine(l)?.[0]?.type ?? null)).toEqual(["init", "say", null]);
    expect(t.read((l) => seen.push(l))).toBe(0);
  });
});

/** A run record for buildState. */
const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  v: 1, id: "r-20261017000000-abcd", project: "20261017-hype-energy-abcd", kind: "template", status: "running", title: "Hype Energy", template: "hype-energy",
  sessionId: "s-1", model: "opus", claude: { path: "claude", version: "2.1.302", auth: "subscription" }, caps: { gpuMinutes: 45, claudeUsd: 15 }, planFirst: false,
  overrides: { profiles: {}, commercial: false }, attempts: [{ n: 1, reason: "start", startedAt: "2026-10-17T10:00:00.000Z", streamOffset: 0, promptFile: "prompt-1.txt" }],
  spentUsd: 0, versionsAtStart: 0, warnings: [], createdAt: "2026-10-17T10:00:00.000Z", updatedAt: "2026-10-17T10:00:00.000Z", ...over,
});
const state = (f: StreamFacts, over: Partial<RunRecord> = {}, ctx: Partial<Parameters<typeof buildState>[3]> = {}) => buildState(record(over), f, emptySnapshot(0), { now: Date.parse("2026-10-17T10:05:00.000Z"), phaseMinutes: {}, ...ctx });

describe("progress follows what happened (live run r-20261017105905-eb90)", () => {
  it("a katana_edit probe that fails before the plan does not jump to the cut", () => {
    const f = play([S.init(), S.tool("t1", "katana_edit", { fromPreset: { slots: {} } }), S.error("t1", "Fill every slot the skeleton uses. Missing: temple."), S.tool("t2", "katana_plan", { plan: { jobs: [] } })]);
    expect(f.phase).toBe("plan");
    const s = state(f);
    expect(s.headline).toBe("PLANNING SHOTS");
    expect(s.phases.find((p) => p.id === "cut")!.state).toBe("todo");
    expect(s.pct).toBeLessThan(20);
  });

  it("comparing a keyframe with the subject photo is judging, not the final check", () => {
    const f = play([S.init(), S.tool("t1", "katana_generate", { jobs: [{ operation: "still.compose" }] }), S.ok("t1"), S.tool("t2", "katana_view", { target: "compare", asset: "top-down_t1" }), S.ok("t2")]);
    expect(f.phase).toBe("stills");
    expect(state(f).headline).toBe("SHOOTING STILLS");
    // A view of the render is the check.
    const g = play([S.init(), S.tool("t0", "katana_generate", { jobs: [{ operation: "clip.i2v" }] }), S.ok("t0"), S.tool("t1", "katana_render", { preview: true }), S.ok("t1"), S.tool("t2", "katana_view", { target: "render-pages", pages: [1] }), S.ok("t2")]);
    expect(g.phase).toBe("check");
  });

  it("a placeholder cut and draft render before any generation is still planning (live run r-20261017164857-9cea)", () => {
    const f = play([
      S.init(), S.tool("t1", "katana_status"), S.ok("t1"),
      S.tool("t2", "katana_edit", { fromPreset: { slots: { walkout: "s1" } } }), S.ok("t2"),
      S.tool("t3", "katana_render", { preview: true }), S.ok("t3"),
      S.tool("t4", "katana_view", { target: "render-pages", pages: [1] }), S.ok("t4"),
    ]);
    expect(f.phase).toBe("plan");
    const s = state(f);
    expect(s.headline).toBe("PLANNING SHOTS");
    expect(s.pct).toBeLessThan(20);
    // Once it generates, the real cut and render move the run on.
    const g = play([S.init(), S.tool("t1", "katana_edit"), S.ok("t1"), S.tool("t2", "katana_generate", { jobs: [{ operation: "still.compose" }] }), S.ok("t2"), S.tool("t3", "katana_edit"), S.ok("t3")]);
    expect(g.phase).toBe("cut");
  });

  it("a failed render or delivery goes back to where the run was; a retake after the cut is that work again", () => {
    const gen = [S.tool("t0", "katana_generate", { jobs: [{ operation: "clip.i2v" }] }), S.ok("t0")];
    const f = play([S.init(), ...gen, S.tool("t1", "katana_edit"), S.ok("t1"), S.tool("t2", "katana_render", { preview: true }), S.error("t2", 'No asset "ref" in project x.')]);
    expect(f.phase).toBe("cut");
    const g = play([S.init(), ...gen, S.tool("t1", "katana_render", { preview: false }), S.ok("t1"), S.tool("t2", "katana_deliver"), S.error("t2", "No final render yet.")]);
    expect(g.phase).toBe("render");
    expect(state(g).headline).toBe("RENDERING");
    const h = play([S.init(), S.tool("t1", "katana_edit"), S.ok("t1"), S.tool("t2", "katana_generate", { jobs: [{ operation: "clip.i2v" }] }), S.ok("t2")]);
    expect(h.phase).toBe("clips");
  });

  it("the ETA in the deliver phase is what is left, not the whole run", () => {
    const f = play([S.init(), S.tool("t1", "katana_deliver")]);
    const s = state(f);
    expect(s.phase).toBe("deliver");
    expect(s.etaMin).toEqual([1, 1]);
  });

  it("a continued attempt starts from what the files hold", () => {
    const f = newFacts(0);
    const ctx: ReduceContext = { sessionId: "s-1", kind: "template", now: 1000 };
    reduce(f, { type: "attempt", attempt: 2 }, ctx);
    const files = emptySnapshot(0);
    seedPhase(f, files, ctx);
    expect(f.phase).toBeUndefined();
    files.estimate = { totalMinutes: 3, jobs: [] };
    seedPhase(f, files, ctx);
    expect(f.phase).toBe("plan");
    files.edl = { canvas: { width: 1080, height: 1920, fps: 60 }, shots: [], text: [], flashes: [], sfx: [] } as unknown as typeof files.edl;
    seedPhase(f, files, ctx);
    expect(f.phase).toBe("cut");
  });

  it("phase times come from the lines' own timestamps and add up per phase", () => {
    const at = (iso: string, line: string) => JSON.stringify({ ...JSON.parse(line), timestamp: iso });
    const lines = [
      at("2026-10-17T10:00:00.000Z", S.init()),
      at("2026-10-17T10:00:05.000Z", S.say("Planning.")),
      at("2026-10-17T10:00:05.000Z", S.tool("t1", "katana_plan", { plan: { jobs: [] } })),
      at("2026-10-17T10:01:05.000Z", S.tool("t2", "katana_generate", { jobs: [{ operation: "still.compose" }] })),
    ];
    // Read long after (as after a server restart): the times are the lines', not the read's.
    const facts = newFacts(0);
    const ctx: ReduceContext = { sessionId: "s-1", kind: "template", now: Date.parse("2026-10-18T09:00:00.000Z") };
    for (const l of lines) for (const e of parseLine(l) ?? []) reduce(facts, e, ctx);
    expect(facts.notes[0]!.at).toBe("2026-10-17T10:00:05.000Z");
    expect(attemptPhaseSec(facts, Date.parse("2026-10-17T10:02:05.000Z"))).toEqual({ setup: 5, plan: 60, stills: 60 });
  });
});

describe("the sealed run and how attempts end", () => {
  it("does not flag the plugins Claude Code always loads", () => {
    const builtin = [{ name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" }, { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" }];
    expect(play([S.init("s-1", { plugins: builtin })]).warnings.some((w) => w.includes("plugins"))).toBe(false);
    const mine = play([S.init("s-1", { plugins: [...builtin, { name: "figma", path: "/HOME/.claude/plugins/figma", source: "figma@claude-plugins-official" }] })]);
    expect(mine.warnings).toContain("Your Claude Code plugins loaded in this run: figma.");
  });

  it("a usage limit that ends with a result pauses until the reset; a dead sign-in fails as signed out", () => {
    const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792204200 } });
    const limit = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 429, api_error: "usage_limit_reached", total_cost_usd: 0.4, result: "You've hit your limit · resets 5:30pm" });
    expect(end(play([S.init(), rejected, limit]))).toMatchObject({ status: "paused", attention: { code: "USAGE_LIMIT", resetsAt: new Date(1792204200 * 1000).toISOString() } });
    expect(end(play([S.init(), limit]))).toMatchObject({ status: "paused", attention: { code: "USAGE_LIMIT" } });
    const signedOut = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Invalid API key · Please run /login" });
    expect(end(play([S.init(), signedOut]))).toMatchObject({ status: "failed", failure: { code: "CLAUDE_LOGGED_OUT" } });
    const revoked = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error: "invalid_credential_header", result: "Credentials are no longer valid." });
    expect(end(play([S.init(), revoked]))).toMatchObject({ status: "failed", failure: { code: "CLAUDE_LOGGED_OUT" } });
    // Any other API error is still the director's error.
    const other = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 500, result: "Overloaded" });
    expect(end(play([S.init(), other]))).toMatchObject({ status: "failed", failure: { code: "AGENT_ERROR" } });
  });

  it("counts each message's tokens once, at list prices, for an attempt without a result", () => {
    // The live run's first attempt: the CLI's own total was $1.3530436 for these tokens on Claude Opus 5.5.
    const usage = { input_tokens: 56, output_tokens: 13712, cache_read_input_tokens: 1524858, cache_creation_input_tokens: 96701, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 96701 } };
    const msg = (id: string, text: string) => JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5-5", content: [{ type: "text", text }], usage } });
    const f = play([S.init(), msg("msg_1", "one block"), msg("msg_1", "same message, second block")]);
    expect(f.usage.size).toBe(1);
    expect(estimateUsd(f.usage.values(), f.model)).toBeCloseTo(1.3530436, 6);
    // A model the table doesn't know is priced at the dearest family, so the estimate errs high.
    expect(estimateUsd([{ model: "claude-future-9", usage: { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }])).toBe(15);
  });

  it("a queued run with nothing ahead of it says it is starting, not waiting", () => {
    const f = newFacts(0);
    expect(state(f, { status: "queued" })).toMatchObject({ headline: "GETTING READY", detail: "Starting…" });
    expect(state(f, { status: "queued" }, { waitingFor: "Iron Mindset" })).toMatchObject({ headline: "UP NEXT", detail: "Starts when Iron Mindset finishes." });
  });
});
