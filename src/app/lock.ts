import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { VERSION } from "../server/server.js";
import { run } from "../util/proc.js";
import { appDir } from "./http.js";
import { AppLockSchema } from "./schemas.js";
import type { AppLock } from "./types.js";

// The app owner's lock, ~/.open-katana/app/app.lock (spec §3.1). One process at a time runs edits; the
// lock names it so `open-katana app` can reuse it and `open-katana runs` can reach it.

export const appLockFile = () => join(appDir(), "app.lock");

/** True when a process with this pid exists (EPERM means it exists but isn't ours). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const ownStart: { value?: Promise<string> } = {};

/**
 * When the process started, as the OS reports it ("" when unknown). With the pid it identifies a process
 * across pid reuse: `ps -o lstart=` on macOS and Linux, PowerShell's StartTime on Windows.
 */
export async function processStart(pid: number): Promise<string> {
  if (pid === process.pid && ownStart.value) return ownStart.value;
  const read = (async () => {
    try {
      const out =
        process.platform === "win32"
          ? await run("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${Math.trunc(pid)}).StartTime.ToUniversalTime().ToString('o')`])
          : await run("ps", ["-o", "lstart=", "-p", String(Math.trunc(pid))]);
      return out.stdout.toString("utf8").trim();
    } catch {
      return "";
    }
  })();
  if (pid === process.pid) ownStart.value = read;
  return read;
}

export async function readAppLock(): Promise<AppLock | undefined> {
  try {
    return AppLockSchema.parse(JSON.parse(await readFile(appLockFile(), "utf8")));
  } catch {
    return undefined;
  }
}

/** The lock, when the process that wrote it is still the one running under that pid. */
export async function liveAppLock(): Promise<AppLock | undefined> {
  const lock = await readAppLock();
  if (!lock || !isAlive(lock.pid)) return undefined;
  const start = await processStart(lock.pid);
  return !start || !lock.procStart || start === lock.procStart ? lock : undefined;
}

/** The port this process took the lock for, so release only removes our own lock. */
let held: number | undefined;

/** Takes app.lock for this process (a stale lock is replaced). False when a live owner holds it. */
export async function acquireAppLock(port: number): Promise<boolean> {
  await mkdir(appDir(), { recursive: true });
  const lock: AppLock = { pid: process.pid, port, version: VERSION, procStart: await processStart(process.pid), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(appLockFile(), "wx", 0o600);
      try {
        await fh.writeFile(JSON.stringify(lock, null, 2));
      } finally {
        await fh.close();
      }
      held = port;
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (await liveAppLock()) return false;
      // Stale (its process is gone, or the pid now belongs to another process): replace it once.
      await rm(appLockFile(), { force: true });
    }
  }
  return false;
}

export async function releaseAppLock(): Promise<void> {
  if (held === undefined) return;
  const lock = await readAppLock();
  if (lock && lock.pid === process.pid && lock.port === held && existsSync(appLockFile())) await rm(appLockFile(), { force: true });
  held = undefined;
}
