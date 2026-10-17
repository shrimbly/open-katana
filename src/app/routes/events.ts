import { openProject } from "../http.js";
import { type Handler, matchRoute } from "../router.js";

/** The global SSE channel, and each project's channel (spec §7.7). Ids are checked before subscribing. */
export const events: Handler = async (ctx, req, res, _url, parts) => {
  if (matchRoute("GET /api/events", req, parts)) {
    ctx.hub.subscribeGlobal(res);
    return true;
  }
  const p = matchRoute("GET /api/projects/:id/events", req, parts);
  if (!p) return false;
  const ws = await openProject(p.id);
  ctx.hub.subscribeProject(ws.project.id, res);
  return true;
};
