import type { IncomingMessage, ServerResponse } from "node:http";
import type { DecodeManager } from "./decode.js";
import type { Hub } from "./hub.js";
import { decode } from "./routes/decode.js";
import { events } from "./routes/events.js";
import { templateFiles, uploadFiles } from "./routes/files.js";
import { info } from "./routes/info.js";
import { projects } from "./routes/projects.js";
import { runs } from "./routes/runs.js";
import { settings } from "./routes/settings.js";
import { setup } from "./routes/setup.js";
import { templates } from "./routes/templates.js";
import { uploads } from "./routes/uploads.js";
import type { RunManager } from "./runs/manager.js";

/** What the app's route handlers share; built once by `Studio.start()`. */
export interface AppCtx {
  /** The port this server listens on. */
  port: number;
  /** True when this server holds app.lock. Only the owner runs edits; elsewhere run mutations answer 503 NOT_OWNER. */
  owner: boolean;
  version: string;
  hub: Hub;
  decodes: DecodeManager;
  /** Present on the lock owner only. */
  runs?: RunManager;
}

/**
 * One group of routes. Returns true when it answered the request, false to let the next handler (and
 * finally the editor's own routes) try. Throw an HttpError to answer with a JSON error.
 */
export type Handler = (ctx: AppCtx, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => Promise<boolean> | boolean;

/** A JSON error reply: `{ error: message, code?, ...extra }` with the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(data));
}

/**
 * Matches a route like "GET /api/templates/:slug" against the request (GET also matches HEAD).
 * Returns the named parts, or undefined when the method or path differs.
 */
export function matchRoute(route: string, req: IncomingMessage, parts: string[]): Record<string, string> | undefined {
  const [method, path = ""] = route.split(" ");
  const want = req.method === "HEAD" ? "GET" : req.method;
  if (method !== want) return undefined;
  const pattern = path.split("/").filter(Boolean);
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, p] of pattern.entries()) {
    if (p.startsWith(":")) params[p.slice(1)] = parts[i]!;
    else if (p !== parts[i]) return undefined;
  }
  return params;
}

/**
 * In this order; the first handler that answers wins. Built on use, so a route module may import this
 * one (for HttpError) before or after it is loaded.
 */
const handlers = (): Handler[] => [info, setup, settings, templates, uploads, decode, runs, projects, events, templateFiles, uploadFiles];

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * The app's routes, called by the studio server right after its Host/Origin check. Every request that
 * changes something must carry `x-katana: 1`: a page on another site cannot set it without a CORS
 * preflight, and preflights (OPTIONS) are always refused. Returns false when no app route matched.
 */
export async function handleApp(ctx: AppCtx, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]): Promise<boolean> {
  try {
    if (req.method === "OPTIONS") throw new HttpError(403, "forbidden", "NO_INTENT");
    if (!SAFE_METHODS.has(req.method ?? "GET") && req.headers["x-katana"] !== "1") {
      throw new HttpError(403, "This request needs the x-katana: 1 header.", "NO_INTENT");
    }
    for (const handle of handlers()) if (await handle(ctx, req, res, url, parts)) return true;
    return false;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    sendJson(res, e.status, { ...e.extra, error: e.message, ...(e.code ? { code: e.code } : {}) });
    return true;
  }
}
