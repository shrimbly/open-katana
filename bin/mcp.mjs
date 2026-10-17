#!/usr/bin/env node
// Starts the open-katana MCP server from wherever this plugin lives:
// a built checkout (dist/) or a development checkout (src/ via tsx).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist", "cli.js");
const source = join(root, "src", "cli.ts");
const tsx = join(root, "node_modules", "tsx", "dist", "loader.mjs");

let args;
if (existsSync(built)) args = [built, "mcp"];
else if (existsSync(source) && existsSync(tsx)) args = ["--import", "tsx", source, "mcp"];
else {
  // open-katana is not on npm, so a fresh clone (or plugin install) has to be installed and built in place.
  process.stderr.write(
    `open-katana: the MCP server is not built yet (no ${built}).\n` +
      `Run this once in the plugin directory, then restart your MCP client:\n\n` +
      `  cd ${JSON.stringify(root)} && pnpm install && pnpm build\n`,
  );
  process.exit(1);
}
const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
