#!/usr/bin/env node
// A stand-in for the `claude` CLI in tests (spec §14.1). It answers --version, --help and
// `auth status --json`; in -p mode it records its argv and stdin to fake-calls.jsonl in its cwd (the
// run directory), then plays a scenario: stream lines, project-file writes, jobs, sleeps and exits.
//
// FAKE_CLAUDE_SCENARIO  a scenario name (tests/fixtures/scenarios/<name>.json), a path, or inline JSON
// FAKE_CLAUDE_SPEED     divides every sleep (default 1)
// FAKE_CLAUDE_DRAIN_MS  how long SIGTERM takes to exit (default 50)
// FAKE_CLAUDE_AUTH      "out" reports a signed-out CLI
//
// A scenario is a list of steps, or { "attempts": [[...], [...]] } with one list per attempt (the last
// list repeats). Strings "$SESSION", "$PROJECT" and "$BACKEND" are replaced in every step.
//
// Like the real CLI, a result's total_cost_usd is the session's total: on --resume it includes what earlier
// attempts of the session cost (a step's total_cost_usd is that attempt's own spend).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const out = (s) => process.stdout.write(s);

if (args.includes("--version") || args.includes("-v")) {
  out("2.1.302 (Claude Code)\n");
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  out(`Usage: claude [options] [command] [prompt]

Options:
  --allowedTools, --allowed-tools <tools...>  Comma or space-separated list of tool names to allow
  --append-system-prompt <prompt>             Append a system prompt to the default system prompt
  --max-budget-usd <amount>                   Maximum dollar amount to spend on API calls (only works with --print)
  --mcp-config <configs...>                   Load MCP servers from JSON files or strings (space-separated)
  --model <model>                             Model for the current session
  --output-format <format>                    Output format (choices: "text", "json", "stream-json")
  --permission-mode <mode>                    Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  -p, --print                                 Print response and exit
  -r, --resume [value]                        Resume a conversation by session ID
  --session-id <uuid>                         Use a specific session ID for the conversation
  --setting-sources <sources>                 Comma-separated list of setting sources to load (user, project, local)
  --strict-mcp-config                         Only use MCP servers from --mcp-config
  --tools <tools...>                          Specify the list of available tools from the built-in set
  --verbose                                   Override verbose mode setting from config
  -v, --version                               Output the version number
`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  const signedOut = process.env.FAKE_CLAUDE_AUTH === "out";
  out(`${JSON.stringify(signedOut ? { loggedIn: false, authMethod: "none" } : { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "person@example.com", orgId: "org-1" })}\n`);
  process.exit(signedOut ? 1 : 0);
}

if (!args.includes("-p") && !args.includes("--print")) {
  process.stderr.write("fake-claude: only -p mode is supported\n");
  process.exit(2);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const session = flag("--session-id") ?? flag("--resume") ?? "";
const mcp = flag("--mcp-config");
const mcpEnv = mcp && existsSync(mcp) ? (JSON.parse(readFileSync(mcp, "utf8")).mcpServers?.["open-katana"]?.env ?? {}) : {};
const project = mcpEnv.OPEN_KATANA_PROJECT ?? "";
const home = mcpEnv.OPEN_KATANA_HOME ?? process.env.OPEN_KATANA_HOME ?? "";
const projectDir = resolve(process.cwd(), "..", "..");
let backend = "";
try {
  backend = (JSON.parse(readFileSync(join(home, "config.json"), "utf8")).backend?.url ?? "").replace(/\/+$/, "");
} catch {
  // no config
}

const drain = Number(process.env.FAKE_CLAUDE_DRAIN_MS ?? 50);
process.on("SIGTERM", () => setTimeout(() => process.exit(143), drain));

const speed = Number(process.env.FAKE_CLAUDE_SPEED ?? 1) || 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));

const stdin = await new Promise((done) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (text += c));
  process.stdin.on("end", () => done(text));
  process.stdin.on("error", () => done(text));
});

const calls = join(process.cwd(), "fake-calls.jsonl");
const attempt = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length + 1 : 1;
appendFileSync(calls, `${JSON.stringify({ attempt, argv: args, stdin, pid: process.pid, at: new Date().toISOString(), envKeys: Object.keys(process.env).filter((k) => k.startsWith("OPEN_KATANA_") || k.startsWith("COMFY")) })}\n`);

function loadScenario() {
  const s = process.env.FAKE_CLAUDE_SCENARIO ?? "template-success";
  if (/^\s*[[{]/.test(s)) return JSON.parse(s);
  const file = existsSync(s) ? s : join(here, "scenarios", `${s}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}
const scenario = loadScenario();
const lists = Array.isArray(scenario) ? [scenario] : scenario.attempts;
const steps = lists[Math.min(attempt, lists.length) - 1];

const fill = (v) => {
  if (typeof v === "string") return v.replaceAll("$SESSION", session).replaceAll("$PROJECT", project).replaceAll("$BACKEND", backend);
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
};
const emit = (obj) => out(`${JSON.stringify(obj)}\n`);
const file = (rel) => join(projectDir, rel);
const readJson = (rel, fallback) => {
  try {
    return JSON.parse(readFileSync(file(rel), "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (rel, data) => {
  mkdirSync(dirname(file(rel)), { recursive: true });
  writeFileSync(file(rel), JSON.stringify(data, null, 2));
};

const KATANA = ["guide", "status", "backend", "analyze", "view", "review", "plan", "generate", "wait", "judge", "edit", "render", "deliver"].map((t) => `mcp__open-katana__katana_${t}`);
let toolN = 0;
let lastTool = "";

for (const raw of steps) {
  const step = fill(raw);
  if (step.init !== undefined) {
    const broken = step.init === "no-katana";
    emit({
      type: "system",
      subtype: "init",
      session_id: session,
      cwd: process.cwd(),
      tools: broken ? ["Bash", "Read"] : KATANA,
      mcp_servers: broken ? [{ name: "open-katana", status: "failed" }] : [{ name: "open-katana", status: "connected" }],
      model: "claude-opus-5-5",
      permissionMode: "dontAsk",
      plugins: step.plugins ?? [],
      ...(step.extra ?? {}),
    });
  } else if (step.emit) emit(step.emit);
  else if (step.say !== undefined) emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: step.say }] }, session_id: session });
  else if (step.tool) {
    lastTool = step.id ?? `toolu_${++toolN}`;
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: lastTool, name: `mcp__open-katana__${step.tool}`, input: step.input ?? {} }] }, session_id: session });
  } else if (step.ok !== undefined) {
    const text = step.text ?? JSON.stringify(step.ok);
    emit({ type: "user", message: { role: "user", content: [{ tool_use_id: lastTool, type: "tool_result", content: text }] }, tool_use_result: { content: [{ type: "text", text }], structuredContent: step.ok }, session_id: session });
  } else if (step.error !== undefined) {
    emit({ type: "user", message: { role: "user", content: [{ tool_use_id: lastTool, type: "tool_result", content: step.error, is_error: true }] }, tool_use_result: `Error: ${step.error}`, session_id: session });
  } else if (step.rateLimit) emit({ type: "rate_limit_event", rate_limit_info: step.rateLimit, session_id: session });
  else if (step.heartbeat) emit({ type: "tool_progress", tool_use_id: `${lastTool}-heartbeat`, tool_name: "mcp__open-katana__katana_wait", elapsed_time_seconds: step.heartbeat, heartbeat: true, session_id: session });
  else if (step.result) {
    const r = typeof step.result === "string" ? { subtype: step.result } : step.result;
    const ledgerFile = join(process.cwd(), "fake-session-cost.json");
    const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : {};
    const total = (args.includes("--resume") ? (ledger[session] ?? 0) : 0) + (r.total_cost_usd ?? 0);
    ledger[session] = total;
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    emit({
      type: "result",
      subtype: r.subtype ?? "success",
      is_error: r.is_error ?? r.subtype !== "success",
      total_cost_usd: +total.toFixed(6),
      duration_ms: r.duration_ms ?? 1000,
      num_turns: r.num_turns ?? 1,
      result: r.result ?? "",
      ...(r.api_error ? { api_error: r.api_error } : {}),
      ...(r.api_error_status !== undefined ? { api_error_status: r.api_error_status } : {}),
      session_id: session,
    });
  } else if (step.write) {
    if (step.json !== undefined) writeJson(step.write, step.json);
    else {
      mkdirSync(dirname(file(step.write)), { recursive: true });
      writeFileSync(file(step.write), step.text ?? "");
    }
  } else if (step.appendJob) {
    const j = step.appendJob;
    const jobs = readJson("plan/jobs.json", []);
    const take = j.take ?? jobs.filter((x) => x.line === j.line).length + 1;
    jobs.push({
      id: j.id ?? `${j.line}_t${take}`,
      line: j.line,
      take,
      spec: { line: j.line, operation: j.operation ?? "still.compose", prompt: "fake", takes: 1, ...(j.durationSec ? { durationSec: j.durationSec } : {}) },
      profile: j.profile ?? "qwen21-edit",
      backend: j.backend ?? backend,
      ...(j.promptId ? { promptId: j.promptId } : {}),
      state: j.state ?? "pending",
      seed: 1,
      width: 512,
      height: 896,
      estimateSec: j.estimateSec ?? 30,
      submittedAt: new Date().toISOString(),
      ...(j.state === "completed" ? { finishedAt: new Date().toISOString() } : {}),
      outputs: j.outputs ?? [],
    });
    writeJson("plan/jobs.json", jobs);
  } else if (step.updateJob) {
    const jobs = readJson("plan/jobs.json", []);
    const job = jobs.find((x) => x.id === step.updateJob.id);
    if (job) Object.assign(job, step.updateJob, step.updateJob.state === "completed" ? { finishedAt: new Date().toISOString() } : {});
    writeJson("plan/jobs.json", jobs);
  } else if (step.addVersion) {
    const p = readJson("project.json", undefined);
    if (p) {
      const version = p.versions.length + 1;
      const slug = (p.title ?? "edit").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "edit";
      const rel = `deliver/${slug}_v${version}.mp4`;
      mkdirSync(dirname(file(rel)), { recursive: true });
      const src = process.env.FAKE_CLAUDE_VIDEO;
      writeFileSync(file(rel), src && existsSync(src) ? readFileSync(src) : Buffer.alloc(2048));
      p.versions.push({ version, path: rel, createdAt: new Date().toISOString(), ...(step.addVersion.note ? { note: step.addVersion.note } : {}) });
      p.updatedAt = new Date().toISOString();
      writeJson("project.json", p);
    }
  } else if (step.stderr) process.stderr.write(`${step.stderr}\n`);
  else if (step.sleep) await sleep(step.sleep);
  else if (step.hang) await new Promise(() => setInterval(() => undefined, 1 << 30));
  else if (step.crash) {
    process.stderr.write("fake-claude: something broke\n");
    process.exit(1);
  } else if (step.exit !== undefined) process.exit(step.exit);
}
process.exit(0);
