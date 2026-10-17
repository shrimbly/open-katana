import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * The project lock: `runs/active`, created with `wx` while an app run holds the project (spec §9.12).
 * Pure fs and synchronous, so the MCP server (chat sessions) can check it before writing.
 */

/** Statuses in which a run holds its project. */
const HOLDING = new Set(["queued", "starting", "running", "stopping", "paused"]);

const lockFile = (projectDir: string) => join(projectDir, "runs", "active");

/** The run named by the lock file, if any. */
export function lockedBy(projectDir: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(lockFile(projectDir), "utf8")) as { run?: unknown };
    return typeof data.run === "string" && /^r-[0-9]{14}-[0-9a-f]{4}$/.test(data.run) ? data.run : undefined;
  } catch {
    return undefined;
  }
}

function runStatus(projectDir: string, run: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(join(projectDir, "runs", run, "run.json"), "utf8")) as { status?: unknown };
    return typeof data.status === "string" ? data.status : undefined;
  } catch {
    return undefined;
  }
}

/** True when an app run holds the project: the lock exists and its run is in a status that holds it. */
export function isRunActive(projectDir: string): boolean {
  if (!existsSync(lockFile(projectDir))) return false;
  const run = lockedBy(projectDir);
  return Boolean(run && HOLDING.has(runStatus(projectDir, run) ?? ""));
}

/**
 * Takes the lock for `run`. A lock left by a run that no longer holds the project is replaced; a
 * live one makes this return false. Taking a lock this run already holds succeeds.
 */
export function acquireProjectLock(projectDir: string, run: string, since = new Date().toISOString()): boolean {
  const file = lockFile(projectDir);
  mkdirSync(join(projectDir, "runs"), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(file, "wx", 0o644);
      try {
        writeSync(fd, JSON.stringify({ run, since }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = lockedBy(projectDir);
      if (holder === run) return true;
      if (holder && HOLDING.has(runStatus(projectDir, holder) ?? "")) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

/** Removes the lock when `run` holds it (never another run's). */
export function releaseProjectLock(projectDir: string, run: string): void {
  const holder = lockedBy(projectDir);
  if (holder === run || !holder) rmSync(lockFile(projectDir), { force: true });
}
