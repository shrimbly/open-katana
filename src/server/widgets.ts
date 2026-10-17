import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, extname, join, normalize } from "node:path";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Workspace } from "../project/workspace.js";
import { dataHome, packageRoot } from "../util/paths.js";
import { result, safe } from "./content.js";
import type { State } from "./state.js";

export const WIDGETS = {
  result: "ui://open-katana/result.html",
  presets: "ui://open-katana/presets.html",
  estimate: "ui://open-katana/estimate.html",
} as const;

/** `_meta` that binds a tool to a widget (current MCP Apps key plus the legacy flat key). */
export const widgetMeta = (uri: string) => ({ ui: { resourceUri: uri }, "ui/resourceUri": uri });

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const MAX_RESOURCE_BYTES = 60 * 2 ** 20;
const MAX_UPLOAD_BYTES = 200 * 2 ** 20;

async function widgetHtml(name: string): Promise<string> {
  const built = join(packageRoot(), "dist", "ui", `${name}.html`);
  if (existsSync(built)) return readFile(built, "utf8");
  return `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:16px">open-katana widget "${name}" is not built. Run <code>pnpm build:ui</code>.</body>`;
}

export function registerWidgets(server: McpServer, _state: State): void {
  for (const [name, uri] of Object.entries(WIDGETS)) {
    registerAppResource(server, `open-katana ${name}`, uri, { mimeType: RESOURCE_MIME_TYPE, description: `open-katana ${name} widget` }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await widgetHtml(name), _meta: { ui: { prefersBorder: false } } }],
    }));
  }

  // Project media (deliveries, renders, generated assets) as resources, so widgets can play and download them.
  server.registerResource(
    "project media",
    new ResourceTemplate("katana://media/{project}/{+path}", { list: undefined }),
    { title: "open-katana project media", description: "A file inside an open-katana project (render, delivery or asset)" },
    async (uri, vars) => {
      const ws = await Workspace.open(String(vars.project));
      const rel = normalize(String(vars.path));
      if (rel.startsWith("..") || rel.startsWith("/")) throw new Error("Path escapes the project");
      const file = ws.path(rel);
      const size = (await stat(file)).size;
      if (size > MAX_RESOURCE_BYTES) throw new Error(`${basename(file)} is ${Math.round(size / 2 ** 20)} MB, over the 60 MB resource limit`);
      return { contents: [{ uri: uri.href, mimeType: MIME[extname(file).toLowerCase()] ?? "application/octet-stream", blob: (await readFile(file)).toString("base64") }] };
    },
  );

  // Widgets cannot hand the server local paths, so photos picked in the gallery are uploaded in chunks.
  server.registerTool(
    "katana_upload",
    {
      title: "Upload media from a widget",
      description: "App-only: receives a file chosen in an open-katana widget, in base64 chunks, and returns its local path.",
      inputSchema: z.object({
        name: z.string().max(200),
        data: z.string().describe("Base64 chunk"),
        uploadId: z.string().regex(/^[a-z0-9]{8,32}$/).optional(),
        final: z.boolean().default(true),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    safe(async ({ name, data, uploadId, final }) => {
      const inbox = join(dataHome(), "inbox");
      await mkdir(inbox, { recursive: true });
      const id = uploadId ?? randomBytes(6).toString("hex");
      const ext = extname(name).toLowerCase();
      if (!MIME[ext]) throw new Error(`Unsupported file type ${ext}`);
      const partial = join(inbox, `${id}.part`);
      await appendFile(partial, Buffer.from(data, "base64"));
      if ((await stat(partial)).size > MAX_UPLOAD_BYTES) throw new Error("Upload is larger than 200 MB");
      if (!final) return result("chunk stored", { uploadId: id });
      const dest = join(inbox, `${id}-${basename(name).replace(/[^\w.-]+/g, "_")}`);
      await rename(partial, dest);
      return result(dest, { path: dest, uploadId: id });
    }),
  );
}
