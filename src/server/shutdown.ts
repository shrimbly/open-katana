import type { McpServer } from "@modelcontextprotocol/server";
import { beginShutdown, inFlightSubmits } from "../comfy/jobs.js";

/** How long a stopping server waits for submits in flight before it exits anyway. */
const DRAIN_MS = 8000;

/**
 * On SIGTERM/SIGINT: stop new submits, wait (at most 8 s) for in-flight ones to reach jobs.json, close the
 * server and exit, so the app's cancel sweep sees every submitted job (spec §10.6). A second signal while
 * draining is ignored; the app's SIGKILL after 10 s is the backstop.
 */
export function installMcpShutdown(server: McpServer): void {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    beginShutdown();
    const deadline = Date.now() + DRAIN_MS;
    while (inFlightSubmits() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await Promise.race([server.close().catch(() => undefined), new Promise((r) => setTimeout(r, 500))]);
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void stop());
}
