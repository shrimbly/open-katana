import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import { projectsRoot, Workspace } from "../project/workspace.js";
import { dataHome } from "../util/paths.js";
import { HttpError } from "./router.js";
import { ID_PATTERNS } from "./schemas.js";

// Shared HTTP plumbing for the app's routes and the studio server: id checks, safe paths, JSON bodies,
// ranged file serving and the page's content security policy (spec §7, §8.3, §13).

export const appDir = () => join(dataHome(), "app");
export const trashDir = () => join(dataHome(), "trash");

export type IdKind = keyof typeof ID_PATTERNS;
const MAX_ID_LENGTH: Partial<Record<IdKind, number>> = { project: 100, slug: 64 };

/** True when `value` is a well-formed id of this kind. A valid id never contains a path separator. */
export function isId(kind: IdKind, value: unknown): boolean {
  return typeof value === "string" && value.length <= (MAX_ID_LENGTH[kind] ?? 100) && ID_PATTERNS[kind].test(value);
}

/** Returns the id, or answers 400 BAD_ID. Call before any filesystem use. */
export function assertId(kind: IdKind, value: unknown): string {
  if (!isId(kind, value)) throw new HttpError(400, `That isn't a valid ${kind} id.`, "BAD_ID");
  return value as string;
}

/** A project by id: 400 for a malformed id, 404 when there is no such project. */
export async function openProject(id: unknown): Promise<Workspace> {
  const valid = assertId("project", id);
  if (!existsSync(join(projectsRoot(), valid, "project.json"))) throw new HttpError(404, `No project "${valid}".`, "NO_PROJECT");
  return Workspace.open(valid);
}

/**
 * Joins a URL path (still percent-encoded) under `root`, or answers 400 BAD_PATH. Refuses null bytes,
 * backslashes, absolute paths, `..` escapes (encoded or not) and symlinks that lead out of the root.
 * The result may not exist yet.
 */
export function safeJoin(root: string, rel: string): string {
  const bad = () => new HttpError(400, "Bad path.", "BAD_PATH");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    throw bad();
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\") || isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded)) throw bad();
  const base = existsSync(root) ? realpathSync(root) : resolve(root);
  const inside = (p: string) => {
    const r = relative(base, p);
    return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
  };
  const full = resolve(base, decoded);
  if (!inside(full) || full === base) throw bad();
  if (existsSync(full) && !inside(realpathSync(full))) throw bad();
  return full;
}

/** A path inside `root` written with forward slashes, for comparisons. */
export function relPosix(root: string, file: string): string {
  return relative(existsSync(root) ? realpathSync(root) : resolve(root), file).split(sep).join("/");
}

const MAX_JSON_BYTES = 1024 * 1024;

/**
 * Reads a JSON request body (≤ 1 MB) and validates it. An empty body is `{}`. Answers 413 when too large,
 * 415 when it isn't sent as application/json, 400 for bad JSON or a body the schema rejects.
 */
export async function readJsonBody<T = unknown>(req: IncomingMessage, schema?: z.ZodType<T>): Promise<T> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_JSON_BYTES) throw new HttpError(413, "The request body is larger than 1 MB.", "TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "The request body is larger than 1 MB.", "TOO_LARGE");
    chunks.push(c as Buffer);
  }
  let data: unknown = {};
  if (size > 0) {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON with content-type: application/json.", "NOT_JSON");
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "The request body isn't valid JSON.", "BAD_JSON");
    }
  }
  if (!schema) return data as T;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(400, message, "BAD_REQUEST");
  }
  return parsed.data;
}

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".woff2": "font/woff2",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
};

export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

/** The SPA's content security policy (spec §13.2), and no framing by any other page (clickjacking). */
export const CSP =
  "default-src 'self'; script-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'";

/**
 * The policy of every other response. A file the server hands out (a template's poster, a project's media)
 * opened as a page runs no script, so a page-like file in a shared template can't call the API as the app
 * (and such files are sent as downloads anyway); an image or a video opened in its own tab still shows.
 */
export const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/** Headers every response starts with (the SPA's HTML replaces the policy with CSP). */
export const BASE_HEADERS: Record<string, string> = { "x-frame-options": "DENY", "content-security-policy": FILE_CSP };

/** Types that a browser runs or renders as a document: served from untrusted folders only as downloads. */
const ACTIVE = new Set([".html", ".htm", ".svg", ".xml", ".xhtml", ".js", ".mjs", ".css"]);

/** The most an open-ended range request gets in one response. */
const RANGE_CHUNK = 2 * 1024 * 1024;

/**
 * Serves a file with HTTP range support so the browser can seek video and audio. 404 when missing.
 * `untrusted`: the file comes from a project, a template or an upload, so a page or script type is sent as
 * a download, never rendered.
 */
export function serveFile(req: IncomingMessage, res: ServerResponse, file: string, opts: { cache?: string; headers?: Record<string, string>; untrusted?: boolean } = {}): void {
  if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found.", "NOT_FOUND");
  const size = statSync(file).size;
  const ext = extname(file).toLowerCase();
  const active = opts.untrusted && ACTIVE.has(ext);
  const head = {
    "content-type": active ? "application/octet-stream" : (MIME[ext] ?? "application/octet-stream"),
    ...(active ? { "content-disposition": "attachment" } : {}),
    "accept-ranges": "bytes",
    "cache-control": opts.cache ?? "no-cache",
    "x-content-type-options": "nosniff",
    ...opts.headers,
  };
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start: number;
    let end: number;
    if (range[1]) {
      start = Number(range[1]);
      // An open-ended range ("bytes=0-", what video elements send) gets one chunk, not the rest of the
      // file: the browser asks for more as it plays, so a paused video doesn't hold one of its six
      // connections to this server open.
      end = range[2] ? Math.min(Number(range[2]), size - 1) : Math.min(start + RANGE_CHUNK - 1, size - 1);
    } else {
      // A suffix range: the last N bytes.
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    }
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...head, "content-length": size });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
}

/** `<name>-<yyyymmddHHMMss>`, the folder a deleted project or template gets in the trash. */
export function trashName(name: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${name}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}
