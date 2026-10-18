import { z } from "zod";
import { assertId, readJsonBody } from "../http.js";
import { importInstagram, linkStatus } from "../links.js";
import { type Handler, HttpError, matchRoute, sendJson } from "../router.js";
import { loadSettings } from "../settings.js";
import { deleteUpload, readUpload, receiveUpload } from "../uploads.js";

/** POST /api/uploads/link: an Instagram reel or post, for its video (edit) or its sound (music). */
const LinkImportSchema = z.object({ url: z.string().url().max(500), purpose: z.enum(["edit", "music"]) });

/** Staged uploads: raw request bodies into the inbox (spec §7.3). */
export const uploads: Handler = async (_ctx, req, res, _url, parts) => {
  if (matchRoute("POST /api/uploads", req, parts)) {
    try {
      sendJson(res, 201, await receiveUpload(req));
    } catch (e) {
      // The rest of a refused body isn't read; close the connection rather than keep it alive.
      res.setHeader("connection", "close");
      throw e;
    }
    return true;
  }
  if (matchRoute("POST /api/uploads/link", req, parts)) {
    const body = await readJsonBody(req, LinkImportSchema);
    sendJson(res, 201, await importInstagram(body.url, body.purpose, await loadSettings()));
    return true;
  }
  if (matchRoute("GET /api/links", req, parts)) {
    sendJson(res, 200, await linkStatus(await loadSettings()));
    return true;
  }
  let p = matchRoute("GET /api/uploads/:id", req, parts);
  if (p) {
    const upload = await readUpload(assertId("upload", p.id));
    if (!upload) throw new HttpError(404, "No such upload.", "NO_UPLOAD");
    sendJson(res, 200, upload);
    return true;
  }
  p = matchRoute("DELETE /api/uploads/:id", req, parts);
  if (p) {
    await deleteUpload(assertId("upload", p.id));
    res.writeHead(204).end();
    return true;
  }
  return false;
};
