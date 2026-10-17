import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { probe } from "../engine/probe.js";
import { dataHome } from "../util/paths.js";

export const MODES = ["remix", "recreate", "clip"] as const;
export type Mode = (typeof MODES)[number];

export const STAGES = ["intake", "analyzed", "reviewed", "planned", "generating", "assembling", "rendered", "delivered"] as const;
export type Stage = (typeof STAGES)[number];

export const ROLES = ["reference", "subject", "footage", "audio", "style", "generated", "render"] as const;
export type Role = (typeof ROLES)[number];

export const AssetSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "video", "audio"]),
  role: z.enum(ROLES),
  path: z.string(),
  source: z.string().optional(),
  label: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationSec: z.number().optional(),
  fps: z.number().optional(),
  frameCount: z.number().optional(),
  hasAudio: z.boolean().optional(),
  jobId: z.string().optional(),
  lineId: z.string().optional(),
  createdAt: z.string(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: z.enum(MODES),
  preset: z.string().optional(),
  instructions: z.string().optional(),
  stage: z.enum(STAGES),
  createdAt: z.string(),
  updatedAt: z.string(),
  assets: z.array(AssetSchema),
  /** Every-frame review: page number → check code reported by the agent. */
  reviewedPages: z.record(z.string(), z.string()).default({}),
  versions: z.array(z.object({ version: z.number(), path: z.string(), createdAt: z.string(), note: z.string().optional() })).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".gif"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

export function projectsRoot(): string {
  return join(dataHome(), "projects");
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "edit"
  );
}

export function kindForPath(path: string): Asset["kind"] {
  const ext = extname(path.split("?")[0] ?? "").toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  throw new Error(`Unsupported media type "${ext || "none"}" for ${path}. Use JPEG/PNG/WebP images, MP4/MOV/WebM video or MP3/WAV/M4A audio.`);
}

/** The pending write per file: writes to one file run one after another, in call order. */
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Replaces a file atomically: the text goes to a uniquely named temp file that is then renamed over it.
 * Calls for the same file are queued in call order, so readers never see a partial file and the last call wins.
 */
export function writeFileAtomic(file: string, text: string): Promise<void> {
  const key = resolve(file);
  const write = (pendingWrites.get(key) ?? Promise.resolve()).then(async () => {
    const tmp = `${key}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(key), { recursive: true });
      await writeFile(tmp, text);
      await rename(tmp, key);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  });
  // A failed write still lets the next one run; the queue entry goes once the file is idle.
  const settled = write.catch(() => undefined);
  pendingWrites.set(key, settled);
  void settled.then(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
  return write;
}

/** A project directory with typed accessors for its records. */
export class Workspace {
  private constructor(
    readonly dir: string,
    public project: Project,
  ) {}

  static async create(opts: { title: string; mode?: Mode; preset?: string; instructions?: string; root?: string }): Promise<Workspace> {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
    const id = `${stamp}-${slugify(opts.title)}-${randomBytes(2).toString("hex")}`;
    const dir = join(opts.root ?? projectsRoot(), id);
    for (const sub of ["media", "analysis", "plan", "gen", "qa", "render", "deliver"]) await mkdir(join(dir, sub), { recursive: true });
    const project: Project = {
      id,
      title: opts.title,
      mode: opts.mode ?? "remix",
      preset: opts.preset,
      instructions: opts.instructions,
      stage: "intake",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      assets: [],
      reviewedPages: {},
      versions: [],
    };
    const ws = new Workspace(dir, project);
    await ws.save();
    return ws;
  }

  /** Opens a project by id (under the projects root) or by directory path. */
  static async open(idOrDir: string, root = projectsRoot()): Promise<Workspace> {
    const dir = existsSync(join(idOrDir, "project.json")) ? resolve(idOrDir) : join(root, idOrDir);
    const file = join(dir, "project.json");
    if (!existsSync(file)) throw new Error(`No open-katana project "${idOrDir}". Use katana_start to create one, or katana_status with no project to list them.`);
    const project = ProjectSchema.parse(JSON.parse(await readFile(file, "utf8")));
    return new Workspace(dir, project);
  }

  static async list(root = projectsRoot()): Promise<Project[]> {
    if (!existsSync(root)) return [];
    const out: Project[] = [];
    for (const id of await readdir(root)) {
      const file = join(root, id, "project.json");
      if (!existsSync(file)) continue;
      try {
        out.push(ProjectSchema.parse(JSON.parse(await readFile(file, "utf8"))));
      } catch {
        // Skip unreadable projects rather than failing the whole listing.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  rel(abs: string): string {
    return relative(this.dir, abs);
  }

  /** Writes project.json. Saves are queued per file, so overlapping saves from tools and jobs never collide. */
  async save(): Promise<void> {
    this.project.updatedAt = new Date().toISOString();
    await writeFileAtomic(this.path("project.json"), JSON.stringify(this.project, null, 2));
  }

  async setStage(stage: Stage): Promise<void> {
    // Stages only move forward, except that new plans or renders can follow a delivery.
    if (STAGES.indexOf(stage) > STAGES.indexOf(this.project.stage) || stage === "planned" || stage === "rendered") {
      this.project.stage = stage;
      await this.save();
    }
  }

  async readJson<T>(rel: string, schema?: z.ZodType<T>): Promise<T | undefined> {
    const file = this.path(rel);
    if (!existsSync(file)) return undefined;
    const data = JSON.parse(await readFile(file, "utf8"));
    return schema ? schema.parse(data) : (data as T);
  }

  async writeJson(rel: string, data: unknown): Promise<string> {
    const file = this.path(rel);
    await writeFileAtomic(file, JSON.stringify(data, null, 2));
    return file;
  }

  /** Looks up an asset; "ref" always means the project's reference video. */
  asset(id: string): Asset {
    const a = this.project.assets.find((x) => x.id === id) ?? (id === "ref" ? this.reference() : undefined);
    if (!a) throw new Error(`No asset "${id}" in project ${this.project.id}. Known: ${this.project.assets.map((x) => x.id).join(", ") || "none"}.`);
    return a;
  }

  assetPath(id: string): string {
    return this.path(this.asset(id).path);
  }

  reference(): Asset | undefined {
    return this.project.assets.find((a) => a.role === "reference" && a.kind === "video");
  }

  subjects(): Asset[] {
    return this.project.assets.filter((a) => a.role === "subject");
  }

  nextAssetId(prefix: string): string {
    let n = 1;
    while (this.project.assets.some((a) => a.id === `${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  /** Registers a file already inside the project directory. Probes media metadata. */
  async register(opts: { path: string; role: Role; id?: string; label?: string; source?: string; jobId?: string; lineId?: string }): Promise<Asset> {
    const kind = kindForPath(opts.path);
    const id = opts.id ?? this.nextAssetId(opts.role === "subject" ? "s" : opts.role === "generated" ? "g" : opts.role === "reference" ? "ref" : opts.role.slice(0, 3));
    const asset: Asset = {
      id,
      kind,
      role: opts.role,
      path: this.rel(resolve(opts.path)),
      source: opts.source,
      label: opts.label,
      jobId: opts.jobId,
      lineId: opts.lineId,
      createdAt: new Date().toISOString(),
    };
    const info = await probe(opts.path);
    if (info.video) {
      asset.width = info.video.displayWidth;
      asset.height = info.video.displayHeight;
      if (kind === "video") {
        asset.durationSec = info.durationSec;
        asset.fps = info.video.fps.den ? info.video.fps.num / info.video.fps.den : undefined;
        asset.frameCount = info.video.frameCount;
        asset.hasAudio = Boolean(info.audio);
      }
    } else if (kind === "audio") {
      asset.durationSec = info.durationSec;
    }
    if (kind === "video" && !info.video) throw new Error(`${opts.path} has no video stream`);
    this.project.assets = this.project.assets.filter((a) => a.id !== id).concat(asset);
    await this.save();
    return asset;
  }

  /** Copies a local file or downloads a URL into media/ and registers it. */
  async import(source: string, role: Role, opts: { id?: string; label?: string } = {}): Promise<Asset> {
    const kind = kindForPath(source);
    if (role === "reference" && kind !== "video") throw new Error("The reference must be a video.");
    const name = `${opts.id ?? role}-${randomBytes(3).toString("hex")}${extname(source.split("?")[0] ?? "").toLowerCase()}`;
    const dest = this.path("media", name);
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${source}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_IMPORT_BYTES) throw new Error(`${source} is larger than 500 MB.`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_IMPORT_BYTES) throw new Error(`${source} is larger than 500 MB.`);
      await writeFile(dest, bytes);
    } else {
      const abs = resolve(source);
      if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
      await copyFile(abs, dest);
    }
    return this.register({ path: dest, role, id: opts.id, label: opts.label ?? basename(source.split("?")[0] ?? source), source });
  }
}
