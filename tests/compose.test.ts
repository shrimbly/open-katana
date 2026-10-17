import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cutsOnGrid, gridFromCuts } from "../src/engine/audio.js";
import { textToAss } from "../src/render/ass.js";
import { type Edl, EdlSchema, gridBeats, TextSchema } from "../src/render/edl.js";
import { renderEdl, type SourceInfo } from "../src/render/render.js";
import { run } from "../src/util/proc.js";
import { tempDir } from "./helpers/synth.js";

const W = 160;
const H = 90;
const FPS = 24;

let dir: string;
let sources: Record<string, SourceInfo>;

/** RGB of pixel (x, y) in frame `frame` of a video. */
async function pixel(file: string, frame: number, x: number, y: number): Promise<[number, number, number]> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

async function render(name: string, edl: unknown): Promise<string> {
  const parsed = EdlSchema.parse(edl);
  const out = join(dir, `${name}.mp4`);
  await renderEdl(parsed, { source: (id) => sources[id]!, beats: [], outPath: out, cacheDir: join(dir, "cache") });
  return out;
}

const base = (shots: unknown[], extra: Partial<Edl> = {}) => ({ canvas: { width: W, height: H, fps: FPS }, audio: null, shots, ...extra });
const near = (a: number, b: number, tol = 24) => Math.abs(a - b) <= tol;

describe("compositing and new effects", () => {
  beforeAll(async () => {
    dir = await tempDir("ok-compose-");
    // A still: red left half, blue right half. A matte: white disc on black.
    const split = join(dir, "split.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=${W / 2}x${H}`, "-f", "lavfi", "-i", `color=c=blue:s=${W / 2}x${H}`, "-filter_complex", "[0][1]hstack", "-frames:v", "1", split]);
    const matte = join(dir, "matte.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-vf", `format=gray,geq=lum='255*lte(hypot(X-${W / 2},Y-${H / 2}),${H / 3})'`, "-frames:v", "1", matte]);
    const grey = join(dir, "grey.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x999999:s=${W}x${H}`, "-frames:v", "1", grey]);
    const teal = join(dir, "teal.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x24302F:s=${W}x${H}`, "-frames:v", "1", teal]);
    sources = { split: { path: split, kind: "image" }, matte: { path: matte, kind: "image" }, grey: { path: grey, kind: "image" }, teal: { path: teal, kind: "image" } };
  }, 60_000);

  it("draws a tinted flash only while it lasts", async () => {
    const out = await render("tint", base([{ start: 0, end: 1, source: { asset: "black" } }], { flashes: [{ at: 0.5, duration: 0.25, color: "#FF0000" }] } as never));
    const [r0, g0] = await pixel(out, 4, 80, 45);
    const [r1, g1, b1] = await pixel(out, 12, 80, 45);
    expect(r0).toBeLessThan(20);
    expect(g0).toBeLessThan(20);
    expect(r1).toBeGreaterThan(200);
    expect(g1 + b1).toBeLessThan(60);
  }, 60_000);

  it("composites a layer into its box from its start time", async () => {
    const out = await render("layer", base([{ start: 0, end: 1, source: { asset: "black" }, layers: [{ source: { asset: "white" }, box: [0.5, 0, 0.5, 1], start: 0.5 }] }]));
    expect((await pixel(out, 4, 120, 45))[0]).toBeLessThan(20);
    expect((await pixel(out, 18, 120, 45))[0]).toBeGreaterThan(230);
    expect((await pixel(out, 18, 40, 45))[0]).toBeLessThan(20);
  }, 60_000);

  it("mirrors alternate tiles", async () => {
    const out = await render("tiles", base([{ start: 0, end: 0.5, source: { asset: "split" }, tile: { cols: 2, rows: 1, mirror: "alternate" } }]));
    const at = async (x: number) => {
      const [r, , b] = await pixel(out, 6, x, 45);
      return r > b ? "red" : "blue";
    };
    expect([await at(10), await at(70), await at(90), await at(150)]).toEqual(["red", "blue", "blue", "red"]);
  }, 60_000);

  it("masks to a circle and replaces the background behind a matte", async () => {
    const masked = await render("mask", base([{ start: 0, end: 0.5, source: { asset: "white" }, fx: { mask: { shape: "circle", size: [0.6, 0.6], feather: 0 } } }]));
    expect((await pixel(masked, 6, 80, 45))[0]).toBeGreaterThan(230);
    expect((await pixel(masked, 6, 3, 3))[0]).toBeLessThan(20);
    const keyed = await render("bg", base([{ start: 0, end: 0.5, source: { asset: "split", matte: "matte" }, background: "#00FF00" }]));
    const [r, g] = await pixel(keyed, 6, 3, 3);
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
    const centre = await pixel(keyed, 6, 70, 45);
    expect(centre[0]).toBeGreaterThan(180);
  }, 60_000);

  it("maps tones: duotone, threshold and tint", async () => {
    const duo = await render("duo", base([{ start: 0, end: 0.5, source: { asset: "white" }, fx: { duotone: { shadow: "#000000", highlight: "#00FF00" } } }]));
    const [r, g, b] = await pixel(duo, 6, 80, 45);
    expect(near(g, 255, 30) && r < 40 && b < 40).toBe(true);
    const hi = await render("th-hi", base([{ start: 0, end: 0.5, source: { asset: "grey" }, fx: { threshold: 0.4 } }]));
    const lo = await render("th-lo", base([{ start: 0, end: 0.5, source: { asset: "grey" }, fx: { threshold: 0.8 } }]));
    expect((await pixel(hi, 6, 80, 45))[0]).toBeGreaterThan(240);
    expect((await pixel(lo, 6, 80, 45))[0]).toBeLessThan(15);
    const tint = await render("tint-fx", base([{ start: 0, end: 0.5, source: { asset: "white" }, fx: { tint: { color: "#0000FF", amount: 1 } } }]));
    const t = await pixel(tint, 6, 80, 45);
    expect(t[2]).toBeGreaterThan(200);
    expect(t[0]).toBeLessThan(40);
  }, 60_000);

  it("keeps the hue of a glowing shot", async () => {
    const out = await render("glow", base([{ start: 0, end: 0.5, source: { asset: "teal" }, fx: { glow: 0.8 } }]));
    const [r, g, b] = await pixel(out, 6, 80, 45);
    // A dim teal frame stays teal (it used to turn magenta when the screen blend ran in YUV).
    expect(g).toBeGreaterThan(r + 10);
    expect(b).toBeGreaterThan(r + 5);
  }, 60_000);

  it("animates blur, keeps one colour and blends a screen layer", async () => {
    const keep = await render("keep", base([{ start: 0, end: 0.5, source: { asset: "split" }, fx: { keepColor: { color: "#FF0000", similarity: 0.2 } } }]));
    const red = await pixel(keep, 6, 20, 45);
    const blue = await pixel(keep, 6, 140, 45);
    expect(red[0] - red[2]).toBeGreaterThan(150);
    expect(Math.abs(blue[0] - blue[2])).toBeLessThan(30);
    const screen = await render("screen", base([{ start: 0, end: 0.5, source: { asset: "split" }, layers: [{ source: { asset: "white" }, box: [0, 0, 0.25, 1], blend: "screen", opacity: 1 }] }]));
    expect((await pixel(screen, 6, 10, 45))[1]).toBeGreaterThan(230);
    expect((await pixel(screen, 6, 140, 45))[2]).toBeGreaterThan(200);
    const blurred = await render("blur", base([{ start: 0, end: 1, source: { asset: "split" }, fx: { blur: [0, 30], motionBlur: { amount: 4 } } }]));
    // At the edge between the halves the picture is sharp at the start and smeared at the end.
    const early = await pixel(blurred, 0, 76, 45);
    const late = await pixel(blurred, 23, 76, 45);
    expect(early[0]).toBeGreaterThan(late[0]);
  }, 90_000);
});

describe("everything at once", () => {
  it("renders a shot using every layer move, mask, leak and text option in one graph", async () => {
    const out = await render("kitchen-sink", {
      ...base([
        {
          start: 0,
          end: 1,
          source: { asset: "split", matte: "matte" },
          camera: { zoom: [1, 1.1], panFrom: [0.05, 0], pan: [-0.05, 0], overscan: 1.2 },
          fx: { zoomBlur: 0.4, invert: 0.3, frameStrobe: { every: 6, on: 1 }, leak: { side: "right", amount: 0.5 }, vignette: 0.5, glow: 0.4, glowColor: "#FFAA00", posterize: 4 },
          layers: [
            { source: { asset: "grey" }, box: [0.6, 0.1, 0.3, 0.4], shape: "circle", border: { width: 0.02 }, enter: { type: "pop", duration: 0.3 }, exit: { type: "fade", duration: 0.2 } },
            { source: { asset: "split" }, box: [0, 0.6, 0.4, 0.4], border: { width: 0.01, color: "#FFFFFF", bottom: 0.04 }, shadow: 0.8, enter: { type: "slide-right", duration: 0.25 }, start: 0.2 },
            { source: { asset: "split", matte: "matte" }, key: true, box: [0.3, 0, 1, 1], opacity: 0.6 },
            { window: true, box: [0.4, 0.4, 0.2, 0.2], boxTo: [0.5, 0.3], feather: 0.2, fx: { invert: true } },
            { source: { asset: "white" }, box: [0, 0, 1, 0.2], blend: "multiply", exit: { type: "slide-up", duration: 0.3 } },
          ],
        },
        { start: 1, end: 1.5, source: { asset: "split" }, fx: { mask: { shape: "circle", size: [0.4, 0.4], sizeTo: 2, centerTo: [0.3, 0.5] } }, tile: { cols: 3, rows: 2, mirror: "all", offset: 0.1, stagger: 0.05, gap: 0.02, enter: "pop" } },
      ]),
      flashes: [{ at: 0.4, duration: 0.1, color: "#F3EACD", overText: true }, { at: 1.2, duration: 0.1, color: "white" }],
      text: [
        { text: "GLITCH", start: 0.1, end: 0.9, anim: "glitch", exit: "blur", weight: 700, font: "Montserrat", opacity: 0.8 },
        { text: "ITALIC", start: 1, end: 1.5, italic: true, font: "Playfair Display", exit: "shrink", size: 0.2 },
      ],
    });
    const { stdout } = await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out]);
    expect(Number(stdout.toString().trim())).toBe(36);
  }, 120_000);
});

describe("text options", () => {
  const ev = (o: Record<string, unknown>) => [{ event: TextSchema.parse({ text: "GO", start: 0, end: 1, ...o }), startSec: 0, endSec: 1 }];
  it("writes opacity, weight, exits and glitch copies", () => {
    expect(textToAss(ev({ opacity: 0.5 }), 1920, 1080)).toContain("\\1a&H80&");
    expect(textToAss(ev({ weight: 700 }), 1920, 1080)).toContain("\\b700");
    expect(textToAss(ev({ exit: "fade", anim: "none" }), 1920, 1080)).toMatch(/\\fad\(0,220\)/);
    const glitch = textToAss(ev({ anim: "glitch" }), 1920, 1080).split("\n").filter((l) => l.startsWith("Dialogue"));
    expect(glitch.filter((l) => l.includes("\\1c&H4000FF&")).length).toBe(6);
    expect(glitch.at(-1)).toMatch(/^Dialogue: 1,0:00:00\.24,0:00:01\.00/);
  });
});

describe("beat grids", () => {
  it("builds a fixed grid and recovers an edit's tempo from its cuts", () => {
    const beats = gridBeats({ bpm: 120, phase: 0.25 }, 4);
    expect(beats.slice(0, 3)).toEqual([0.25, 0.75, 1.25]);
    // Cuts on a 144 BPM grid (some on half beats), plus a couple of off-grid ones.
    const period = 60 / 144;
    const cuts = [1, 2, 3, 4.5, 6, 7, 8, 9.5, 11, 12, 14, 15, 16.5, 18].map((k) => 0.5 + k * period).concat([3.333, 5.71]);
    const grid = gridFromCuts(cuts, 108, 30)!;
    expect(grid.bpm).toBeGreaterThan(142);
    expect(grid.bpm).toBeLessThan(146);
    expect(cutsOnGrid(cuts, gridBeats({ bpm: grid.bpm, phase: grid.phase }, 10), 1.5 / 30)).toBeGreaterThan(0.8);
  });
});
