import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/app/router.js";
import type { Upload } from "../src/app/types.js";
import { inboxDir, readUpload, receiveUpload, sniff, sweepInbox, takeUploads, uploadLabel } from "../src/app/uploads.js";
import { Workspace } from "../src/project/workspace.js";
import { Studio } from "../src/studio/server.js";
import { run } from "../src/util/proc.js";
import { makeReferenceEdit, tempDir } from "./helpers/synth.js";

const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(64)]);

describe("sniffing", () => {
  it("knows each accepted type by its first bytes", () => {
    expect(sniff(pad(bytes([0xff, 0xd8, 0xff, 0xe0])), "photo")).toEqual({ ext: ".jpg" });
    expect(sniff(pad(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a])), "photo")).toEqual({ ext: ".png" });
    expect(sniff(pad(bytes("RIFF", [0, 0, 0, 0], "WEBP")), "photo")).toEqual({ ext: ".webp" });
    expect(sniff(pad(bytes([0, 0, 0, 0x18], "ftypheic")), "photo")).toEqual({ ext: ".heic", heic: true });
    expect(sniff(pad(bytes([0, 0, 0, 0x18], "ftypmif1")), "photo")).toEqual({ ext: ".heic", heic: true });
    expect(sniff(pad(bytes([0, 0, 0, 0x20], "ftypisom")), "edit")).toEqual({ ext: ".mp4" });
    expect(sniff(pad(bytes([0, 0, 0, 0x14], "ftypqt  ")), "edit")).toEqual({ ext: ".mov" });
    expect(sniff(pad(bytes([0, 0, 0, 0x1c], "ftypM4V ")), "edit")).toEqual({ ext: ".m4v" });
    expect(sniff(pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], "webm")), "edit")).toEqual({ ext: ".webm" });
    expect(sniff(pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], "matroska")), "edit")).toEqual({ ext: ".mkv" });
    expect(sniff(pad(bytes("ID3", [4, 0])), "music")).toEqual({ ext: ".mp3" });
    expect(sniff(pad(bytes([0xff, 0xfb, 0x90, 0x64])), "music")).toEqual({ ext: ".mp3" });
    expect(sniff(pad(bytes([0xff, 0xf1, 0x50, 0x80])), "music")).toEqual({ ext: ".aac" });
    expect(sniff(pad(bytes([0xff, 0xf9, 0x50, 0x80])), "music")).toEqual({ ext: ".aac" });
    expect(sniff(pad(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")), "music")).toEqual({ ext: ".wav" });
    expect(sniff(pad(bytes([0, 0, 0, 0x20], "ftypM4A ")), "music")).toEqual({ ext: ".m4a" });
    expect(sniff(pad(bytes("fLaC")), "music")).toEqual({ ext: ".flac" });
    expect(sniff(pad(bytes("OggS")), "music")).toEqual({ ext: ".ogg" });
  });

  it("refuses a type the purpose doesn't take, whatever the name says", () => {
    const png = pad(bytes([0x89], "PNG"));
    const mp4 = pad(bytes([0, 0, 0, 0x20], "ftypisom"));
    expect(sniff(png, "edit")).toBeUndefined();
    expect(sniff(png, "music")).toBeUndefined();
    expect(sniff(mp4, "photo")).toBeUndefined();
    expect(sniff(pad(bytes([0, 0, 0, 0x18], "ftypheic")), "edit")).toBeUndefined();
    expect(sniff(pad(bytes("RIFF", [0, 0, 0, 0], "WAVE")), "photo")).toBeUndefined();
    expect(sniff(pad(bytes("#!/bin/sh\necho hi\n")), "photo")).toBeUndefined();
    expect(sniff(pad(bytes("<html>")), "edit")).toBeUndefined();
  });

  it("keeps the file name as a label only", () => {
    expect(uploadLabel(encodeURIComponent("me front.jpg"))).toBe("me front.jpg");
    expect(uploadLabel("a\u0007b\nc.png")).toBe("abc.png");
    expect(uploadLabel("%zz.png")).toBe("%zz.png");
    expect(uploadLabel(undefined)).toBe("upload");
    expect(uploadLabel("x".repeat(200))).toHaveLength(80);
  });
});

/** A fake request: headers plus a body stream, for the parts of receiveUpload HTTP can't reach. */
const fakeRequest = (headers: Record<string, string>, chunks: Buffer[]) => Object.assign(Readable.from(chunks), { headers });

const inboxEntries = () => (existsSync(inboxDir()) ? readdirSync(inboxDir()) : []);

describe("uploads", () => {
  let studio: Studio;
  let base: string;
  const media: Record<string, string> = {};

  beforeAll(async () => {
    const dir = await tempDir("ok-uploads-");
    const still = async (name: string, size: string) => {
      const file = join(dir, name);
      await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${size}`, "-frames:v", "1", file]);
      return file;
    };
    media.photo = await still("me-front.png", "1200x1600");
    media.small = await still("small.jpg", "600x800");
    media.tiny = await still("tiny.png", "300x400");
    media.wide = await still("wide.png", "3400x1100");
    media.edit = await makeReferenceEdit(dir);
    media.silent = join(dir, "silent.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", media.silent]);
    media.short = join(dir, "short.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=24", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", media.short]);
    media.long = join(dir, "long.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=2", "-t", "62", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", media.long]);
    media.track = join(dir, "track.wav");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=exprs='0.8*sin(2*PI*880*t)*exp(-60*mod(t\\,0.5))':s=22050:d=12", media.track]);
    media.jingle = join(dir, "jingle.wav");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=4", media.jingle]);
    studio = new Studio();
    await studio.start(0);
    base = `http://127.0.0.1:${studio.port}`;
  }, 120_000);

  afterAll(async () => {
    await studio?.stop();
  });

  const send = async (file: string | Buffer, purpose: string, name = typeof file === "string" ? file.split("/").at(-1)! : "file.bin") => {
    const body = typeof file === "string" ? await readFile(file) : file;
    const res = await fetch(`${base}/api/uploads`, {
      method: "POST",
      headers: { "x-katana": "1", "content-type": "application/octet-stream", "x-katana-filename": encodeURIComponent(name), "x-katana-purpose": purpose },
      body: new Uint8Array(body),
    });
    return { status: res.status, body: (await res.json()) as Upload & { error?: string; code?: string } };
  };

  it("stores a photo with its size and no warnings", async () => {
    const { status, body } = await send(media.photo!, "photo");
    expect(status).toBe(201);
    expect(body).toMatchObject({ purpose: "photo", name: "me-front.png", kind: "image", width: 1200, height: 1600, url: `/uploads/${body.id}/media`, checks: [] });
    expect(body.id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await readUpload(body.id)).toEqual(body);
    const part = await fetch(`${base}/uploads/${body.id}/media`, { headers: { range: "bytes=0-7" } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer())[1]).toBe(0x50);
    expect((await fetch(`${base}/api/uploads/${body.id}`)).status).toBe(200);
    expect((await fetch(`${base}/api/uploads/${body.id}`, { method: "DELETE", headers: { "x-katana": "1" } })).status).toBe(204);
    expect((await fetch(`${base}/api/uploads/${body.id}`)).status).toBe(404);
    expect((await fetch(`${base}/uploads/${body.id}/media`)).status).toBe(404);
  });

  it("warns about small and wide photos and refuses tiny ones", async () => {
    const small = await send(media.small!, "photo");
    expect(small.status).toBe(201);
    expect(small.body.checks).toEqual([{ id: "small", level: "warn", message: "Small photo (600×800). 1024 px or more on the short side keeps your likeness." }]);
    const wide = await send(media.wide!, "photo");
    expect(wide.body.checks.map((c) => c.id)).toEqual(["wide"]);
    expect(wide.body.checks[0]!.message).toBe("Very wide photo. Crop it to the person.");
    const before = inboxEntries().length;
    const tiny = await send(media.tiny!, "photo");
    expect(tiny.status).toBe(422);
    expect(tiny.body.error).toBe("This photo is too small (300×400). Use one at least 1024 px on the short side.");
    expect(inboxEntries()).toHaveLength(before);
  });

  it("refuses a spoofed extension with 415 and keeps nothing", async () => {
    const before = inboxEntries().length;
    const fake = await send(Buffer.from("#!/bin/sh\nrm -rf ~\n".repeat(10)), "photo", "me.jpg");
    expect(fake.status).toBe(415);
    expect(fake.body.error).toMatch(/^Use a JPG, PNG/);
    const pngAsEdit = await send(media.photo!, "edit", "edit.mp4");
    expect(pngAsEdit.status).toBe(415);
    expect(pngAsEdit.body.error).toBe("That's not a video we can read. Use MP4, MOV, WEBM or MKV.");
    expect(inboxEntries()).toHaveLength(before);
  });

  it.runIf(process.platform === "darwin")("converts an iPhone HEIC photo to JPEG on macOS", async () => {
    const heic = join(await tempDir("ok-heic-"), "IMG_0001.HEIC");
    await run("sips", ["-s", "format", "heic", media.photo!, "--out", heic]);
    const { status, body } = await send(heic, "photo");
    expect(status).toBe(201);
    expect(body).toMatchObject({ kind: "image", width: 1200, height: 1600, name: "IMG_0001.HEIC" });
    expect(body.checks).toEqual([{ id: "heic-converted", level: "ok", message: "Converted from HEIC to JPEG." }]);
    expect(readdirSync(join(inboxDir(), body.id)).sort()).toEqual(["media.jpg", "meta.json"]);
  });

  it("names the file by its type, never by what it was called", async () => {
    const { status, body } = await send(media.photo!, "photo", "../../evil\u0007.png");
    expect(status).toBe(201);
    expect(body.name).toBe("../../evil.png");
    expect(readdirSync(join(inboxDir(), body.id)).sort()).toEqual(["media.png", "meta.json"]);
    expect(existsSync(join(inboxDir(), "..", "..", "evil.png"))).toBe(false);
  });

  it("checks edits: length, picture and sound", async () => {
    const edit = await send(media.edit!, "edit");
    expect(edit.status).toBe(201);
    expect(edit.body).toMatchObject({ kind: "video", width: 640, height: 360, fps: 24, hasAudio: true, checks: [] });
    expect(edit.body.durationSec).toBeCloseTo(3.5, 1);
    const silent = await send(media.silent!, "edit");
    expect(silent.status).toBe(201);
    expect(silent.body.hasAudio).toBe(false);
    expect(silent.body.checks).toEqual([{ id: "no-audio", level: "warn", message: "No sound in this clip. You'll add a track." }]);
    const short = await send(media.short!, "edit");
    expect(short.status).toBe(422);
    expect(short.body.error).toBe("That's under 2 seconds, so there's no rhythm to copy yet.");
    const long = await send(media.long!, "edit");
    expect(long.status).toBe(422);
    expect(long.body.error).toBe("That edit is 62 s long. Decode works on up to 60 s. Trim it to the part you love.");
  }, 60_000);

  it("finds the beat of a track", async () => {
    const track = await send(media.track!, "music");
    expect(track.status).toBe(201);
    expect(track.body.kind).toBe("audio");
    expect(track.body.track!.bpm).toBeGreaterThan(115);
    expect(track.body.track!.bpm).toBeLessThan(125);
    expect(track.body.track!.durationSec).toBeCloseTo(12, 0);
    const jingle = await send(media.jingle!, "music");
    expect(jingle.status).toBe(422);
    expect(jingle.body.error).toBe("That track is under 10 seconds. Use one between 10 seconds and 10 minutes.");
  }, 60_000);

  /** A raw request, for the cases fetch always gets right (content-length, partial bodies). */
  const raw = (headers: Record<string, string | number>, write: (req: ReturnType<typeof request>) => void) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: studio.port, method: "POST", path: "/api/uploads", headers: { "x-katana": "1", "x-katana-purpose": "photo", ...headers } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      });
      req.on("error", reject);
      write(req);
    });

  it("needs a content-length (411)", async () => {
    const r = await raw({ "transfer-encoding": "chunked" }, (req) => {
      req.write(Buffer.alloc(100));
      req.end();
    });
    expect(r.status).toBe(411);
  });

  it("refuses an oversized length before reading the body (413)", async () => {
    let req!: ReturnType<typeof request>;
    const r = await raw({ "content-length": 400 * 1024 * 1024 }, (q) => {
      req = q;
      q.flushHeaders();
    });
    req.destroy();
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).error).toBe("That file is 400 MB. Photos can be up to 30 MB.");
  });

  it("counts bytes while streaming: a body longer than it said is refused and removed", async () => {
    const before = inboxEntries().length;
    const png = await readFile(media.photo!);
    const lying = fakeRequest({ "x-katana-purpose": "photo", "content-length": "2000", "x-katana-filename": "a.png" }, [png.subarray(0, 1500), png.subarray(1500, 3000)]);
    await expect(receiveUpload(lying)).rejects.toMatchObject({ status: 413 });
    const pastCap = fakeRequest({ "x-katana-purpose": "music", "content-length": String(50 * 1024 * 1024) }, [Buffer.from("ID3"), Buffer.alloc(50 * 1024 * 1024)]);
    await expect(receiveUpload(pastCap)).rejects.toBeInstanceOf(HttpError);
    expect(inboxEntries()).toHaveLength(before);
  });

  it("removes the folder of an upload the client abandons", async () => {
    const before = inboxEntries().length;
    const png = await readFile(media.photo!);
    let req!: ReturnType<typeof request>;
    const settled = raw({ "content-length": 4 * 1024 * 1024, "x-katana-filename": "big.png" }, (q) => {
      req = q;
      q.write(png.subarray(0, 64 * 1024));
    }).catch(() => undefined);
    // The upload's folder appears once the first bytes arrive …
    for (let i = 0; i < 50 && inboxEntries().length === before; i++) await new Promise((r) => setTimeout(r, 20));
    expect(inboxEntries().length).toBe(before + 1);
    req.destroy();
    await settled;
    // … and goes when the client does.
    for (let i = 0; i < 100 && inboxEntries().length > before; i++) await new Promise((r) => setTimeout(r, 20));
    expect(inboxEntries()).toHaveLength(before);
  });

  it("moves uploads into a project in order, and copies them for Make another", async () => {
    const upload = async (file: string, purpose: string) => {
      const body = await readFile(file);
      return receiveUpload(fakeRequest({ "x-katana-purpose": purpose, "content-length": String(body.length), "x-katana-filename": file.split("/").at(-1)! }, [body]));
    };
    const face = await upload(media.photo!, "photo");
    const body = await upload(media.small!, "photo");
    const track = await upload(media.track!, "music");
    const ws = await Workspace.create({ title: "take uploads" });
    await takeUploads(ws, { photos: [face.id, body.id], music: track.id });
    expect(ws.subjects().map((a) => [a.id, a.label])).toEqual([
      ["s1", "me-front.png"],
      ["s2", "small.jpg"],
    ]);
    expect(ws.asset("music")).toMatchObject({ role: "audio", kind: "audio", label: "track.wav" });
    for (const u of [face, body, track]) expect(await readUpload(u.id)).toBeUndefined();
    await expect(takeUploads(ws, { photos: [face.id] })).rejects.toMatchObject({ status: 422, code: "UPLOAD_MISSING" });

    const again = await Workspace.create({ title: "make another" });
    await takeUploads(again, { photos: [`${ws.project.id}:s1`, `${ws.project.id}:s2`], music: `${ws.project.id}:music` });
    expect(again.subjects().map((a) => a.id)).toEqual(["s1", "s2"]);
    expect(again.asset("music").role).toBe("audio");
    expect(existsSync(again.assetPath("s1"))).toBe(true);
    // Only a photo or a track can be borrowed, and only by a well-formed reference.
    await expect(takeUploads(again, { photos: [`${ws.project.id}:music`] })).rejects.toMatchObject({ status: 422 });
    await expect(takeUploads(again, { photos: ["../x:s1"] })).rejects.toMatchObject({ status: 400 });
  }, 60_000);

  it("sweeps old and abandoned uploads but keeps ones a draft names", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const entry = async (id: string, createdAt: number, part = false) => {
      const dir = join(inboxDir(), id);
      await mkdir(dir, { recursive: true });
      if (part) {
        await writeFile(join(dir, ".part"), "x");
        await utimes(join(dir, ".part"), new Date(createdAt), new Date(createdAt));
      } else {
        await writeFile(join(dir, "media.png"), "x");
        await writeFile(join(dir, "meta.json"), JSON.stringify({ id, file: "media.png", createdAt: new Date(createdAt).toISOString() }));
      }
    };
    await entry("aaaaaaaaaaaaaaa1", now - 8 * day);
    await entry("aaaaaaaaaaaaaaa2", now - 8 * day);
    await entry("aaaaaaaaaaaaaaa3", now - 2 * day);
    await entry("aaaaaaaaaaaaaaa4", now - 2 * 60 * 60 * 1000, true);
    await entry("aaaaaaaaaaaaaaa5", now - 5 * 60 * 1000, true);
    const ws = await Workspace.create({ title: "draft keeps uploads" });
    const draft = { kind: "template", template: "hype-energy", photos: ["aaaaaaaaaaaaaaa2"], musicChoice: "mine", alignDrop: true, mode: "remix", brief: {}, planFirst: false, commercial: false, clipsModel: "configured" };
    await ws.writeJson("app.json", { v: 1, origin: { kind: "template", template: "hype-energy" }, draft, runs: [], createdAt: new Date().toISOString() });
    await sweepInbox(now);
    const left = new Set(inboxEntries());
    expect(left.has("aaaaaaaaaaaaaaa1")).toBe(false);
    expect(left.has("aaaaaaaaaaaaaaa2")).toBe(true);
    expect(left.has("aaaaaaaaaaaaaaa3")).toBe(true);
    expect(left.has("aaaaaaaaaaaaaaa4")).toBe(false);
    expect(left.has("aaaaaaaaaaaaaaa5")).toBe(true);
  });
});
