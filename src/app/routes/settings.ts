import { readJsonBody } from "../http.js";
import { type Handler, matchRoute, sendJson } from "../router.js";
import { AppSettingsPatchSchema } from "../schemas.js";
import { loadSettings, saveSettings } from "../settings.js";

/** App settings in ~/.open-katana/app/settings.json (spec §7.1). */
export const settings: Handler = async (ctx, req, res, _url, parts) => {
  if (matchRoute("GET /api/settings", req, parts)) {
    sendJson(res, 200, await loadSettings());
    return true;
  }
  if (matchRoute("PUT /api/settings", req, parts)) {
    const saved = await saveSettings(await readJsonBody(req, AppSettingsPatchSchema));
    // More edits at once may let a queued one start now.
    void ctx.runs?.schedule();
    sendJson(res, 200, saved);
    return true;
  }
  return false;
};
