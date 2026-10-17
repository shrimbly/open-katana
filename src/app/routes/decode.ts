import { readdir, rm } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { projectsRoot, Workspace } from "../../project/workspace.js";
import { isId, openProject, readJsonBody } from "../http.js";
import { readAppJson, withProject } from "../projects.js";
import { type AppCtx, type Handler, HttpError, matchRoute, sendJson } from "../router.js";
import { ID_PATTERNS } from "../schemas.js";
import type { AppJson, DecodeState } from "../types.js";
import { deleteUpload, moveUploadInto, readUpload } from "../uploads.js";

const DecodeRequestSchema = z.union([
  z.object({ upload: z.string().regex(ID_PATTERNS.upload) }).strict(),
  z.object({ fromProject: z.string().max(100).regex(ID_PATTERNS.project) }).strict(),
]);

/** A decode project with this upload hash and no runs yet, so dropping the same file twice reopens it. */
async function findDecoded(hash: string): Promise<Workspace | undefined> {
  const ids = await readdir(projectsRoot()).catch(() => [] as string[]);
  let best: { ws: Workspace; createdAt: string } | undefined;
  for (const id of ids) {
    if (!isId("project", id)) continue;
    const ws = await Workspace.open(id).catch(() => undefined);
    const app = ws && (await readAppJson(ws));
    if (!ws || !app || app.origin.kind !== "decode" || app.origin.uploadHash !== hash || app.runs.length || !ws.reference()) continue;
    if (!best || app.createdAt > best.createdAt) best = { ws, createdAt: app.createdAt };
  }
  return best?.ws;
}

/** A project title from a file name: "my-fav-edit.mp4" → "my-fav-edit". */
const titleFrom = (name: string) => name.slice(0, name.length - extname(name).length).trim().slice(0, 60) || "Decoded edit";

async function startDecode(ctx: AppCtx, ws: Workspace, name: string): Promise<DecodeState> {
  ctx.hub.global({ type: "projects" });
  return ctx.decodes.start(ws, name);
}

/** Decoding a dropped edit (spec §7.4, §3.3 R1 and R9). */
export const decode: Handler = async (ctx, req, res, _url, parts) => {
  if (matchRoute("POST /api/decode", req, parts)) {
    const body = await readJsonBody(req, DecodeRequestSchema);
    if ("upload" in body) {
      const upload = await readUpload(body.upload);
      if (!upload) throw new HttpError(404, "That upload is gone. Drop the edit again.", "NO_UPLOAD");
      if (upload.purpose !== "edit") throw new HttpError(422, "That file was added as a photo or track, not an edit.", "UPLOAD_PURPOSE");
      const existing = await findDecoded(upload.hash);
      if (existing) {
        await deleteUpload(upload.id);
        const state = (await ctx.decodes.get(existing).catch(() => undefined)) ?? (await ctx.decodes.start(existing, upload.name));
        sendJson(res, 201, { project: existing.project.id, reused: true, state });
        return true;
      }
      const created = await Workspace.create({ title: titleFrom(upload.name), mode: "remix" });
      const id = created.project.id;
      try {
        await withProject(id, async (ws) => {
          await moveUploadInto(ws, upload.id, "edit", { role: "reference", id: "ref" });
          const app: AppJson = { v: 1, origin: { kind: "decode", sourceName: upload.name, uploadHash: upload.hash }, runs: [], createdAt: new Date().toISOString() };
          await ws.writeJson("app.json", app);
        });
      } catch (e) {
        await rm(created.dir, { recursive: true, force: true });
        throw e;
      }
      const state = await startDecode(ctx, await Workspace.open(id), upload.name);
      sendJson(res, 201, { project: id, reused: false, state });
      return true;
    }
    // Make another from a decoded edit: copy its reference into a new project and decode it again
    // (review codes are seeded per project).
    const src = await openProject(body.fromProject);
    const ref = src.reference();
    if (!ref) throw new HttpError(422, "That project has no video to decode.", "NO_REFERENCE");
    const srcApp = await readAppJson(src);
    const sourceName = srcApp?.origin.sourceName ?? ref.label ?? src.project.title;
    const created = await Workspace.create({ title: src.project.title, mode: "remix" });
    const id = created.project.id;
    try {
      await withProject(id, async (ws) => {
        await ws.import(src.path(ref.path), "reference", { id: "ref", label: ref.label });
        const origin: AppJson["origin"] = { kind: "decode", sourceName, ...(srcApp?.origin.uploadHash ? { uploadHash: srcApp.origin.uploadHash } : {}) };
        await ws.writeJson("app.json", { v: 1, origin, runs: [], createdAt: new Date().toISOString() } satisfies AppJson);
      });
    } catch (e) {
      await rm(created.dir, { recursive: true, force: true });
      throw e;
    }
    const state = await startDecode(ctx, await Workspace.open(id), sourceName);
    sendJson(res, 201, { project: id, reused: false, state });
    return true;
  }
  const p = matchRoute("GET /api/projects/:id/decode", req, parts);
  if (!p) return false;
  const ws = await openProject(p.id);
  const state = (await ctx.decodes.get(ws)) ?? (await ws.readJson<DecodeState>("analysis/decode.json").catch(() => undefined));
  if (!state) throw new HttpError(404, "This project hasn't been decoded.", "NOT_DECODED");
  sendJson(res, 200, state);
  return true;
};
