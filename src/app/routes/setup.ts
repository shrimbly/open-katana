import { readJsonBody } from "../http.js";
import { type Handler, matchRoute, sendJson } from "../router.js";
import { GpuSetupRequestSchema } from "../schemas.js";
import { saveGpu, setupStatus } from "../setup.js";

/** Setup checks and GPU connection (spec §7.1). Keys go in and never come back out. */
export const setup: Handler = async (ctx, req, res, url, parts) => {
  if (matchRoute("GET /api/setup", req, parts)) {
    sendJson(res, 200, await setupStatus({ fresh: url.searchParams.get("fresh") === "1" }));
    return true;
  }
  if (matchRoute("POST /api/setup/gpu", req, parts)) {
    const status = await saveGpu(await readJsonBody(req, GpuSetupRequestSchema));
    ctx.hub.global({ type: "setup" });
    sendJson(res, 200, status);
    return true;
  }
  return false;
};
