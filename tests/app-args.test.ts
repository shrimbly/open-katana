import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, budgetFor, claudeArgs, mcpConfig, profileOverrides, withoutKeys } from "../src/app/runs/args.js";
import { writeMcpConfig } from "../src/app/runs/spawn.js";
import { missingFlags } from "../src/app/setup.js";
import { tempDir } from "./helpers/synth.js";

const base = { sessionId: "6f1f6c3e-6d0a-4c43-9c43-2b6b1f6c3e6d", resume: false, model: "opus", maxBudgetUsd: 15, mcpConfig: "/runs/r/mcp.json", systemPrompt: "SYSTEM" };
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("the director's command line", () => {
  it("seals the run: every safety flag, no built-in tools, only the katana allowlist", () => {
    const args = claudeArgs(base);
    expect(args[0]).toBe("-p");
    expect(value(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(value(args, "--model")).toBe("opus");
    expect(value(args, "--mcp-config")).toBe("/runs/r/mcp.json");
    expect(args).toContain("--strict-mcp-config");
    expect(value(args, "--tools")).toBe("");
    expect(value(args, "--permission-mode")).toBe("dontAsk");
    expect(value(args, "--setting-sources")).toBe("");
    expect(value(args, "--append-system-prompt")).toBe("SYSTEM");
    const allowed = value(args, "--allowedTools")!.split(" ");
    expect(allowed).toEqual(ALLOWED_TOOLS);
    expect(allowed).toHaveLength(14);
    expect(allowed.every((t) => t.startsWith("mcp__open-katana__katana_"))).toBe(true);
    for (const banned of ["katana_start", "katana_import", "katana_studio", "katana_presets", "katana_preset_save", "katana_upload", "katana_cancel"]) expect(allowed).not.toContain(`mcp__open-katana__${banned}`);
  });

  it("never carries the prompt: it comes on stdin", () => {
    const prompt = "Make the open-katana edit for project 20261017-hype-energy-a1b2.";
    const args = claudeArgs(base);
    expect(args.some((a) => a.includes("Make the open-katana edit"))).toBe(false);
    expect(args.join("\n")).not.toContain(prompt);
    // Every flag that takes a value has one; nothing trails as a positional prompt.
    expect(args.at(-2)).toBe("--session-id");
  });

  it("resumes the same session with --resume instead of --session-id", () => {
    const first = claudeArgs(base);
    const again = claudeArgs({ ...base, resume: true });
    expect(value(first, "--session-id")).toBe(base.sessionId);
    expect(first).not.toContain("--resume");
    expect(value(again, "--resume")).toBe(base.sessionId);
    expect(again).not.toContain("--session-id");
  });

  it("budgets each attempt with what is left of the cap, never below $0.50", () => {
    expect(budgetFor(15, 0)).toBe(15);
    expect(budgetFor(15, 5.12)).toBe(9.88);
    expect(budgetFor(15, 14.8)).toBe(0.5);
    expect(budgetFor(15, 20)).toBe(0.5);
    expect(value(claudeArgs({ ...base, maxBudgetUsd: budgetFor(15, 5.12) }), "--max-budget-usd")).toBe("9.88");
  });

  it("lists every flag it needs, so setup can tell an old CLI", () => {
    const help = "-p, --print --output-format --verbose --model --max-budget-usd --mcp-config --strict-mcp-config --tools --allowedTools, --allowed-tools --permission-mode (choices: dontAsk) --setting-sources --append-system-prompt --session-id -r, --resume";
    expect(missingFlags(help)).toEqual([]);
    expect(missingFlags(help.replace("--max-budget-usd", "").replace("dontAsk", "plan"))).toEqual(["--max-budget-usd", '--permission-mode "dontAsk"']);
  });
});

describe("mcp.json", () => {
  const input = (env: NodeJS.ProcessEnv) => ({
    runId: "r-20261017101500-a1b2",
    project: "20261017-hype-energy-a1b2",
    home: "/home/.open-katana",
    overrides: profileOverrides("wan22"),
    commercial: false,
    execPath: "/usr/bin/node",
    execArgv: ["--import", "tsx"],
    entry: "/app/src/cli.ts",
    env,
  });

  it("starts this same build in app-run mode, pinned to the run and project", () => {
    const cfg = mcpConfig(input({ PATH: "/usr/bin", HOME: "/home" }));
    const server = cfg.mcpServers["open-katana"]!;
    expect(server.command).toBe("/usr/bin/node");
    expect(server.args).toEqual(["--import", "tsx", "/app/src/cli.ts", "mcp"]);
    expect(server.env).toMatchObject({
      OPEN_KATANA_HOME: "/home/.open-katana",
      OPEN_KATANA_RUN: "r-20261017101500-a1b2",
      OPEN_KATANA_PROJECT: "20261017-hype-energy-a1b2",
      OPEN_KATANA_APPROVAL: "file",
      OPEN_KATANA_COMMERCIAL: "0",
      PATH: "/usr/bin",
      HOME: "/home",
    });
    expect(JSON.parse(server.env.OPEN_KATANA_PROFILE_OVERRIDES!)).toEqual({ "clip.i2v": null, "clip.flf": null });
    expect(JSON.parse(mcpConfig({ ...input({}), overrides: profileOverrides("configured") }).mcpServers["open-katana"]!.env.OPEN_KATANA_PROFILE_OVERRIDES!)).toEqual({});
  });

  it("never writes a secret, even when the app has one, and is readable by its owner only", async () => {
    const env = { PATH: "/usr/bin", HOME: "/home", COMFY_CLOUD_API_KEY: "comfyui-secret-key-123", COMFYUI_TOKEN: "token-secret-456", COMFYUI_URL: "http://127.0.0.1:8188", OPEN_KATANA_BACKEND: "http" };
    const file = join(await tempDir(), "mcp.json");
    await writeMcpConfig(file, input(env));
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("COMFY_CLOUD_API_KEY");
    expect(text).not.toContain("COMFYUI_TOKEN");
    expect(text).not.toContain("comfyui-secret-key-123");
    expect(text).not.toContain("token-secret-456");
    expect(JSON.parse(text).mcpServers["open-katana"].env).toMatchObject({ COMFYUI_URL: "http://127.0.0.1:8188", OPEN_KATANA_BACKEND: "http" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the app-run variables out of the director's own environment", () => {
    const env = withoutKeys({ OPEN_KATANA_RUN: "r", OPEN_KATANA_PROJECT: "p", OPEN_KATANA_APPROVAL: "file", PATH: "/bin" }, ["OPEN_KATANA_RUN", "OPEN_KATANA_PROJECT", "OPEN_KATANA_APPROVAL"]);
    expect(env).toEqual({ PATH: "/bin" });
  });
});
