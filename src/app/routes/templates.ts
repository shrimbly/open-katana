import { assertId, openProject, readJsonBody } from "../http.js";
import { type Handler, matchRoute, sendJson } from "../router.js";
import { SaveTemplateRequestSchema } from "../schemas.js";
import { deleteTemplate, listTemplates, saveTemplate, templateDetail, templateEntry } from "../templates.js";

/** The template gallery and saved templates (spec §7.2). */
export const templates: Handler = async (ctx, req, res, _url, parts) => {
  if (matchRoute("GET /api/templates", req, parts)) {
    sendJson(res, 200, { templates: await listTemplates() });
    return true;
  }
  if (matchRoute("POST /api/templates", req, parts)) {
    const body = await readJsonBody(req, SaveTemplateRequestSchema);
    await openProject(body.fromProject);
    const detail = await saveTemplate(body);
    ctx.hub.global({ type: "templates" });
    sendJson(res, 201, detail);
    return true;
  }
  let p = matchRoute("GET /api/templates/:slug", req, parts);
  if (p) {
    sendJson(res, 200, await templateDetail(await templateEntry(p.slug!)));
    return true;
  }
  p = matchRoute("DELETE /api/templates/:slug", req, parts);
  if (p) {
    const slug = assertId("slug", p.slug);
    const active = new Set<string>();
    for (const r of ctx.runs?.list({ active: true }) ?? []) {
      const template = ctx.runs?.get(r.id)?.template;
      if (template) active.add(template);
    }
    await deleteTemplate(slug, active);
    ctx.hub.global({ type: "templates" });
    res.writeHead(204).end();
    return true;
  }
  return false;
};
