#!/usr/bin/env node
// Builds a built-in template's bundled media (spec §15.4 step 4): the example video, its poster and cut map
// from a delivered project, and the template's own soundtrack. Edits presets/<slug>/preset.json in place,
// touching only the keys it sets, and checks the size budgets that tests/presets.test.ts enforces.
//
//   node scripts/build-examples.mjs <slug> --project <id|dir> --credit "<line>" [--version <n>] [--models a,b]
//        [--poster-at <sec>] [--height 720]
//   node scripts/build-examples.mjs <slug> --soundtrack <file> --title "<title>" --licence "<licence>"
//        [--artist "<name>"] [--drop <sec>] [--grid keep|auto|<bpm>[@<phase>]] [--shift <sec>]
//   node scripts/build-examples.mjs --check
//
// The two forms combine; add the soundtrack first so the poster can find the drop of a freestyle template.
//
// --soundtrack copies the track to presets/<slug>/soundtrack.m4a (remuxed without metadata, or encoded to AAC
// when it isn't AAC), sets `soundtrack` and flips `inputs.music` to "optional". A music.json next to the file
// (keyed by slug, `drop_in_edit` in seconds) gives the intended drop. The grid: `keep` (default when the
// skeleton has one) checks the track against it; `auto` (default when the skeleton has none) fits one to the
// track's beats with `timing.dropBeat` on its drop; `<bpm>@<phase>` sets it. `--shift <sec>` trims that much
// from the track's start (negative: pads it with silence) to line its hits up with a kept grid; the script
// suggests the value. `--dry-run` writes nothing, `--presets <dir>` works on another presets folder.
//
// Needs ffmpeg and the repo's dev dependencies (the TypeScript sources are loaded through tsx).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MB = 2 ** 20;
/** Keep in step with MEDIA_BUDGET in src/presets/derive.ts. */
const BUDGET = { example: 3.5 * MB, poster: 200 * 1024, soundtrack: MB, cutmap: 20 * 1024, total: 30 * MB };
const CRF_STEPS = [26, 28, 30, 32];

// ---------- JSON text edits (the presets are hand-formatted; keep every untouched byte) ----------

/** End offset of the JSON value starting at `i`. */
function skipValue(text, i) {
  const c = text[i];
  if (c === '"') {
    for (i++; text[i] !== '"'; i += text[i] === "\\" ? 2 : 1) if (i >= text.length) throw new Error("unterminated string");
    return i + 1;
  }
  if (c === "{" || c === "[") {
    let depth = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') i = skipValue(text, i) - 1;
      else if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && --depth === 0) return i + 1;
    }
    throw new Error("unbalanced JSON");
  }
  const m = /^[^,\]}\s]+/.exec(text.slice(i, i + 64));
  if (!m) throw new Error(`bad JSON at ${i}`);
  return i + m[0].length;
}

/** The direct members of the object whose "{" is at `open`: key, and where its key and value sit. */
export function members(text, open) {
  const out = [];
  let i = open + 1;
  const space = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  for (;;) {
    space();
    if (text[i] === "}") return out;
    if (text[i] === ",") {
      i++;
      continue;
    }
    const keyStart = i;
    i = skipValue(text, i);
    const key = JSON.parse(text.slice(keyStart, i));
    space();
    i++; // ":"
    space();
    const valueStart = i;
    i = skipValue(text, i);
    out.push({ key, keyStart, valueStart, valueEnd: i });
  }
}

/** Offset of the "{" of the object at `path` (keys from the root object). */
export function objectAt(text, path) {
  let open = text.indexOf("{");
  for (const key of path) {
    const m = members(text, open).find((x) => x.key === key);
    if (!m || text[m.valueStart] !== "{") throw new Error(`no object at ${path.join(".")}`);
    open = m.valueStart;
  }
  return open;
}

/** JSON in the presets' style: a value on one line (with spaces) when it fits, else one member per line. */
export function pretty(value, indent = 0, width = 110) {
  const flat = inline(value);
  if (value === null || typeof value !== "object" || flat.length + indent <= width) return flat;
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(value)) return `[\n${value.map((v) => pad + pretty(v, indent + 2, width)).join(",\n")}\n${close}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${pad}${JSON.stringify(k)}: ${pretty(v, indent + 2, width)}`).join(",\n")}\n${close}}`;
}

function inline(value) {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length ? `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

/** Sets member `key` of the object at `open`: replaces its value, or inserts it after the first of `after` present (else last). */
export function setMember(text, open, key, value, { after = [] } = {}) {
  const ms = members(text, open);
  const first = ms[0];
  const multiline = first ? text.slice(open, first.keyStart).includes("\n") : false;
  const indent = multiline ? text.slice(text.lastIndexOf("\n", first.keyStart) + 1, first.keyStart) : "";
  const body = pretty(value, indent.length);
  const hit = ms.find((m) => m.key === key);
  if (hit) return text.slice(0, hit.valueStart) + body + text.slice(hit.valueEnd);
  const anchor = after.map((k) => ms.find((m) => m.key === k)).find(Boolean) ?? ms.at(-1);
  if (!anchor) return `${text.slice(0, open + 1)} ${JSON.stringify(key)}: ${body} ${text.slice(open + 1)}`;
  const sep = multiline ? `,\n${indent}` : ", ";
  return text.slice(0, anchor.valueEnd) + sep + JSON.stringify(key) + ": " + body + text.slice(anchor.valueEnd);
}

// ---------- helpers ----------

const ts = async (rel) => {
  const { tsImport } = await import("tsx/esm/api");
  return tsImport(pathToFileURL(join(ROOT, rel)).href, import.meta.url);
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
/** Scratch folders, removed on exit whatever happens. */
const temps = [];
process.on("exit", () => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "ok-examples-"));
  temps.push(dir);
  return dir;
};
const fail = (msg) => {
  process.stderr.write(`build-examples: ${msg}\n`);
  process.exit(1);
};

/** Bytes of every media file each preset declares, and the total. */
function budgets(presetsDir) {
  const rows = [];
  for (const slug of readdirSync(presetsDir)) {
    const file = join(presetsDir, slug, "preset.json");
    if (!existsSync(file)) continue;
    const p = JSON.parse(readFileSync(file, "utf8"));
    const declared = [["example", p.example?.video], ["poster", p.example?.poster], ["soundtrack", p.soundtrack?.file], ["cutmap", p.cutmap]];
    for (const [kind, name] of declared) {
      if (!name) continue;
      const path = join(presetsDir, slug, name);
      const bytes = existsSync(path) ? statSync(path).size : -1;
      rows.push({ slug, kind, name, bytes, ok: bytes >= 0 && bytes <= BUDGET[kind] });
    }
  }
  const total = rows.reduce((s, r) => s + Math.max(0, r.bytes), 0);
  return { rows, total, ok: rows.every((r) => r.ok) && total <= BUDGET.total };
}

function printBudgets(b) {
  for (const r of b.rows) console.log(`  ${r.ok ? "ok  " : "OVER"} ${r.slug}/${r.name} ${r.bytes < 0 ? "missing" : kb(r.bytes)} (budget ${kb(BUDGET[r.kind])})`);
  console.log(`  ${b.total <= BUDGET.total ? "ok  " : "OVER"} total ${(b.total / MB).toFixed(1)} MB (budget ${BUDGET.total / MB} MB)`);
}

/** The largest 1 s loudness rise (≥ 6 dB) in the track, snapped to the nearest tracked beat (spec §11.4 step 3). */
function detectDrop(audio) {
  const L = audio.loudnessDb;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  let best;
  for (let i = 10; i + 10 <= L.length; i++) {
    const rise = mean(L.slice(i, i + 10)) - mean(L.slice(i - 10, i));
    if (rise >= 6 && (!best || rise > best.rise)) best = { rise, t: i * 0.1 };
  }
  if (!best) return undefined;
  const beat = nearest(audio.beats, best.t);
  return { sec: beat !== undefined && Math.abs(beat - best.t) <= 0.25 ? beat : best.t, rise: best.rise };
}

const nearest = (list, t) => list.reduce((b, x) => (b === undefined || Math.abs(x - t) < Math.abs(b - t) ? x : b), undefined);

/** Least-squares tempo of the tracked beats, folded by ×2 / ×½ to the side of `target`. */
function fitTempo(audio, target) {
  const b = audio.beats;
  let bpm = audio.tempoBpm;
  if (b.length >= 8) {
    const n = b.length;
    const mx = (n - 1) / 2;
    const my = b.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    b.forEach((y, x) => {
      num += (x - mx) * (y - my);
      den += (x - mx) ** 2;
    });
    bpm = 60 / (num / den);
  }
  while (bpm < target / Math.SQRT2) bpm *= 2;
  while (bpm > target * Math.SQRT2) bpm /= 2;
  return bpm;
}

/**
 * Where the track's hits sit against a grid: the onset energy folded on the half beat (cuts land on beats
 * and half beats; the beat tracker can lock onto either), peak in seconds, in [-period/4, period/4).
 * Positive means the music comes after the grid.
 */
function onsetOffset(onsets, grid, durationSec, fromSec = 0) {
  const half = 60 / grid.bpm / 2;
  const BIN = 0.005;
  const bins = Math.max(8, Math.round(half / BIN));
  const h = new Array(bins).fill(0);
  onsets.env.forEach((v, i) => {
    const t = i * onsets.step;
    if (t < fromSec || t > durationSec) return;
    const ph = (((t - grid.phase) % half) + half) % half;
    h[Math.floor((ph / half) * bins) % bins] += v;
  });
  let peak = 0;
  let best = -1;
  for (let i = 0; i < bins; i++) {
    const v = h[(i + bins - 1) % bins] + h[i] + h[(i + 1) % bins];
    if (v > best) {
      best = v;
      peak = i;
    }
  }
  const off = ((peak + 0.5) / bins) * half;
  return off >= half / 2 ? off - half : off;
}

// ---------- soundtrack ----------

async function addSoundtrack(o) {
  const { analyzeSamples, decodeMono, onsetEnvelope, AUDIO_RATE } = await ts("src/engine/audio.ts");
  const { probe } = await ts("src/engine/probe.ts");
  const { gridBeats } = await ts("src/render/edl.ts");
  const src = resolve(o.file);
  if (!existsSync(src)) fail(`no file ${src}`);
  if (!o.title) fail("--soundtrack needs --title (shown as the template track's name)");
  if (!o.licence) fail('--soundtrack needs --licence (e.g. "MIT, original instrumental")');
  const srcInfo = await probe(src);
  if (!srcInfo.audio) fail(`${src} has no audio stream`);
  const p = o.preset;
  const sk = p.skeleton;
  const shift = o.shift ?? 0;

  // Encode first (a shift trims the head or pads it with silence), then measure what will ship.
  const out = join(o.dir, "soundtrack.m4a");
  const tmp = join(await scratch(), "soundtrack.m4a");
  const copy = srcInfo.audio.codec === "aac" && !shift;
  await run("ffmpeg", [
    "-v", "error", "-y", ...(shift > 0 ? ["-ss", String(shift)] : []), "-i", src, "-vn", "-map", "0:a:0",
    ...(shift < 0 ? ["-af", `adelay=${Math.round(-shift * 1000)}:all=1`] : []),
    ...(copy ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]), "-map_metadata", "-1", "-movflags", "+faststart", tmp,
  ]);
  const size = statSync(tmp).size;
  if (size > BUDGET.soundtrack) fail(`the soundtrack is ${kb(size)}; the budget is ${kb(BUDGET.soundtrack)}. Trim it to the edit's length plus 1 s.`);
  const info = await probe(tmp);
  const samples = await decodeMono(tmp);
  const audio = analyzeSamples(samples);
  const onsets = { env: onsetEnvelope(samples), step: 256 / AUDIO_RATE };
  const target = sk?.grid?.bpm ?? p.timing?.nominalBpm ?? 120;
  const bpm = fitTempo(audio, target);
  const steady = audio.tempoConfidence >= 0.25 && audio.beats.length >= 8;
  console.log(`track: ${basename(src)}${shift ? ` shifted ${shift > 0 ? "earlier" : "later"} by ${Math.abs(shift)} s` : ""} · ${info.durationSec.toFixed(1)} s · ${bpm.toFixed(2)} BPM (confidence ${audio.tempoConfidence.toFixed(2)}, ${audio.beats.length} beats)`);
  if (info.durationSec < (p.format.durationSec ?? 0)) console.warn(`  warning: the track (${info.durationSec.toFixed(1)} s) is shorter than the edit (${p.format.durationSec} s)`);

  // The drop: given, else measured near the intended one (music.json), else intended, else measured.
  const metaFile = join(dirname(src), "music.json");
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8"))[p.slug] : undefined;
  const intended = typeof meta?.drop_in_edit === "number" ? meta.drop_in_edit - shift : undefined;
  const measured = detectDrop(audio);
  let drop = o.drop;
  if (drop === undefined) drop = measured && (intended === undefined || Math.abs(measured.sec - intended) <= 1) ? measured.sec : intended;
  console.log(`drop: ${drop === undefined ? "none" : `${drop.toFixed(2)} s`}${measured ? ` (measured ${measured.sec.toFixed(2)} s, +${measured.rise.toFixed(1)} dB)` : ""}${intended !== undefined ? ` (intended ${round(intended, 2)} s)` : ""}`);

  // The grid the skeleton's beat times follow.
  const mode = o.grid ?? (sk?.grid ? "keep" : sk ? "auto" : "none");
  let grid = sk?.grid;
  if (mode === "auto") {
    if (!sk) fail("--grid auto needs a skeleton template");
    if (!steady) fail("no steady beat in this track: pass --grid <bpm>@<phase>");
    const period = 60 / bpm;
    const dropBeat = p.timing?.dropBeat;
    // Beat `dropBeat` on the tracked beat at the drop, else beat 0 on the first tracked beat; then onto the hits.
    const anchor = drop !== undefined ? nearest(audio.beats, drop) : undefined;
    let phase = dropBeat !== undefined && anchor !== undefined && Math.abs(anchor - drop) <= period / 2 ? anchor - dropBeat * period : audio.beats[0];
    phase += Math.max(-period / 8, Math.min(period / 8, onsetOffset(onsets, { bpm, phase }, p.format.durationSec ?? info.durationSec)));
    if (phase < 0) fail(`the drop (${drop.toFixed(2)} s) comes before beat ${dropBeat} can land on it: pad the track's start with --shift -${round(-phase + 0.05, 2)}`);
    grid = { bpm: round(bpm, 2), phase: round(phase, 3) };
  } else if (mode !== "keep" && mode !== "none") {
    const m = /^(\d+(?:\.\d+)?)(?:@(\d+(?:\.\d+)?))?$/.exec(mode);
    if (!m) fail(`--grid takes keep, auto or <bpm>[@<phase>], not "${mode}"`);
    grid = { bpm: Number(m[1]), phase: Number(m[2] ?? audio.beats[0] ?? 0) };
  }
  if (grid) {
    const off = onsetOffset(onsets, grid, p.format.durationSec ?? info.durationSec);
    const frame = 1 / p.format.fps;
    console.log(`grid: ${grid.bpm} BPM, beat 0 at ${grid.phase} s (${mode}) · the track's hits sit ${Math.round(off * 1000)} ms ${off >= 0 ? "after" : "before"} it`);
    if (Math.abs(Math.log2(bpm / grid.bpm)) > 0.02) console.warn(`  warning: the track is ${bpm.toFixed(2)} BPM but the grid is ${grid.bpm} BPM`);
    if (mode === "keep" && Math.abs(off) > frame) console.warn(`  warning: that is more than a frame; line the track up with --shift ${round(shift + off, 3)}`);
    const len = p.format.durationSec ?? info.durationSec;
    const early = onsetOffset(onsets, grid, len / 3);
    const late = onsetOffset(onsets, grid, len, (2 * len) / 3);
    if (Math.abs(late - early) > frame) console.warn(`  warning: the hits drift from ${Math.round(early * 1000)} ms to ${Math.round(late * 1000)} ms off the grid over the edit: the track's tempo isn't the grid's`);
    const dropBeat = p.timing?.dropBeat;
    if (dropBeat !== undefined && drop !== undefined) {
      const at = grid.phase + (dropBeat * 60) / grid.bpm;
      console.log(`  beat ${dropBeat} (the template's drop) lands at ${at.toFixed(2)} s, ${Math.round((drop - at) * 1000)} ms from the track's drop`);
    }
  }

  let text = o.text;
  const soundtrack = { file: "soundtrack.m4a", title: o.title, artist: o.artist, licence: o.licence, bpm: steady || grid ? round(grid?.bpm ?? bpm, 1) : undefined, dropSec: drop !== undefined ? round(drop, 2) : undefined };
  text = setMember(text, objectAt(text, []), "soundtrack", Object.fromEntries(Object.entries(soundtrack).filter(([, v]) => v !== undefined)), { after: ["timing", "display", "inputs"] });
  text = setMember(text, objectAt(text, ["inputs"]), "music", "optional");
  if (sk && grid && mode !== "keep" && mode !== "none") {
    text = setMember(text, objectAt(text, ["skeleton"]), "grid", grid, { after: ["canvas"] });
    // A new grid moves every beat time: end the edit where its last shot now ends, never in black.
    const { EdlSchema, checkEdl } = await ts("src/render/edl.ts");
    const edl = EdlSchema.parse(JSON.parse(JSON.stringify({ ...sk, grid }).replace(/"slot:[a-z0-9_-]+"/g, '"black"')));
    const ends = checkEdl({ ...edl, canvas: { ...edl.canvas, durationSec: undefined } }, { fps: edl.canvas.fps, beats: gridBeats(grid, 600) });
    const fps = edl.canvas.fps;
    for (const w of ends.warnings.filter((x) => /no frames|Gap/.test(x))) console.warn(`  warning: on this grid: ${w}`);
    if (ends.warnings.some((x) => /no frames/.test(x))) console.warn("  (a negative --shift starts the music later, which moves beat 0 and every beat with it)");
    const end = Math.round(ends.durationSec * fps) / fps;
    if (sk.canvas?.durationSec && end < sk.canvas.durationSec - 0.5 / fps) {
      const sec = round(end, 3);
      text = setMember(text, objectAt(text, ["skeleton", "canvas"]), "durationSec", sec);
      text = setMember(text, objectAt(text, ["format"]), "durationSec", sec);
      console.log(`  the last shot now ends at ${sec} s: the edit's length is set to it (was ${sk.canvas.durationSec} s)`);
    }
  }
  return { text, files: [[tmp, out]] };
}

// ---------- example ----------

async function addExample(o) {
  const { Workspace } = await ts("src/project/workspace.ts");
  const { EdlSchema, checkEdl, resolveTime } = await ts("src/render/edl.ts");
  const { edlBeats } = await ts("src/project/render-project.ts");
  const { encodeExample, extractPoster, posterTime, templateCutMap } = await ts("src/presets/derive.ts");
  const { probe } = await ts("src/engine/probe.ts");
  const { profile } = await ts("src/comfy/operations.ts");
  const p = o.preset;
  const ws = await Workspace.open(o.project);
  if (ws.project.preset && ws.project.preset !== p.slug) console.warn(`  warning: project ${ws.project.id} was made from "${ws.project.preset}", not "${p.slug}"`);
  const v = o.version ? ws.project.versions.find((x) => x.version === o.version) : ws.project.versions.at(-1);
  if (!v) fail(`project ${ws.project.id} has no delivered version${o.version ? ` ${o.version}` : ""}`);
  const master = ws.path(v.path);
  const edl = await ws.readJson("render/edl.json", EdlSchema);
  if (!edl) fail(`project ${ws.project.id} has no render/edl.json`);
  const jobs = (await ws.readJson("plan/jobs.json")) ?? [];
  const models = o.models ?? [...new Set(jobs.filter((j) => j.state === "completed").map((j) => j.profile))];

  if (!o.credit && !p.example?.credit) {
    const roles = [[/^still\.face/, null], [/^still\./, "Keyframes"], [/^clip\./, "Clips"], [/^matte/, "Cut-outs"]];
    const named = new Map();
    for (const j of jobs.filter((x) => x.state === "completed")) {
      const role = roles.find(([re]) => re.test(j.spec.operation))?.[1];
      if (!role) continue;
      const prof = profile(j.profile);
      const note = prof.license.commercial === "no" ? " (non-commercial licence)" : prof.license.commercial === "restricted" ? " (restricted licence)" : "";
      named.set(role, new Set([...(named.get(role) ?? []), prof.title.replace(/\s*[(+].*$/, "") + note]));
    }
    const music = p.soundtrack ? ` Music: '${p.soundtrack.title}', ${p.soundtrack.licence}.` : "";
    const order = roles.map(([, r]) => r);
    const listed = [...named].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
    const suggestion = `Example made with a fictional person.${listed.map(([r, n]) => ` ${r}: ${[...n].join(", ")}.`).join("")}${music}`;
    fail(`--credit is required. Suggested (check it is true):\n  --credit "${suggestion}"`);
  }

  // The poster sits near the drop (the template's drop beat on the cut's grid, else the soundtrack's drop), on
  // the nearest frame without the edit's own words or a flash: the tile sets the template's title over it.
  const ctx = { fps: edl.canvas.fps, beats: await edlBeats(ws, edl) };
  const grid = edl.grid ?? p.skeleton?.grid;
  const duration = (await probe(master)).durationSec;
  let drop = o.posterAt;
  if (drop === undefined && grid && p.timing?.dropBeat !== undefined) drop = grid.phase + (p.timing.dropBeat * 60) / grid.bpm;
  if (drop === undefined && p.soundtrack?.dropSec !== undefined) drop = p.soundtrack.dropSec - (edl.audio?.asset === "music" ? edl.audio.offset : 0);
  const target = drop ?? duration * 0.4;
  const at =
    o.posterAt !== undefined
      ? o.posterAt
      : posterTime({
          target: target + 2 / ctx.fps,
          durationSec: duration,
          fps: ctx.fps,
          text: edl.text.map((t) => ({ start: resolveTime(t.start, ctx), end: resolveTime(t.end, ctx), size: t.size })),
          flashes: edl.flashes.map((f) => ({ start: resolveTime(f.at, ctx), end: resolveTime(f.at, ctx) + f.duration })),
          cuts: checkEdl(edl, ctx).shots.map((s) => s.startSec),
        });

  const tmp = await scratch();
  const files = { video: join(tmp, "example.mp4"), poster: join(tmp, "poster.jpg"), cutmap: join(tmp, "cutmap.json") };
  let crf;
  for (const c of CRF_STEPS) {
    await encodeExample(master, files.video, { height: o.height, crf: c, preset: "slow" });
    crf = c;
    if (statSync(files.video).size <= BUDGET.example) break;
  }
  if (statSync(files.video).size > BUDGET.example) fail(`the example is ${kb(statSync(files.video).size)} even at CRF ${crf}; the budget is ${kb(BUDGET.example)}. Try --height 640.`);
  console.log(`example: ${kb(statSync(files.video).size)} at CRF ${crf}, ${o.height ?? 720} px tall`);
  await extractPoster(master, files.poster, { at, height: o.height });
  if (statSync(files.poster).size > BUDGET.poster) fail(`the poster is ${kb(statSync(files.poster).size)}; the budget is ${kb(BUDGET.poster)}`);
  console.log(`poster: frame at ${at.toFixed(2)} s (${drop !== undefined ? "the drop" : "40%"} at ${target.toFixed(2)} s, the nearest frame without words), ${kb(statSync(files.poster).size)}`);
  // Lines are named after the template's slots ("<slot>-key" for a keyframe, "<slot>" for its clip).
  const slots = new Set((p.slots ?? []).map((s) => s.id));
  const slotOf = (id) => {
    const line = ws.project.assets.find((a) => a.id === id)?.lineId?.replace(/-key$/, "");
    return line && slots.has(line) ? line : undefined;
  };
  const shots = checkEdl(edl, ctx).shots.map((s) => ({ start: s.startSec, end: s.endSec, slot: slotOf(s.shot.source.asset) }));
  const cutmap = await templateCutMap(ws, shots, files.video, edl.canvas.fps);
  if (!cutmap) fail("couldn't build the cut map (cutMapFromEdl in src/app/cutmap.ts)");
  await writeFile(files.cutmap, JSON.stringify({ ...cutmap, dropSec: cutmap.dropSec ?? (drop !== undefined ? round(drop, 3) : undefined) }));
  if (statSync(files.cutmap).size > BUDGET.cutmap) fail(`the cut map is ${kb(statSync(files.cutmap).size)}; the budget is ${kb(BUDGET.cutmap)}`);
  console.log(`cut map: ${cutmap.shots.length} shots, ${cutmap.flashes.length} flashes, ${kb(statSync(files.cutmap).size)}`);

  let text = o.text;
  const example = { video: "example.mp4", poster: "poster.jpg", credit: o.credit ?? p.example.credit, models };
  if (example.credit.length > 240) fail(`the credit is ${example.credit.length} characters; the limit is 240`);
  text = setMember(text, objectAt(text, []), "example", example, { after: ["soundtrack", "timing", "display", "inputs"] });
  text = setMember(text, objectAt(text, []), "cutmap", "cutmap.json", { after: ["example"] });
  return {
    text,
    files: [
      [files.video, join(o.dir, "example.mp4")],
      [files.poster, join(o.dir, "poster.jpg")],
      [files.cutmap, join(o.dir, "cutmap.json")],
    ],
  };
}

async function run(cmd, args) {
  const { run: exec } = await ts("src/util/proc.ts");
  return exec(cmd, args);
}

// ---------- main ----------

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      version: { type: "string" },
      credit: { type: "string" },
      models: { type: "string" },
      "poster-at": { type: "string" },
      height: { type: "string" },
      soundtrack: { type: "string" },
      title: { type: "string" },
      artist: { type: "string" },
      licence: { type: "string" },
      drop: { type: "string" },
      grid: { type: "string" },
      shift: { type: "string" },
      presets: { type: "string" },
      "dry-run": { type: "boolean" },
      check: { type: "boolean" },
    },
  });
  const presetsDir = resolve(values.presets ?? join(ROOT, "presets"));
  if (values.check) {
    const b = budgets(presetsDir);
    printBudgets(b);
    process.exit(b.ok ? 0 : 1);
  }
  const slug = positionals[0];
  if (!slug || (!values.project && !values.soundtrack)) fail("usage: build-examples.mjs <slug> [--soundtrack <file> --title <t> --licence <l>] [--project <id> --credit <line>] (or --check)");
  const dir = join(presetsDir, slug);
  const file = join(dir, "preset.json");
  if (!existsSync(file)) fail(`no preset ${file}`);
  const num = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) fail(`--${name} takes a number`);
    return n;
  };

  const signed = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`--${name} takes a number of seconds`);
    return n;
  };

  const { PresetSchema } = await ts("src/presets/library.ts");
  let text = await readFile(file, "utf8");
  const writes = [];
  if (values.soundtrack) {
    const r = await addSoundtrack({ file: values.soundtrack, title: values.title, artist: values.artist, licence: values.licence, drop: num(values.drop, "drop"), grid: values.grid, shift: signed(values.shift, "shift"), preset: PresetSchema.parse(JSON.parse(text)), text, dir });
    text = r.text;
    writes.push(...r.files);
  }
  if (values.project) {
    const r = await addExample({
      project: values.project, version: num(values.version, "version"), credit: values.credit, models: values.models?.split(",").map((s) => s.trim()).filter(Boolean),
      posterAt: num(values["poster-at"], "poster-at"), height: num(values.height, "height"), preset: PresetSchema.parse(JSON.parse(text)), text, dir,
    });
    text = r.text;
    writes.push(...r.files);
  }
  PresetSchema.parse(JSON.parse(text));

  if (values["dry-run"]) {
    console.log(`dry run: would write ${[file, ...writes.map(([, to]) => to)].join(", ")}`);
  } else {
    for (const [from, to] of writes) await copyFile(from, to);
    await writeFile(file, text);
    for (const [, to] of writes) console.log(`${basename(to)}  sha256 ${sha256(to)}  ${kb(statSync(to).size)}`);
  }
  const b = budgets(presetsDir);
  printBudgets(b);
  if (!b.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e?.stack ?? String(e)));
}
