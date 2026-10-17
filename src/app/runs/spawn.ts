import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { claudeCommand, exec } from "../setup.js";
import { type McpConfigInput, mcpConfig, withoutKeys } from "./args.js";

/**
 * Starting, finding and stopping a director process (spec §9.4, §9.11). The director runs detached in
 * its own process group, reading its prompt from a file and appending to its stream file, so it
 * outlives the app server and the group can be signalled as one.
 */

/** Writes an attempt's mcp.json, readable by its owner only (it holds no secret, but names the project). */
export async function writeMcpConfig(file: string, input: McpConfigInput): Promise<void> {
  await writeFile(file, `${JSON.stringify(mcpConfig(input), null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export interface Spawned {
  child: ChildProcess;
  pid: number;
}

/** Spawns `claude` with the prompt file on stdin; rejects when the binary cannot start (ENOENT…). */
export function spawnDirector(o: { claudePath: string; args: string[]; cwd: string; promptFile: string; streamFile: string; stderrFile: string }): Promise<Spawned> {
  const { cmd, args } = claudeCommand(o.claudePath, o.args);
  const fds = [openSync(o.promptFile, "r"), openSync(o.streamFile, "a"), openSync(o.stderrFile, "a")];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    const closeFds = () => {
      for (const fd of fds) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
    };
    try {
      child = spawn(cmd, args, {
        cwd: o.cwd,
        detached: true, // own process group: survives the server, and the group can be signalled
        stdio: fds,
        env: withoutKeys(process.env, ["OPEN_KATANA_RUN", "OPEN_KATANA_PROJECT", "OPEN_KATANA_APPROVAL"]),
        windowsHide: true,
      });
    } catch (e) {
      closeFds();
      return reject(e);
    }
    child.once("error", (e) => {
      closeFds();
      reject(e);
    });
    child.once("spawn", () => {
      // The child holds its own copies of the descriptors.
      closeFds();
      child.unref();
      resolve({ child, pid: child.pid! });
    });
  });
}

/** Keeps a Mac awake while the director runs (`caffeinate -w` exits with it). */
export function keepAwake(pid: number): number | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const c = spawn("caffeinate", ["-i", "-w", String(pid)], { detached: true, stdio: "ignore" });
    c.on("error", () => undefined);
    c.unref();
    return c.pid;
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The process's start time as `ps` prints it, to tell a reused pid from ours. */
export async function procStart(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") {
    const r = await exec("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToString("o")`], 5_000);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }
  const r = await exec("ps", ["-o", "lstart=", "-p", String(pid)], 5_000);
  return r.code === 0 ? r.stdout.trim().replace(/\s+/g, " ") || undefined : undefined;
}

/** The process's command line (to check an adopted pid is still a director). */
export async function procCommand(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") {
    const r = await exec("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], 5_000);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }
  const r = await exec("ps", ["-o", "command=", "-p", String(pid)], 5_000);
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Signals the director's whole process group (Windows: the process tree). */
export async function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (process.platform === "win32") {
    await exec("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], 5_000);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Waits until `pid` is gone, polling every `everyMs`, for at most `maxMs`. True when it is gone. */
export async function waitGone(pid: number, maxMs: number, everyMs = 250): Promise<boolean> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return !isAlive(pid);
}

/** True while any process of `pgid`'s group is alive (Windows: the process itself). */
export function groupAlive(pgid: number): boolean {
  if (process.platform === "win32") return isAlive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits until the director's whole process group is gone (its MCP server, and any `comfy` child, too), for at
 * most `maxMs`. A group member that outlives the leader could still write jobs.json after the cancel sweep.
 */
export async function waitGroupGone(pgid: number, maxMs: number, everyMs = 100): Promise<boolean> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (!groupAlive(pgid) && !isAlive(pgid)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return !groupAlive(pgid) && !isAlive(pgid);
}
