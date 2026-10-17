import { type AppCtx, type Handler, matchRoute, sendJson } from "../router.js";
import type { Info } from "../types.js";
import { HEIC_SUPPORTED } from "../uploads.js";

/** What this build can do; `open-katana app` and `ensureStandaloneStudio` reuse a server only when it lists "app". */
export const FEATURES = ["app", "runs", "decode", "templates", ...(HEIC_SUPPORTED ? ["heic"] : [])];

export function appInfo(ctx: AppCtx): Info {
  return { name: "open-katana", version: ctx.version, port: ctx.port, pid: process.pid, owner: ctx.owner, features: FEATURES };
}

/** Server identity: version, port, owner and features (spec §7.1). */
export const info: Handler = (ctx, req, res, _url, parts) => {
  if (!matchRoute("GET /api/info", req, parts)) return false;
  sendJson(res, 200, appInfo(ctx));
  return true;
};
