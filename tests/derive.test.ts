import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { probe } from "../src/engine/probe.js";
import { briefDefaults } from "../src/presets/brief.js";
import { deriveTemplate, NOT_TEMPLATABLE, SlugTakenError } from "../src/presets/derive.js";
import { listPresets, type PresetEntry, PresetSchema, savePreset } from "../src/presets/library.js";
import { Workspace } from "../src/project/workspace.js";
import { EdlSchema } from "../src/render/edl.js";
import { run } from "../src/util/proc.js";
import { makeReferenceEdit, tempDir } from "./helpers/synth.js";

let media: Record<"ref" | "photo" | "key" | "clipA" | "clipB" | "walk" | "matte" | "delivered" | "track", string>;

async function clip(out: string, color: string, seconds: number, audio = false): Promise<string> {
  await run("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=24:d=${seconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${seconds}`, "-c:a", "aac", "-shortest"] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

beforeAll(async () => {
  const dir = await tempDir("derive-");
  const still = join(dir, "photo.png");
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x886644:s=512x640", "-frames:v", "1", still]);
  const key = join(dir, "key.png");
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x335577:s=640x360", "-frames:v", "1", key]);
  const track = join(dir, "my-track.m4a");
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=6", "-c:a", "aac", track]);
  media = {
    ref: await makeReferenceEdit(dir),
    photo: still,
    key,
    clipA: await clip(join(dir, "a.mp4"), "0xcc2222", 1.5),
    clipB: await clip(join(dir, "b.mp4"), "0x22cc22", 1.5),
    walk: await clip(join(dir, "walk.mp4"), "0x2222cc", 1.5),
    matte: await clip(join(dir, "matte.mp4"), "white", 1.5),
    delivered: await clip(join(dir, "delivered.mp4"), "0x444444", 3, true),
    track,
  };
});

/** The cut of a decoded edit: two generated clips (one with a second take in a layer), a matte and the photo. */
function cut(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canvas: { width: 640, height: 360, fps: 24, durationSec: 3 },
    audio: { asset: "ref", offset: 0.5 },
    finish: { look: "teal-night", grain: 0.1 },
    shots: [
      { start: 0, end: "b2", source: { asset: "temple_t1", in: 0.2 }, layers: [{ source: { asset: "temple_t2" }, box: [0.6, 0.1, 0.3, 0.3] }] },
      { start: "b2", end: 2, source: { asset: "walk_t1", matte: "walk-matte_t1" }, camera: { punch: { at: ["b3"] } } },
      { start: 2, end: 3, source: { asset: "s1" } },
    ],
    flashes: [{ at: "b2", duration: 0.08 }],
    text: [
      { text: "NO", start: 0.2, end: 0.6, font: "Anton", uppercase: true },
      { text: "LIMITS", start: 0.6, end: 1.4, font: "Anton", uppercase: true },
      { text: "alone", start: 2.5, end: 3, font: "Playfair Display", italic: true, behind: true },
    ],
    sfx: [{ at: "b2", sound: "hit" }, { at: 2, sound: "ref" }],
    ...over,
  };
}

async function gen(ws: Workspace, id: string, line: string, src: string): Promise<void> {
  await mkdir(ws.path("gen", line), { recursive: true });
  const dest = ws.path("gen", line, `${id}${src.slice(src.lastIndexOf("."))}`);
  await copyFile(src, dest);
  await ws.register({ path: dest, role: "generated", id, lineId: line, jobId: id });
}

/** A decoded project with a delivered version (spec §11.7 fixture). */
async function decodedProject(o: { edl?: Record<string, unknown>; origin?: "decode" | "template"; delivered?: boolean; music?: boolean } = {}): Promise<Workspace> {
  const ws = await Workspace.create({ title: "My fav edit" });
  await ws.import(media.ref, "reference", { id: "ref" });
  await ws.import(media.photo, "subject", { id: "s1" });
  if (o.music) await ws.import(media.track, "audio", { id: "music" });
  await gen(ws, "temple-key_t1", "temple-key", media.key);
  await gen(ws, "temple_t1", "temple", media.clipA);
  await gen(ws, "temple_t2", "temple", media.clipB);
  await gen(ws, "walk_t1", "walk", media.walk);
  await gen(ws, "walk-matte_t1", "walk-matte", media.matte);
  const job = (id: string, line: string, profile: string, spec: Record<string, unknown>) => ({ id, line, take: 1, profile, backend: "http://127.0.0.1:8188", state: "completed", outputs: [id], spec: { line, takes: 1, ...spec } });
  await ws.writeJson("plan/jobs.json", [
    job("temple-key_t1", "temple-key", "qwen21-edit", { operation: "still.compose", prompt: "The person in image 1, chest-up, staring into the lens. Overcast light.", images: ["s1"] }),
    job("temple_t1", "temple", "wan22-14b-i2v", { operation: "clip.i2v", prompt: "Slow push-in, one blink.", start: "temple-key_t1" }),
    { ...job("temple_t2", "temple", "wan22-14b-i2v", { operation: "clip.i2v", prompt: "Slow push-in, one blink.", start: "temple-key_t1" }), take: 2 },
    job("walk_t1", "walk", "wan22-14b-i2v", { operation: "clip.i2v", prompt: "Walks toward the camera. Wind in the jacket.", images: ["s1"] }),
    job("walk-matte_t1", "walk-matte", "birefnet", { operation: "matte", prompt: "the person", start: "walk_t1" }),
  ]);
  await ws.writeJson("plan/plan.json", {
    concept: "An ordinary walk turns into a stare-down.",
    shots: [
      { at: "0-1", role: "open", description: "Chest-up stare into the lens.", route: "i2v", lines: ["temple-key", "temple"] },
      { at: "1-2", role: "walk", description: "Walks toward the camera, the word behind them.", route: "i2v", lines: ["walk", "walk-matte"] },
    ],
    jobs: [
      { line: "temple-key", operation: "still.compose", prompt: "The person in image 1, chest-up, staring into the lens. Overcast light.", images: ["s1"] },
      { line: "temple", operation: "clip.i2v", prompt: "Slow push-in, one blink.", start: "@temple-key" },
    ],
  });
  await ws.writeJson("analysis/audio.json", { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] });
  await ws.writeJson("analysis/energy.json", { summary: { cutsPerSecond: 1.1, meanShotSec: 0.9, flashesPerSecond: 0.3, shakeSeconds: 1, cameraMoveSeconds: 1, hitsPerSecond: 1, cutsOnBeatShare: 0.75 } });
  await ws.writeJson("analysis/decode.json", {
    project: ws.project.id, name: "my-fav-edit.mp4", videoUrl: "", status: "done", phases: [],
    shots: [{ index: 0, start: 0, end: 1, thumb: "", color: "#112233" }, { index: 1, start: 1, end: 3.5, thumb: "", color: "#aa8844" }],
    stats: { shots: 2, cuts: 1, flashes: 1, bpm: 120, cutsOnBeat: 0.75, cutsPerSec: 0.3, meanShotSec: 1.75, punches: 1, shakeSec: 1 },
    cutMap: { durationSec: 3.5, aspect: 16 / 9, shots: [], flashes: [], beats: [], downbeats: [], text: [], dropSec: 1 },
  });
  await ws.writeJson("render/edl.json", o.edl ?? cut());
  await ws.writeJson("app.json", { v: 1, origin: { kind: o.origin ?? "decode", sourceName: "my-fav-edit.mp4" }, runs: [], createdAt: new Date().toISOString() });
  if (o.delivered !== false) {
    await copyFile(media.delivered, ws.path("deliver", "my-fav-edit_v1.mp4"));
    ws.project.versions.push({ version: 1, path: "deliver/my-fav-edit_v1.mp4", createdAt: new Date().toISOString() });
    await ws.save();
  }
  return ws;
}

const filled = (p: PresetEntry) => JSON.parse(JSON.stringify(p.skeleton).replace(/"slot:[a-z0-9_-]+"/g, '"black"'));

describe("save as template (deriveTemplate)", () => {
  let entry: PresetEntry;
  let project: string;

  beforeAll(async () => {
    const ws = await decodedProject();
    project = ws.project.id;
    const res = await deriveTemplate(ws, { title: "My Stare", slug: "my-stare", description: "" });
    if (!res.ok) throw new Error(res.reasons.join(" "));
    entry = res.entry;
  });

  it("saves a local template that passes the preset and EDL schemas", async () => {
    expect(entry.source).toBe("user");
    expect(PresetSchema.safeParse(entry).success).toBe(true);
    expect(EdlSchema.safeParse(filled(entry)).success).toBe(true);
    expect(entry.origin).toMatchObject({ kind: "decoded", project });
    expect(entry.inputs.music).toBe("optional");
    expect(entry.format).toEqual({ aspect: "16:9", durationSec: 3, fps: 24 });
    expect(entry.description).toBe("Your cut of my-fav-edit.mp4, saved as a template.");
    expect((await listPresets()).find((p) => p.slug === "my-stare")?.source).toBe("user");
  });

  it("turns generated shots, takes, mattes and the photo into slots the skeleton uses", () => {
    expect(entry.slots.map((s) => s.id).sort()).toEqual(["photo", "temple", "walk", "walk-matte"]);
    const used = new Set([...JSON.stringify(entry.skeleton).matchAll(/"slot:([a-z0-9_-]+)"/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(["photo", "temple", "walk", "walk-matte"]);
    const temple = entry.slots.find((s) => s.id === "temple")!;
    expect(temple).toMatchObject({ kind: "clip", description: "Chest-up stare into the lens.", operation: "still.compose → clip.i2v (wan22-14b-i2v)" });
    expect(temple.guidance).toBe("The person in image 1, chest-up, staring into the lens. Overcast light. Motion: Slow push-in, one blink.");
    expect(entry.slots.find((s) => s.id === "walk")).toMatchObject({ kind: "clip", operation: "clip.i2v (wan22-14b-i2v)", guidance: "Walks toward the camera. Wind in the jacket." });
    expect(entry.slots.find((s) => s.id === "walk-matte")).toMatchObject({ kind: "clip", operation: "matte (birefnet)" });
    expect(entry.slots.find((s) => s.id === "photo")).toMatchObject({ kind: "still", description: "The person's photo, shown as is" });
    // Both takes of "temple" fill the same slot; the matte follows its clip.
    const sk = entry.skeleton as { shots: { source: { asset: string; matte?: string }; layers?: { source: { asset: string } }[] }[] };
    expect(sk.shots[0]!.source.asset).toBe("slot:temple");
    expect(sk.shots[0]!.layers![0]!.source.asset).toBe("slot:temple");
    expect(sk.shots[1]!.source).toMatchObject({ asset: "slot:walk", matte: "slot:walk-matte" });
  });

  it("keeps the timing exactly as cut, on the template's own soundtrack", () => {
    const sk = entry.skeleton as {
      shots: { end: unknown; camera?: { punch?: { at: unknown[] } } }[];
      flashes: { at: unknown }[];
      canvas: { durationSec?: number };
      audio: unknown;
      sfx: unknown;
    };
    // No grid: beat times followed this edit's sound, so they are frozen to seconds (b2 = 1.0 s after the 0.5 s offset).
    expect(JSON.stringify(sk)).not.toMatch(/"b\d/);
    expect(sk.shots[0]!.end).toBe(1);
    expect(sk.shots[1]!.camera?.punch?.at).toEqual([1.5]);
    expect(sk.flashes[0]!.at).toBe(1);
    expect(sk.canvas.durationSec).toBe(3);
    expect(sk.audio).toEqual({ asset: "music", offset: 0 });
    // Built-in sound effects travel with the template; ones made from project media don't.
    expect(sk.sfx).toEqual([{ at: 1, sound: "hit" }]);
    expect(entry.timing).toBeUndefined();
  });

  it("labels the original sound as third-party and bundles it with the example, poster and cut map", async () => {
    expect(entry.soundtrack).toEqual({ file: "soundtrack.m4a", title: "Original sound", licence: "third-party: from the original video, not yours to publish", bpm: 120, dropSec: 0.5 });
    for (const f of ["soundtrack.m4a", "example.mp4", "poster.jpg", "cutmap.json"]) expect(existsSync(join(entry.dir, f)), f).toBe(true);
    const track = await probe(join(entry.dir, "soundtrack.m4a"));
    expect(track.video).toBeUndefined();
    expect(track.durationSec).toBeGreaterThan(2.5); // from 0.5 s to the end of the 3.5 s original
    const example = await probe(join(entry.dir, "example.mp4"));
    expect(example.video?.height).toBe(360); // never upscaled past the edit
    expect(entry.example).toMatchObject({ video: "example.mp4", poster: "poster.jpg", models: ["wan22-14b-i2v", "qwen21-edit", "birefnet"] });
    expect(entry.example!.credit).toBe("Made from your edit. Keyframes: Qwen-Image 2.1. Clips: Wan 2.2 I2V A14B. Cut-outs: BiRefNet background removal. Sound: from the original video.");
    const map = JSON.parse(readFileSync(join(entry.dir, "cutmap.json"), "utf8"));
    expect(entry.cutmap).toBe("cutmap.json");
    expect(map.shots.map((s: { slot?: string }) => s.slot)).toEqual(["temple", "walk", "photo"]);
    for (const s of map.shots) {
      expect(s.thumb).toBeUndefined();
      expect(s.color).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("makes the words the brief's defaults, grouped by how close the cards sit", () => {
    expect(entry.brief.map((f) => ({ id: f.id, label: f.label, kind: f.kind, default: f.default, binds: f.binds.map((b) => b.index) }))).toEqual([
      { id: "card1", label: "Cards at 0:00", kind: "words", default: ["NO", "LIMITS"], binds: [0, 1] },
      { id: "card2", label: "Card at 0:02", kind: "text", default: "alone", binds: [2] },
    ]);
    const defaults = briefDefaults(entry.brief);
    const text = (entry.skeleton as { text: { text: string }[] }).text;
    expect([...(defaults.card1 as string[]), defaults.card2]).toEqual(text.map((t) => t.text));
    for (const f of entry.brief) for (const v of [f.default].flat()) expect(String(v).length).toBeLessThanOrEqual(f.maxChars!);
    expect(entry.display).toEqual({ font: "Anton", weight: 400, italic: false, case: "upper", color: "#FFFFFF" });
  });

  it("writes a recipe from the cut, the decode and the plan", () => {
    expect(entry.recipe.look).toBe("teal-night grade, grain 0.1");
    expect(entry.recipe.fonts).toEqual(["Anton", "Playfair Display"]);
    expect(entry.recipe.palette).toEqual(["#112233", "#AA8844"]);
    expect(entry.recipe.energy).toBe("Measured on the original: 1.1 cuts per second (mean shot 0.90 s), 75% of cuts on the beat, 0.30 flashes per second, 1.0 s of shake.");
    expect(entry.recipe.structure).toEqual([
      { at: "0-1", role: "open", guidance: "Chest-up stare into the lens." },
      { at: "1-2", role: "walk", guidance: "Walks toward the camera, the word behind them." },
    ]);
    expect(entry.prompt).toBe("An ordinary walk turns into a stare-down.");
  });

  it("refuses an edit that shows frames of the original video", async () => {
    const withRef = cut({ shots: [{ start: 0, end: 1, source: { asset: "ref", in: 1 } }, { start: 1, end: 3, source: { asset: "walk_t1" } }] });
    const res = await deriveTemplate(await decodedProject({ edl: withRef }), { title: "Nope", slug: "nope-ref", description: "" });
    expect(res).toEqual({ ok: false, reasons: [NOT_TEMPLATABLE.refFrames] });

    const ws = await decodedProject({ edl: cut({ shots: [{ start: 0, end: 3, source: { asset: "walk_t1" }, layers: [{ source: { asset: "ref_f12" } }] }] }) });
    const frame = ws.path("media", "ref_f12.png");
    await copyFile(media.key, frame);
    await ws.register({ path: frame, role: "style", id: "ref_f12", label: "ref frame 12" });
    expect(await deriveTemplate(ws, { title: "Nope", slug: "nope-frame", description: "" })).toEqual({ ok: false, reasons: [NOT_TEMPLATABLE.refFrames] });
    expect(existsSync(join(entry.dir, "..", "nope-ref"))).toBe(false);
  });

  it("explains what is missing before an edit can become a template", async () => {
    const ws = await decodedProject({ origin: "template", delivered: false, edl: cut({ audio: null }) });
    const res = await deriveTemplate(ws, { title: "Nope", slug: "nope-early", description: "" });
    expect(res).toEqual({ ok: false, reasons: [NOT_TEMPLATABLE.notDecoded, NOT_TEMPLATABLE.notDelivered, NOT_TEMPLATABLE.sound] });
  });

  it("keeps the person's own track as theirs", async () => {
    const ws = await decodedProject({ music: true, edl: cut({ audio: { asset: "music", offset: 0 }, grid: { bpm: 120, phase: 0 } }) });
    const res = await deriveTemplate(ws, { title: "My Track Cut", slug: "my-track-cut", description: "Mine." });
    if (!res.ok) throw new Error(res.reasons.join(" "));
    expect(res.entry.soundtrack).toEqual({ file: "soundtrack.m4a", title: "my-track", licence: "yours", bpm: 120 });
    expect(res.entry.example!.credit).toMatch(/Sound: your track\.$/);
    // With a grid the beat times stay beats and the tempo becomes the template's.
    expect((res.entry.skeleton as { shots: { end: unknown }[] }).shots[0]!.end).toBe("b2");
    expect(res.entry.timing).toEqual({ nominalBpm: 120 });
    expect(res.entry.description).toBe("Mine.");
  });

  it("refuses a slug that already names a template", async () => {
    const ws = await decodedProject();
    await expect(deriveTemplate(ws, { title: "Hype", slug: "hype-energy", description: "" })).rejects.toBeInstanceOf(SlugTakenError);
    await expect(deriveTemplate(ws, { title: "Again", slug: "my-stare", description: "" })).rejects.toMatchObject({ code: "SLUG_TAKEN" });
  });
});

describe("savePreset extra files", () => {
  it("copies only plain file names into the preset folder", async () => {
    const base = PresetSchema.parse({ slug: "extra-files", title: "Extra", description: "x", category: "style_transfer" });
    for (const name of ["../evil.mp4", "a/b.jpg", "preset.json", ".hidden.jpg", "noext"]) {
      await expect(savePreset(base, { extra: { [name]: media.key } }), name).rejects.toThrow(/can't be a preset file name/);
    }
    const entry = await savePreset({ ...base, example: { poster: "poster.png", credit: "x", models: [] } }, { extra: { "poster.png": media.key } });
    expect(existsSync(join(entry.dir, "poster.png"))).toBe(true);
  });
});
