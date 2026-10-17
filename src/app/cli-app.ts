import { spawn } from "node:child_process";
import { VERSION } from "../server/server.js";
import { appInfoAt, STUDIO_PORT, Studio } from "../studio/server.js";
import { isId } from "./http.js";
import { isAlive, liveAppLock } from "./lock.js";
import type { RunSummary } from "./types.js";

// `open-katana app`, `open-katana studio` and `open-katana runs` (spec §3.1).

const out = (text: string) => process.stdout.write(`${text}\n`);

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

interface LaunchFlags {
  port: number;
  open: boolean;
  replace: boolean;
  rest: string[];
}

function parseFlags(args: string[]): LaunchFlags {
  const flags: LaunchFlags = { port: STUDIO_PORT, open: true, replace: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--port") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("--port needs a port number");
      flags.port = n;
    } else if (a === "--no-open") flags.open = false;
    else if (a === "--replace") flags.replace = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else flags.rest.push(a);
  }
  return flags;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the app at `path`: reuses the running app when it is this version, stops it first with --replace,
 * or starts this process as the app (it holds the app lock until it exits).
 */
async function launch(flags: LaunchFlags, path: string): Promise<void> {
  const owner = await liveAppLock();
  if (owner) {
    const info = await appInfoAt(owner.port);
    const same = info?.version === VERSION && ["app", "runs"].every((f) => info.features.includes(f));
    if (same && !flags.replace) {
      const url = `http://127.0.0.1:${owner.port}${path}`;
      out(`open-katana: ${url}`);
      if (flags.open) openBrowser(url);
      return;
    }
    if (!flags.replace) {
      out(
        `An open-katana app v${info?.version ?? owner.version} is already running (pid ${owner.pid}, port ${owner.port}). Run "open-katana app --replace" to restart it with v${VERSION}. Edits being made keep going.`,
      );
      process.exitCode = 1;
      return;
    }
    out(`Restarting the open-katana app (pid ${owner.pid}). Edits being made keep going.`);
    try {
      process.kill(owner.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let waited = 0; waited < 10_000 && isAlive(owner.pid) && (await liveAppLock())?.pid === owner.pid; waited += 200) await sleep(200);
    if ((await liveAppLock())?.pid === owner.pid) throw new Error(`The running app (pid ${owner.pid}) didn't stop within 10 s.`);
  }

  const studio = new Studio();
  await studio.start(flags.port, { appOwner: true });
  if (!studio.owner) {
    // Another app took the lock between the check and the start: use that one.
    await studio.stop();
    const lock = await liveAppLock();
    if (!lock) throw new Error("Couldn't take the app lock.");
    const url = `http://127.0.0.1:${lock.port}${path}`;
    out(`open-katana: ${url}`);
    if (flags.open) openBrowser(url);
    return;
  }
  if (flags.port && studio.port !== flags.port) out(`Port ${flags.port} is busy, so open-katana is on port ${studio.port}.`);
  const url = `http://127.0.0.1:${studio.port}${path}`;
  out(`open-katana: ${url}`);
  if (flags.open) openBrowser(url);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const active = studio.activeRuns();
    await studio.stop().catch(() => undefined);
    if (active.length === 1) {
      out(`1 edit is still being made. Reopen with "open-katana app", or stop it with "open-katana runs cancel ${active[0]!.id}".`);
    } else if (active.length > 1) {
      out(`${active.length} edits are still being made. Reopen with "open-katana app", or stop one with "open-katana runs cancel <runId>":`);
      for (const r of active) out(`  ${r.id}  ${r.title}`);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise(() => undefined);
}

/** `open-katana app [--port N] [--no-open] [--replace]` */
export async function appCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if (flags.rest.length) throw new Error(`Unexpected argument ${flags.rest[0]}`);
  await launch(flags, "/");
}

/** `open-katana studio [project] [--port N] [--no-open] [--replace]`: the same app, opened on the editor. */
export async function studioCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const [project, extra] = flags.rest;
  if (extra) throw new Error(`Unexpected argument ${extra}`);
  if (project && !isId("project", project)) throw new Error(`"${project}" isn't a project id. Run "open-katana runs list" or open the app to find it.`);
  await launch(flags, project ? `/edit/${encodeURIComponent(project)}` : "/edits");
}

/** Calls the running app's API (as its own page would) and returns the parsed body. */
async function ownerApi<T>(method: "GET" | "POST", path: string): Promise<T> {
  const owner = await liveAppLock();
  if (!owner) throw new Error('The open-katana app isn\'t running. Start it with "open-katana app".');
  const res = await fetch(`http://127.0.0.1:${owner.port}${path}`, { method, headers: method === "GET" ? {} : { "x-katana": "1", "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function describe(r: RunSummary): string {
  const why = r.attention ?? r.failure;
  return `${r.id}  ${r.status.padEnd(11)} ${String(Math.round(r.pct)).padStart(3)}%  ${r.title}${r.headline ? ` · ${r.headline}` : ""}${why ? ` (${why})` : ""}`;
}

/** `open-katana runs list` · `open-katana runs cancel <runId>` */
export async function runsCommand(args: string[]): Promise<void> {
  const [sub, rid, extra] = args;
  if (sub === "list" && !rid) {
    const { runs } = await ownerApi<{ runs: RunSummary[] }>("GET", "/api/runs");
    if (!runs.length) return void out("No edits.");
    for (const r of runs) out(describe(r));
    return;
  }
  if (sub === "cancel" && rid && !extra) {
    if (!isId("run", rid)) throw new Error(`"${rid}" isn't a run id. "open-katana runs list" shows them.`);
    const r = await ownerApi<RunSummary>("POST", `/api/runs/${rid}/cancel`);
    out(`Stopping ${r.title}. Shots already made are kept.`);
    return;
  }
  out("Usage:\n  open-katana runs list\n  open-katana runs cancel <runId>");
  process.exitCode = 1;
}
