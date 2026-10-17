#!/usr/bin/env node
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createBackend } from "./comfy/backend.js";
import { PROFILES } from "./comfy/operations.js";
import { checkProfile } from "./comfy/resolve.js";
import { effectiveBackend, loadConfig } from "./config.js";
import { analyzeReference } from "./engine/analyze.js";
import { createServer, VERSION } from "./server/server.js";

const HELP = `open-katana ${VERSION}

Usage:
  open-katana mcp                      Run the MCP server on stdio (for Claude Code / Claude Desktop)
  open-katana analyze <video> [dir]    Analyze a reference edit and write sheets + JSON to dir
  open-katana backend                  Check the configured ComfyUI and which profiles can run
  open-katana studio [project] [--port N] [--no-open]
                                       Open the timeline editor in your browser (--no-open only prints its URL)
  open-katana --version

Environment:
  OPEN_KATANA_BACKEND   http | cloud | comfy-cli      (default: http, or cloud when COMFY_CLOUD_API_KEY is set)
  COMFYUI_URL           ComfyUI address for http       (default http://127.0.0.1:8188)
  COMFYUI_TOKEN         Bearer token for a protected remote ComfyUI
  COMFY_CLOUD_API_KEY   Comfy Cloud API key (platform.comfy.org)
  OPEN_KATANA_HOME      Data directory                 (default ~/.open-katana)
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "mcp": {
      const server = createServer();
      await server.connect(new StdioServerTransport());
      return;
    }
    case "analyze": {
      const [video, dir] = rest;
      if (!video) throw new Error("analyze needs a video path");
      const out = resolve(dir ?? "katana-analysis");
      const r = await analyzeReference(resolve(video), out, { seed: "cli" });
      process.stdout.write(
        `${JSON.stringify({ out, format: r.breakdown.format, shots: r.breakdown.shots.length, flashes: r.breakdown.flashes.length, tempo: r.audio?.tempoBpm, energy: r.energy.summary, pages: r.pages.length }, null, 2)}\n`,
      );
      return;
    }
    case "backend": {
      const backend = createBackend(effectiveBackend(await loadConfig()));
      const check = await backend.check();
      process.stdout.write(`${backend.target}: ${check.ok ? "ok" : "unavailable"} — ${check.detail}\n`);
      if (!check.ok) process.exitCode = 1;
      const catalog = check.ok ? await backend.catalog().catch(() => undefined) : undefined;
      if (catalog) {
        for (const p of PROFILES) {
          const a = checkProfile(p, catalog);
          process.stdout.write(`  ${a.runnable ? "ready  " : "missing"} ${p.id.padEnd(24)} ${a.missingModels.join(", ")}\n`);
        }
      }
      return;
    }
    case "studio": {
      const { sharedStudio } = await import("./studio/server.js");
      const portIdx = rest.indexOf("--port");
      const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : 4310;
      const project = rest.find((r, i) => !r.startsWith("--") && rest[i - 1] !== "--port");
      const studio = await sharedStudio(port);
      const url = studio.url(project);
      process.stdout.write(`open-katana studio: ${url}\n`);
      if (!rest.includes("--no-open")) {
        const { spawn } = await import("node:child_process");
        spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
      }
      await new Promise(() => undefined);
      return;
    }
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stdout.write(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  process.stderr.write(`open-katana: ${e.message}\n`);
  process.exit(1);
});
