import { assertId, CACHE_IMMUTABLE, safeJoin, serveFile } from "../http.js";
import { type Handler, HttpError, matchRoute } from "../router.js";
import { templateEntry, templateFileNames } from "../templates.js";
import { uploadMediaPath } from "../uploads.js";

/** The still-encoded path segments after `/<prefix>/<id>/`, so safeJoin sees what the client sent. */
const rawTail = (url: URL, skip: number) => url.pathname.split("/").filter(Boolean).slice(skip).join("/");

/**
 * A template's example, poster, cut map or soundtrack, with byte ranges (spec §7.2). Only the names the
 * preset lists are served, so nothing else in its folder (preset.json, a reference) is reachable.
 */
export const templateFiles: Handler = async (_ctx, req, res, url, parts) => {
  if (parts[0] !== "templates" || (req.method !== "GET" && req.method !== "HEAD")) return false;
  if (parts.length < 3) throw new HttpError(404, "Not found.", "NOT_FOUND");
  const entry = await templateEntry(parts[1]!);
  const rel = rawTail(url, 2);
  const file = safeJoin(entry.dir, rel);
  if (!templateFileNames(entry).includes(decodeURIComponent(rel))) throw new HttpError(404, "Not found.", "NOT_FOUND");
  serveFile(req, res, file, { cache: entry.source === "built-in" ? CACHE_IMMUTABLE : "no-cache", untrusted: true });
  return true;
};

/** A staged upload's media, with byte ranges (spec §7.3). */
export const uploadFiles: Handler = async (_ctx, req, res, _url, parts) => {
  const p = matchRoute("GET /uploads/:id/media", req, parts);
  if (!p) return false;
  const file = await uploadMediaPath(assertId("upload", p.id));
  if (!file) throw new HttpError(404, "No such upload.", "NO_UPLOAD");
  serveFile(req, res, file, { untrusted: true });
  return true;
};
