import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { extname, join } from "node:path";
import { finished } from "node:stream/promises";
import { analyzeAudio, type AudioAnalysis } from "../engine/audio.js";
import { type MediaInfo, probe, rationalValue } from "../engine/probe.js";
import { type PresetEntry, soundtrackPath } from "../presets/library.js";
import { projectsRoot, type Role, Workspace } from "../project/workspace.js";
import { run } from "../util/proc.js";
import { appDir, isId } from "./http.js";
import { loudnessRise } from "./music.js";
import { HttpError } from "./router.js";
import { AppJsonSchema } from "./schemas.js";
import type { Upload, UploadCheck, UploadPurpose } from "./types.js";

// Staged uploads (spec §11.1): a dropped file is streamed into ~/.open-katana/app/inbox/<id>/, sniffed,
// probed and described by meta.json. Nothing reaches a project until "Make my edit" (or a decode) takes it.

export const inboxDir = () => join(appDir(), "inbox");

/** iPhone photos are converted with `sips`, which only macOS has. */
export const HEIC_SUPPORTED = process.platform === "darwin";

const MB = 1024 * 1024;
export const UPLOAD_LIMITS: Record<UploadPurpose, number> = { photo: 30 * MB, edit: 300 * MB, music: 50 * MB };
const PLURAL: Record<UploadPurpose, string> = { photo: "Photos", edit: "Videos", music: "Tracks" };

const PART_MAX_AGE_MS = 60 * 60 * 1000;
const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/**
 * The stored file type from a file's first bytes, or undefined when they aren't a type this purpose
 * accepts. The file name never decides the type.
 */
export function sniff(head: Buffer, purpose: UploadPurpose): { ext: string; heic?: boolean } | undefined {
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  const brand = head.length >= 12 && ascii(4, 8) === "ftyp" ? ascii(8, 12) : undefined;
  const riff = head.length >= 12 && ascii(0, 4) === "RIFF" ? ascii(8, 12) : undefined;
  if (purpose === "photo") {
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ext: ".jpg" };
    if (head[0] === 0x89 && ascii(1, 4) === "PNG") return { ext: ".png" };
    if (riff === "WEBP") return { ext: ".webp" };
    if (brand && HEIC_BRANDS.has(brand)) return { ext: ".heic", heic: true };
    return undefined;
  }
  if (purpose === "edit") {
    if (brand && !HEIC_BRANDS.has(brand)) return { ext: brand === "qt  " ? ".mov" : brand.startsWith("M4V") ? ".m4v" : ".mp4" };
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { ext: head.includes("webm", 0, "latin1") ? ".webm" : ".mkv" };
    return undefined;
  }
  if (ascii(0, 3) === "ID3") return { ext: ".mp3" };
  if (head[0] === 0xff && (head[1] === 0xf1 || head[1] === 0xf9)) return { ext: ".aac" };
  if (head[0] === 0xff && head.length > 1 && (head[1]! & 0xe0) === 0xe0) return { ext: ".mp3" };
  if (riff === "WAVE") return { ext: ".wav" };
  if (brand && !HEIC_BRANDS.has(brand)) return { ext: ".m4a" };
  if (ascii(0, 4) === "fLaC") return { ext: ".flac" };
  if (ascii(0, 4) === "OggS") return { ext: ".ogg" };
  return undefined;
}

const HEIC_ELSEWHERE = "iPhone HEIC photos aren't supported here yet. In Photos, choose File › Export › Export 1 Photo, then pick JPEG.";

function unsupported(purpose: UploadPurpose): HttpError {
  const message =
    purpose === "photo"
      ? `Use a JPG, PNG${HEIC_SUPPORTED ? ", WebP or HEIC" : " or WebP"} photo.`
      : purpose === "edit"
        ? "That's not a video we can read. Use MP4, MOV, WEBM or MKV."
        : "That's not a track we can read. Use MP3, WAV, M4A, AAC, FLAC or OGG.";
  return new HttpError(415, message, "UNSUPPORTED_MEDIA");
}

function tooLarge(bytes: number, purpose: UploadPurpose): HttpError {
  const mb = Math.max(1, Math.round(bytes / MB));
  return new HttpError(413, `That file is ${mb} MB. ${PLURAL[purpose]} can be up to ${UPLOAD_LIMITS[purpose] / MB} MB.`, "TOO_LARGE");
}

/** The original file name as a label only: decoded, control characters removed, at most 80 characters. */
export function uploadLabel(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep it as sent.
  }
  name = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return name.slice(0, 80) || "upload";
}

/** The largest 1 s loudness rise of at least 6 dB, snapped to the nearest tracked beat (spec §11.4 step 3). */
export function findDrop(a: AudioAnalysis): number | undefined {
  const rise = loudnessRise(a.loudnessDb, 6);
  if (!rise) return undefined;
  const t = rise.timeSec;
  const beat = a.beats.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), a.beats[0] ?? t);
  return Math.round(beat * 1000) / 1000;
}

type Described = Pick<Upload, "kind" | "width" | "height" | "durationSec" | "fps" | "hasAudio" | "track">;

/** Checks a stored file against its purpose's rules (size, length, streams) and describes it. */
async function describe(file: string, purpose: UploadPurpose, checks: UploadCheck[]): Promise<Described> {
  let info: MediaInfo;
  try {
    info = await probe(file);
  } catch {
    throw unsupported(purpose);
  }
  if (purpose === "photo") {
    const w = info.video?.displayWidth ?? 0;
    const h = info.video?.displayHeight ?? 0;
    if (!w || !h) throw unsupported(purpose);
    const short = Math.min(w, h);
    if (short < 384) throw new HttpError(422, `This photo is too small (${w}×${h}). Use one at least 1024 px on the short side.`, "TOO_SMALL");
    if (short < 1024) checks.push({ id: "small", level: "warn", message: `Small photo (${w}×${h}). 1024 px or more on the short side keeps your likeness.` });
    if (Math.max(w, h) / short > 3) checks.push({ id: "wide", level: "warn", message: "Very wide photo. Crop it to the person." });
    return { kind: "image", width: w, height: h };
  }
  if (purpose === "edit") {
    if (!info.video?.frameCount) throw new HttpError(422, "We couldn't find any picture in that file.", "NO_VIDEO_STREAM");
    const d = info.durationSec;
    if (d > 60) throw new HttpError(422, `That edit is ${Math.round(d)} s long. Decode works on up to 60 s. Trim it to the part you love.`, "TOO_LONG");
    if (d < 2) throw new HttpError(422, "That's under 2 seconds, so there's no rhythm to copy yet.", "TOO_SHORT");
    if (!info.audio) checks.push({ id: "no-audio", level: "warn", message: "No sound in this clip. You'll add a track." });
    if (d > 30) checks.push({ id: "long", level: "warn", message: "Longer edits cost more for the director to study." });
    const fps = rationalValue(info.video.fps);
    return { kind: "video", width: info.video.displayWidth, height: info.video.displayHeight, durationSec: d, fps: Math.round(fps * 1000) / 1000, hasAudio: Boolean(info.audio) };
  }
  if (!info.audio) throw new HttpError(422, "We couldn't find any sound in that file.", "NO_AUDIO_STREAM");
  const d = info.audio.durationSec || info.durationSec;
  if (d < 10) throw new HttpError(422, "That track is under 10 seconds. Use one between 10 seconds and 10 minutes.", "TOO_SHORT");
  if (d > 600) throw new HttpError(422, `That track is ${Math.round(d / 60)} min long. Use one between 10 seconds and 10 minutes.`, "TOO_LONG");
  const a = await analyzeAudio(file);
  const dropSec = findDrop(a);
  return {
    kind: "audio",
    durationSec: d,
    track: { bpm: Math.round(a.tempoBpm * 10) / 10, confidence: Math.round(a.tempoConfidence * 100) / 100, ...(dropSec !== undefined ? { dropSec } : {}), durationSec: a.durationSec },
  };
}

/** meta.json: the Upload plus the stored file's name inside its folder. */
type UploadMeta = Upload & { file: string };

async function readMeta(id: string): Promise<UploadMeta | undefined> {
  if (!isId("upload", id)) return undefined;
  try {
    const meta = JSON.parse(await readFile(join(inboxDir(), id, "meta.json"), "utf8")) as UploadMeta;
    return meta.id === id && typeof meta.file === "string" && !/[\\/]/.test(meta.file) ? meta : undefined;
  } catch {
    return undefined;
  }
}

/** The request side of an upload: its headers and its body as chunks. */
export interface UploadRequest {
  headers: IncomingHttpHeaders;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

/**
 * Stores a raw request body as a staged upload: the length is checked before reading (411, 413), bytes are
 * counted while streaming (413 past the cap or the declared length), the type is sniffed (415) and the media
 * probed (422). Any failure, or the client going away, removes the upload's folder.
 */
export async function receiveUpload(req: UploadRequest): Promise<Upload> {
  const purpose = req.headers["x-katana-purpose"];
  if (purpose !== "photo" && purpose !== "edit" && purpose !== "music") throw new HttpError(400, "Say what the file is for with x-katana-purpose: photo, edit or music.", "BAD_PURPOSE");
  const length = req.headers["content-length"];
  if (length === undefined) throw new HttpError(411, "Send the file with a content-length header.", "LENGTH_REQUIRED");
  const declared = Number(length);
  if (!Number.isSafeInteger(declared) || declared < 0) throw new HttpError(400, "Bad content-length.", "BAD_LENGTH");
  if (declared === 0) throw new HttpError(400, "That file is empty.", "EMPTY");
  const cap = UPLOAD_LIMITS[purpose];
  if (declared > cap) throw tooLarge(declared, purpose);
  const name = uploadLabel(req.headers["x-katana-filename"]);

  const id = randomBytes(8).toString("hex");
  const dir = join(inboxDir(), id);
  await mkdir(dir, { recursive: true });
  try {
    const part = join(dir, ".part");
    const out = createWriteStream(part, { flags: "wx" });
    const hash = createHash("sha256");
    let head = Buffer.alloc(0);
    let size = 0;
    let type: ReturnType<typeof sniff>;
    try {
      for await (const value of req) {
        const chunk = value as Buffer;
        size += chunk.length;
        if (size > cap || size > declared) throw tooLarge(Math.max(size, declared), purpose);
        if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
        if (!type && head.length >= 64) {
          // Refuse the wrong kind of file as soon as its first bytes arrive.
          type = sniff(head, purpose);
          if (!type) throw unsupported(purpose);
        }
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, "drain");
      }
    } finally {
      out.end();
      await finished(out).catch(() => undefined);
    }
    if (size < declared) throw new HttpError(400, "The upload stopped before the whole file arrived.", "INCOMPLETE");
    type ??= sniff(head, purpose);
    if (!type) throw unsupported(purpose);

    const checks: UploadCheck[] = [];
    let file = join(dir, `media${type.ext}`);
    await rename(part, file);
    if (type.heic) {
      if (!HEIC_SUPPORTED) throw new HttpError(415, HEIC_ELSEWHERE, "HEIC_UNSUPPORTED");
      const jpg = join(dir, "media.jpg");
      try {
        await run("sips", ["-s", "format", "jpeg", file, "--out", jpg]);
      } catch {
        throw new HttpError(415, `We couldn't convert that HEIC photo. ${HEIC_ELSEWHERE.slice(HEIC_ELSEWHERE.indexOf("In Photos"))}`, "HEIC_FAILED");
      }
      await rm(file, { force: true });
      file = jpg;
      checks.push({ id: "heic-converted", level: "ok", message: "Converted from HEIC to JPEG." });
    }
    const described = await describe(file, purpose, checks);
    const upload: Upload = {
      id,
      purpose,
      name,
      bytes: (await stat(file)).size,
      url: `/uploads/${id}/media`,
      ...described,
      hash: hash.digest("hex"),
      checks,
      createdAt: new Date().toISOString(),
    };
    const meta: UploadMeta = { ...upload, file: file.slice(dir.length + 1) };
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return upload;
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

export async function readUpload(id: string): Promise<Upload | undefined> {
  const meta = await readMeta(id);
  if (!meta) return undefined;
  const { file: _file, ...upload } = meta;
  return upload;
}

/** The stored media file of an upload, when it exists. */
export async function uploadMediaPath(id: string): Promise<string | undefined> {
  const meta = await readMeta(id);
  const file = meta && join(inboxDir(), id, meta.file);
  return file && existsSync(file) ? file : undefined;
}

export async function deleteUpload(id: string): Promise<void> {
  if (isId("upload", id)) await rm(join(inboxDir(), id), { recursive: true, force: true });
}

/**
 * Moves a staged upload into the project's media folder and registers it, then removes it from the inbox.
 * Answers 422 when the upload is gone or was staged for another purpose.
 */
export async function moveUploadInto(ws: Workspace, uploadId: string, purpose: UploadPurpose, opts: { role: Role; id?: string }): Promise<void> {
  const meta = await readMeta(uploadId);
  if (!meta || !existsSync(join(inboxDir(), uploadId, meta.file))) throw new HttpError(422, "One of your files is no longer here. Add it again.", "UPLOAD_MISSING", { upload: uploadId });
  if (meta.purpose !== purpose) throw new HttpError(422, `That file was added as ${meta.purpose === "photo" ? "a photo" : meta.purpose === "edit" ? "an edit" : "a track"}.`, "UPLOAD_PURPOSE", { upload: uploadId });
  await mkdir(ws.path("media"), { recursive: true });
  const src = join(inboxDir(), uploadId, meta.file);
  const dest = ws.path("media", `${opts.id ?? opts.role}-${randomBytes(3).toString("hex")}${extname(meta.file)}`);
  try {
    await rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await copyFile(src, dest);
  }
  await ws.register({ path: dest, role: opts.role, id: opts.id, label: meta.name, source: "upload" });
  await rm(join(inboxDir(), uploadId), { recursive: true, force: true });
}

/**
 * Moves staged uploads into the project: photos as subjects in order (s1 = face), music as asset `music`.
 * `"<projectId>:<assetId>"` refs copy another project's subject photo or music (Make another). Call it inside
 * `withProject`.
 */
export async function takeUploads(ws: Workspace, refs: { photos: string[]; music?: string }): Promise<void> {
  const take = async (ref: string, purpose: "photo" | "music") => {
    const role: Role = purpose === "photo" ? "subject" : "audio";
    const id = purpose === "music" ? "music" : ws.nextAssetId("s");
    if (isId("upload", ref)) return moveUploadInto(ws, ref, purpose, { role, id });
    const [project, asset, extra] = ref.split(":");
    if (!project || !asset || extra !== undefined || !isId("project", project) || !isId("asset", asset)) throw new HttpError(400, `Bad media reference "${ref}".`, "BAD_REF");
    if (!existsSync(join(projectsRoot(), project, "project.json"))) throw new HttpError(422, "The edit those files came from is gone. Add them again.", "UPLOAD_MISSING", { upload: ref });
    const src = await Workspace.open(project);
    const a = src.project.assets.find((x) => x.id === asset);
    if (!a || a.role !== role) throw new HttpError(422, `There's no ${purpose === "photo" ? "photo" : "track"} "${asset}" in that edit.`, "UPLOAD_MISSING", { upload: ref });
    await ws.import(src.path(a.path), role, { id, label: a.label });
  };
  for (const ref of [...new Set(refs.photos)]) await take(ref, "photo");
  if (refs.music) await take(refs.music, "music");
}

/**
 * Imports a template's own track as asset `music` (role audio), the asset plan/brief.json and the prompt
 * name when the person keeps the template track. A no-op when the project already has `music`. Call it
 * inside `withProject`.
 */
export async function takeSoundtrack(ws: Workspace, preset: Pick<PresetEntry, "dir" | "soundtrack" | "title">): Promise<void> {
  if (ws.project.assets.some((a) => a.id === "music")) return;
  const file = soundtrackPath(preset);
  if (!file) throw new HttpError(422, "This template's track is missing. Add yours.", "PROBLEMS", { problems: [{ field: "music", message: "This template's track is missing. Add yours." }] });
  await ws.import(file, "audio", { id: "music", label: preset.soundtrack?.title ?? `${preset.title} track` });
}

/** Upload ids that a project's saved draft still names (they stay in the inbox). */
async function referencedUploads(): Promise<Set<string>> {
  const out = new Set<string>();
  if (!existsSync(projectsRoot())) return out;
  for (const id of await readdir(projectsRoot())) {
    try {
      const app = AppJsonSchema.parse(JSON.parse(await readFile(join(projectsRoot(), id, "app.json"), "utf8")));
      for (const ref of [...(app.draft?.photos ?? []), app.draft?.music ?? ""]) if (isId("upload", ref)) out.add(ref);
    } catch {
      // No app.json, or an unreadable one.
    }
  }
  return out;
}

/**
 * The startup sweep: removes uploads older than 7 days that no project draft references, and uploads that
 * never finished (a `.part` older than an hour).
 */
export async function sweepInbox(now = Date.now()): Promise<number> {
  if (!existsSync(inboxDir())) return 0;
  const keep = await referencedUploads();
  let removed = 0;
  for (const id of await readdir(inboxDir())) {
    if (!isId("upload", id)) continue;
    const dir = join(inboxDir(), id);
    const part = join(dir, ".part");
    const meta = await readMeta(id);
    const created = meta ? Date.parse(meta.createdAt) : (await stat(dir).catch(() => undefined))?.mtimeMs ?? now;
    const stale = existsSync(part)
      ? now - (await stat(part)).mtimeMs > PART_MAX_AGE_MS
      : meta
        ? now - created > INBOX_MAX_AGE_MS && !keep.has(id)
        : now - created > PART_MAX_AGE_MS;
    if (stale) {
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
