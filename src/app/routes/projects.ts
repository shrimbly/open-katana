import { z } from "zod";
import { assertId, openProject, readJsonBody, serveFile } from "../http.js";
import { applyPick, listProjectCards, posterFile, projectPage, revealProject, trashProject } from "../projects.js";
import { type Handler, HttpError, matchRoute, sendJson } from "../router.js";
import { ID_PATTERNS } from "../schemas.js";

const RevealSchema = z.object({ what: z.enum(["latest", "folder"]) });
const PickSchema = z.object({ line: z.string().regex(ID_PATTERNS.line), asset: z.string().regex(ID_PATTERNS.asset) });

/**
 * Project pages and actions (spec §7.6). The editor's own project routes (state, EDL, render, deliver,
 * thumb, waveform) and POST /export, which uses the render queue, stay in the studio server.
 */
export const projects: Handler = async (ctx, req, res, url, parts) => {
  if (matchRoute("GET /api/projects", req, parts)) {
    sendJson(res, 200, await listProjectCards(ctx));
    return true;
  }
  let p = matchRoute("GET /api/projects/:id/page", req, parts);
  if (p) {
    sendJson(res, 200, await projectPage(await openProject(p.id), ctx));
    return true;
  }
  p = matchRoute("GET /api/projects/:id/poster", req, parts);
  if (p) {
    const ws = await openProject(p.id);
    const file = await posterFile(ws, Number(url.searchParams.get("h") ?? 480));
    if (!file) throw new HttpError(404, "This project has nothing to show yet.", "NO_POSTER");
    serveFile(req, res, file);
    return true;
  }
  p = matchRoute("DELETE /api/projects/:id", req, parts);
  if (p) {
    await openProject(p.id);
    await trashProject(assertId("project", p.id));
    ctx.hub.global({ type: "projects" });
    res.writeHead(204).end();
    return true;
  }
  p = matchRoute("POST /api/projects/:id/reveal", req, parts);
  if (p) {
    const ws = await openProject(p.id);
    const { what } = await readJsonBody(req, RevealSchema);
    revealProject(ws, what);
    res.writeHead(204).end();
    return true;
  }
  p = matchRoute("POST /api/projects/:id/picks", req, parts);
  if (p) {
    const ws = await openProject(p.id);
    const { line, asset } = await readJsonBody(req, PickSchema);
    const out = await applyPick(ws.project.id, line, asset);
    // The run's takes show the new pick at once (finished runs aren't watched).
    ctx.runs?.refresh(ws.project.id);
    sendJson(res, 200, out);
    return true;
  }
  return false;
};
