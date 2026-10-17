/**
 * The director's command line and MCP config (spec §9.3, §9.4). Pure: no files, no processes.
 * The run is sealed: no built-in tools, no user settings, hooks or plugins, only the 13 katana
 * workflow tools, and anything else is denied rather than prompted.
 */

export const ALLOWED_TOOLS = [
  "katana_guide", "katana_status", "katana_backend", "katana_analyze", "katana_view", "katana_review",
  "katana_plan", "katana_generate", "katana_wait", "katana_judge", "katana_edit", "katana_render", "katana_deliver",
].map((t) => `mcp__open-katana__${t}`);

/** Flags the installed `claude` must offer (checked against `claude --help` by setup). */
export const REQUIRED_FLAGS = [
  "--print", "--output-format", "--verbose", "--model", "--max-budget-usd", "--mcp-config", "--strict-mcp-config",
  "--tools", "--allowedTools", "--permission-mode", "--setting-sources", "--append-system-prompt", "--session-id", "--resume",
];

/** The cheapest attempt worth starting: below this the director cannot do one useful turn. */
export const MIN_BUDGET_USD = 0.5;

export function claudeArgs(o: { sessionId: string; resume: boolean; model: string; maxBudgetUsd: number; mcpConfig: string; systemPrompt: string }): string[] {
  return [
    "-p", // the prompt comes on stdin (prompt-<n>.txt), never in argv
    "--output-format", "stream-json",
    "--verbose",
    "--model", o.model,
    "--max-budget-usd", o.maxBudgetUsd.toFixed(2),
    "--mcp-config", o.mcpConfig,
    "--strict-mcp-config",
    "--tools", "", // no built-in tools: no Bash, Read, Write, Web, Skill
    "--allowedTools", ALLOWED_TOOLS.join(" "),
    "--permission-mode", "dontAsk", // anything not allowlisted is denied, never prompted
    "--setting-sources", "", // no user/project/local settings: no hooks, no user plugins
    "--append-system-prompt", o.systemPrompt,
    ...(o.resume ? ["--resume", o.sessionId] : ["--session-id", o.sessionId]),
  ];
}

/** What is left of the Claude cap for the next attempt: the cap minus what finished attempts cost. */
export function budgetFor(capUsd: number, spentUsd: number): number {
  return Math.max(MIN_BUDGET_USD, Math.round((capUsd - spentUsd) * 100) / 100);
}

/** Run-only profile overrides: `null` restores the default profile for that operation. */
export function profileOverrides(clipsModel: "configured" | "wan22"): Record<string, string | null> {
  return clipsModel === "wan22" ? { "clip.i2v": null, "clip.flf": null } : {};
}

export interface McpConfigInput {
  runId: string;
  project: string;
  home: string;
  overrides: Record<string, string | null>;
  commercial: boolean;
  /** The app's process: the MCP server runs the same build (dist/cli.js, or src/cli.ts under tsx). */
  execPath: string;
  execArgv: string[];
  entry: string;
  env: NodeJS.ProcessEnv;
}

/**
 * mcp.json for one attempt. It never carries a secret: the MCP server reads keys from config.json,
 * so COMFY_CLOUD_API_KEY and COMFYUI_TOKEN stay out even when the app has them.
 */
export function mcpConfig(o: McpConfigInput): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
  const env: Record<string, string> = {
    OPEN_KATANA_HOME: o.home,
    OPEN_KATANA_RUN: o.runId,
    OPEN_KATANA_PROJECT: o.project,
    OPEN_KATANA_APPROVAL: "file",
    OPEN_KATANA_PROFILE_OVERRIDES: JSON.stringify(o.overrides),
    OPEN_KATANA_COMMERCIAL: o.commercial ? "1" : "0",
  };
  for (const key of ["PATH", "HOME", "OPEN_KATANA_BACKEND", "COMFYUI_URL"]) {
    const v = o.env[key];
    if (v) env[key] = v;
  }
  return { mcpServers: { "open-katana": { command: o.execPath, args: [...o.execArgv, o.entry, "mcp"], env } } };
}

/** A copy of `env` without `keys` (the director must not inherit the app-run variables meant for MCP). */
export function withoutKeys(env: NodeJS.ProcessEnv, keys: string[]): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of keys) delete out[k];
  return out;
}
