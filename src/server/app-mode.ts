import { isRunActive } from "../app/project-lock.js";
import { BriefFileSchema, ID_PATTERNS, UserPicksFileSchema } from "../app/schemas.js";
import type { ApprovalFile, BriefFile } from "../app/types.js";
import { OUT_OF_CREDITS } from "../comfy/backend.js";
import type { Workspace } from "../project/workspace.js";

// App-run mode (spec §10): when the open-katana app starts a director, the MCP server it talks to gets
// OPEN_KATANA_RUN and OPEN_KATANA_PROJECT. It then works on that one project only, refuses the tools
// that import, start, save presets or change the backend, and spends only what plan/approval.json
// allows. Every reason to stop is a tool error with a [CODE] prefix the app turns into a paused state.
// Chat sessions keep their old behaviour, except that they leave alone a project the app is making.

/** The app run this MCP server belongs to, or undefined in a chat session. */
export function appRun(env: NodeJS.ProcessEnv = process.env): { run: string; project: string } | undefined {
  if (!env.OPEN_KATANA_RUN) return undefined;
  const project = env.OPEN_KATANA_PROJECT ?? "";
  // A pinned id that isn't a project id would otherwise be read as a directory path.
  if (!ID_PATTERNS.project.test(project) || project.length > 100) throw new Error("[APP] OPEN_KATANA_PROJECT is not a project id.");
  return { run: env.OPEN_KATANA_RUN, project };
}

export const isAppRun = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.OPEN_KATANA_RUN);

/** In app runs the person approves spending in the app, through plan/approval.json. */
export const approvalFromFile = (env: NodeJS.ProcessEnv = process.env): boolean => env.OPEN_KATANA_APPROVAL === "file";

export const APP_REFUSAL = "[APP] Not available in app runs.";

/** Called first by the tools that app runs may not use (imports, starts, presets, studio, backend changes). */
export function refuseInAppRun(): void {
  if (isAppRun()) throw new Error(APP_REFUSAL);
}

/** In a chat session, refuses to change a project while an app run holds it. */
export function refuseIfLocked(ws: Workspace): void {
  if (!isAppRun() && isRunActive(ws.dir)) throw new Error("[LOCKED] This edit is being made in the open-katana app. Stop it there first.");
}

/**
 * The person's approval from the app, or undefined when there is none yet (or it can't be read). Only
 * the GPU cap matters here, so a file the app wrote with fields this build doesn't know still counts.
 */
export async function readApproval(ws: Workspace): Promise<Pick<ApprovalFile, "gpuMinutes"> | undefined> {
  const raw = await ws.readJson<Partial<ApprovalFile>>("plan/approval.json").catch(() => undefined);
  const gpuMinutes = raw?.gpuMinutes;
  return typeof gpuMinutes === "number" && Number.isFinite(gpuMinutes) && gpuMinutes >= 0 ? { gpuMinutes } : undefined;
}

/** The brief the app resolved for this project (plan/brief.json), if any. */
export async function readBrief(ws: Workspace): Promise<BriefFile | undefined> {
  const raw = await ws.readJson<unknown>("plan/brief.json").catch(() => undefined);
  const parsed = BriefFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The person's take picks from the app (qa/user-picks.json): line → picked asset, the latest pick per line. */
export async function userPicks(ws: Workspace): Promise<Map<string, string>> {
  const raw = await ws.readJson<unknown>("qa/user-picks.json").catch(() => undefined);
  const parsed = UserPicksFileSchema.safeParse(raw);
  const picks = new Map<string, string>();
  if (!parsed.success) return picks;
  for (const p of [...parsed.data.picks].sort((a, b) => a.at.localeCompare(b.at))) picks.set(p.line, p.asset);
  return picks;
}

/** The aspect (width/height) of the template's format, for projects without a reference (spec D44). */
export async function presetAspect(ws: Workspace): Promise<number | undefined> {
  const preset = await ws.readJson<{ format?: { aspect?: string } }>("plan/preset.json").catch(() => undefined);
  const [w, h] = (preset?.format?.aspect ?? "").split(":").map(Number);
  return w && h ? w / h : undefined;
}

const CONNECTION = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timed? ?out|TimeoutError|AbortError/i;

/** True when an error means the backend could not be reached at all (as opposed to refusing a job). */
export function isConnectionError(e: unknown): boolean {
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  return CONNECTION.test(`${err?.message ?? ""} ${err?.code ?? ""} ${err?.cause?.code ?? ""} ${err?.cause?.message ?? ""}`);
}

/**
 * A backend failure as the app reads it: out of credits → [OUT_OF_CREDITS], unreachable → [BACKEND].
 * Other errors (and ones that already carry a code) pass through unchanged.
 */
export function backendError(e: unknown, target: string): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (/^\[[A-Z_]+\]/.test(err.message)) return err;
  if (err.message.includes(OUT_OF_CREDITS)) return new Error(`[OUT_OF_CREDITS] ${err.message}`);
  if (isConnectionError(err)) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return new Error(`[BACKEND] ${target}: ${cause?.code ?? cause?.message ?? err.message}`);
  }
  return err;
}
