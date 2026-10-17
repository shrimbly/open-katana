import { assertId, readJsonBody } from "../http.js";
import { liveAppLock } from "../lock.js";
import { type AppCtx, type Handler, HttpError, matchRoute, sendJson } from "../router.js";
import { estimateDraft } from "../runs/estimate.js";
import { RunManager } from "../runs/manager.js";
import { RunDraftSchema } from "../schemas.js";
import type { ContinueRun, FieldProblem, StartRun } from "../types.js";

/** Estimates and director runs (spec §7.5). Reads and estimates work on any server; mutations need the owner. */

/** The server that holds app.lock runs edits; any other answers 503 with the owner's port. */
async function owner(ctx: AppCtx): Promise<RunManager> {
  if (ctx.owner && ctx.runs) return ctx.runs;
  const lock = await liveAppLock();
  throw new HttpError(503, "Edits are made by the open-katana app. Open it to start or change one.", "NOT_OWNER", { port: lock?.port ?? null });
}

export const runs: Handler = async (ctx, req, res, url, parts) => {
  let m: Record<string, string> | undefined;

  if (matchRoute("POST /api/runs/estimate", req, parts)) {
    const body = await readJsonBody(req);
    const parsed = RunDraftSchema.safeParse(body);
    if (!parsed.success) {
      const problems: FieldProblem[] = parsed.error.issues.map((i) => ({ field: i.path.map(String).join(".") || "draft", message: i.message }));
      throw new HttpError(422, problems[0]!.message, "PROBLEMS", { problems });
    }
    sendJson(res, 200, await estimateDraft(parsed.data));
    return true;
  }

  if (matchRoute("POST /api/runs", req, parts)) {
    const manager = await owner(ctx);
    const body = await readJsonBody<StartRun>(req);
    sendJson(res, 201, await manager.start(body));
    return true;
  }

  if (matchRoute("GET /api/runs", req, parts)) {
    const active = url.searchParams.get("active") === "1";
    sendJson(res, 200, { runs: ctx.runs ? ctx.runs.list({ active }) : await RunManager.readList({ active }) });
    return true;
  }

  if ((m = matchRoute("GET /api/runs/:rid", req, parts))) {
    const rid = assertId("run", m.rid);
    const state = ctx.runs?.get(rid) ?? (await RunManager.readState(rid));
    if (!state) throw new HttpError(404, "No such run.", "NOT_FOUND");
    sendJson(res, 200, state);
    return true;
  }

  if ((m = matchRoute("GET /api/runs/:rid/diagnostics", req, parts))) {
    const rid = assertId("run", m.rid);
    const d = ctx.runs?.get(rid) ? await ctx.runs.diagnostics(rid) : await RunManager.readDiagnostics(rid);
    if (!d) throw new HttpError(404, "No such run.", "NOT_FOUND");
    sendJson(res, 200, d);
    return true;
  }

  if ((m = matchRoute("POST /api/runs/:rid/cancel", req, parts))) {
    const rid = assertId("run", m.rid);
    const manager = await owner(ctx);
    sendJson(res, 202, await manager.cancel(rid));
    return true;
  }

  if ((m = matchRoute("POST /api/runs/:rid/continue", req, parts))) {
    const rid = assertId("run", m.rid);
    const manager = await owner(ctx);
    sendJson(res, 202, await manager.continue(rid, await readJsonBody<ContinueRun>(req)));
    return true;
  }

  if ((m = matchRoute("POST /api/runs/:rid/start-now", req, parts))) {
    const rid = assertId("run", m.rid);
    const manager = await owner(ctx);
    sendJson(res, 202, await manager.startNow(rid));
    return true;
  }

  return false;
};
