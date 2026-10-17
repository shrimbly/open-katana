import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectsRoot, writeFileAtomic } from "../../project/workspace.js";
import { AppJsonSchema, ID_PATTERNS, RunRecordSchema } from "../schemas.js";
import type { AppJson, RunRecord } from "../types.js";

/**
 * Run records on disk: projects/<pid>/runs/<rid>/run.json (spec §9.2, §9.10). The app is the only
 * writer of run.json and app.json; writes are atomic and queued per file.
 */

/** `r-<yyyymmddHHMMss>-<4 hex>`, UTC. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `r-${stamp}-${randomBytes(2).toString("hex")}`;
}

export const projectDir = (project: string) => join(projectsRoot(), project);
export const runDir = (project: string, rid: string) => join(projectDir(project), "runs", rid);

export const RUN_FILES = {
  record: "run.json",
  system: "system.txt",
  stream: "stream.jsonl",
  stderr: "stderr.log",
  mcp: "mcp.json",
  prompt: (n: number) => `prompt-${n}.txt`,
};

export async function readRun(project: string, rid: string): Promise<RunRecord | undefined> {
  const file = join(runDir(project, rid), RUN_FILES.record);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = RunRecordSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeRun(rec: RunRecord): Promise<void> {
  rec.updatedAt = new Date().toISOString();
  await writeFileAtomic(join(runDir(rec.project, rec.id), RUN_FILES.record), `${JSON.stringify(rec, null, 2)}\n`);
}

/** Every run record under the projects root (unreadable ones are skipped). */
export async function listRunRecords(): Promise<RunRecord[]> {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  const out: RunRecord[] = [];
  for (const project of await readdir(root)) {
    if (!ID_PATTERNS.project.test(project)) continue;
    const runs = join(root, project, "runs");
    if (!existsSync(runs)) continue;
    for (const rid of await readdir(runs).catch(() => [] as string[])) {
      if (!ID_PATTERNS.run.test(rid)) continue;
      const rec = await readRun(project, rid);
      if (rec) out.push(rec);
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Finds a run's record when only its id is known. */
export async function findRun(rid: string): Promise<RunRecord | undefined> {
  if (!ID_PATTERNS.run.test(rid)) return undefined;
  const root = projectsRoot();
  if (!existsSync(root)) return undefined;
  for (const project of await readdir(root)) {
    if (ID_PATTERNS.project.test(project) && existsSync(join(root, project, "runs", rid, RUN_FILES.record))) return readRun(project, rid);
  }
  return undefined;
}

export async function readAppJson(project: string): Promise<AppJson | undefined> {
  const file = join(projectDir(project), "app.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = AppJsonSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeAppJson(project: string, app: AppJson): Promise<void> {
  await writeFileAtomic(join(projectDir(project), "app.json"), `${JSON.stringify(AppJsonSchema.parse(app), null, 2)}\n`);
}
