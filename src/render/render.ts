import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "../util/proc.js";
import { textToAss } from "./ass.js";
import { even as evenPx, leakImage, maskSpec, neutralFor, placement, shapeMatte, tileLayers, windowCrop } from "./compose.js";
import { checkEdl, type Edl, type Layer, type ResolvedShot, type Shot, resolveTime, type TextEvent, type TimeContext } from "./edl.js";
import { cameraFilter, fxGraph, lookFilters, q } from "./expr.js";
import { capRatio, ensureFaces, ensureFonts } from "./fonts.js";
import { BUILTIN_SFX, builtinSfx } from "./sfx.js";

export interface SourceInfo {
  path: string;
  kind: "image" | "video" | "audio";
  hasAudio?: boolean;
}

export interface RenderOptions {
  /** Resolves an asset id to a file. */
  source: (assetId: string) => SourceInfo;
  /** Tracked beats of the edit's soundtrack, for "b<n>" times. */
  beats: number[];
  outPath: string;
  cacheDir: string;
  /** Half resolution and fast encodes, for checking timing and look. */
  preview?: boolean;
  /** Called after each shot with (done, total). */
  onProgress?: (done: number, total: number) => void;
}

export interface RenderResult {
  path: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSec: number;
  shotsRendered: number;
  shotsCached: number;
  warnings: string[];
  elapsedSec: number;
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6));
const COLOR = /^(black|white|#[0-9a-fA-F]{6})$/;

interface Segment {
  shot: Shot | null;
  index: number;
  startSec: number;
  startFrame: number;
  frames: number;
}

/** Turns resolved shots into contiguous segments: gaps become black, overlaps are cut in favour of the later shot. */
export function segments(shots: ResolvedShot[], totalFrames: number, fps: number): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  const sorted = [...shots].sort((a, b) => a.startFrame - b.startFrame || a.index - b.index);
  for (const [i, s] of sorted.entries()) {
    const next = sorted[i + 1];
    const end = Math.min(totalFrames, s.startFrame + s.frames, next ? Math.max(next.startFrame, s.startFrame) : Infinity);
    const start = Math.max(s.startFrame, cursor);
    if (start > cursor) out.push({ shot: null, index: -1, startSec: cursor / fps, startFrame: cursor, frames: start - cursor });
    if (end > start) {
      out.push({ shot: s.shot, index: s.index, startSec: s.startSec + (start - s.startFrame) / fps, startFrame: start, frames: end - start });
      cursor = end;
    }
  }
  if (cursor < totalFrames) out.push({ shot: null, index: -1, startSec: cursor / fps, startFrame: cursor, frames: totalFrames - cursor });
  return out;
}

function fitFilters(fit: "cover" | "contain", focus: [number, number], W: number, H: number): string[] {
  if (fit === "contain") {
    return [`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`, "setsar=1"];
  }
  return [
    `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${W}:${H}:x=${q(`(iw-ow)*${focus[0]}`)}:y=${q(`(ih-oh)*${focus[1]}`)}`,
    "setsar=1",
  ];
}

/** setpts expression for a linear speed ramp s0 → s1 over D output seconds (inverse of the integrated source time). */
export function rampPts(s0: number, s1: number, D: number): string {
  const k = (s1 - s0) / D;
  if (Math.abs(k) < 1e-6) return `PTS/${num(s0)}`;
  return `(-${num(s0)}+sqrt(${num(s0 * s0)}+${num(2 * k)}*T))/${num(k)}/TB`;
}

interface Chain {
  inputs: string[];
  filters: string[];
}

/**
 * Input arguments and filters that turn a shot's source into exactly `seg.frames` canvas frames:
 * timing (in-point, speed, ramps, freeze, reverse), frame rate, fit and camera. Used for the picture
 * and, identically, for its subject matte so the two stay aligned.
 */
function sourceChain(seg: Segment, path: string | undefined, kind: SourceInfo["kind"] | "color", edl: Edl, ctx: TimeContext, W: number, H: number): Chain {
  const fps = edl.canvas.fps;
  const D = seg.frames / fps;
  const shot = seg.shot;
  const src = shot?.source;
  const inputs: string[] = [];
  const filters: string[] = [];
  if (!shot || !src || kind === "color" || !path) {
    const color = !src ? "black" : src.asset.startsWith("#") ? `0x${src.asset.slice(1)}` : src.asset;
    inputs.push("-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:r=${fps}`);
    filters.push("setsar=1");
  } else {
    if (kind === "audio") throw new Error(`Shot source ${src.asset} is audio-only`);
    if (kind === "image") {
      inputs.push("-loop", "1", "-framerate", String(fps), "-i", path);
      filters.push(`fps=${fps}`);
    } else if (src.speed === 0) {
      inputs.push("-ss", num(src.in), "-i", path);
      filters.push("trim=end_frame=1", `loop=loop=${seg.frames + 2}:size=1:start=0`, `setpts=N/${fps}/TB`);
    } else {
      // Offset into the shot when an overlap cut its head, so the source stays in sync.
      const headSec = seg.startSec - resolveTime(shot.start, ctx);
      const s1 = src.speedTo ?? src.speed;
      const span = D * ((src.speed + s1) / 2) + 0.5;
      inputs.push("-ss", num(src.in + headSec * src.speed), "-t", num(span), "-i", path);
      filters.push("setpts=PTS-STARTPTS");
      if (src.reverse) filters.push("reverse");
      filters.push(src.speedTo !== undefined ? `setpts=${q(rampPts(src.speed, src.speedTo, D))}` : `setpts=PTS/${num(src.speed)}`);
      if (src.interpolate === "blend") filters.push(`framerate=fps=${fps}`);
      else if (src.interpolate === "motion") filters.push(`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
      else filters.push(`fps=${fps}`);
    }
    filters.push(...fitFilters(src.fit, src.focus as [number, number], W, H));
  }
  filters.push(`tpad=stop_mode=clone:stop=${seg.frames}`);
  if (shot?.camera) {
    const cam = cameraFilter(shot.camera, { width: W, height: H, fps, durationSec: D, shotStartSec: seg.startSec, time: (t) => resolveTime(t, ctx) });
    if (cam) filters.push(cam);
  }
  return { inputs, filters };
}

/** Text events that sit behind the subject during this segment, re-timed to the segment. */
function behindText(seg: Segment, edl: Edl, ctx: TimeContext): { event: TextEvent; startSec: number; endSec: number }[] {
  if (!seg.shot?.source.matte) return [];
  const s0 = seg.startSec;
  const s1 = s0 + seg.frames / edl.canvas.fps;
  return edl.text
    .filter((t) => t.behind)
    .map((event) => ({ event, startSec: resolveTime(event.start, ctx), endSec: resolveTime(event.end, ctx) }))
    .filter((t) => t.startSec < s1 && t.endSec > s0)
    .map((t) => ({ ...t, startSec: t.startSec - s0, endSec: t.endSec - s0 }));
}

const BLEND_MODES: Record<Layer["blend"], string> = {
  normal: "normal",
  screen: "screen",
  add: "addition",
  multiply: "multiply",
  overlay: "overlay",
  difference: "difference",
  lighten: "lighten",
  darken: "darken",
};

/** Every layer of a shot: its tile grid first, then its explicit layers. */
function shotLayers(shot: Shot | null, W: number, H: number, ctx: TimeContext): Layer[] {
  if (!shot) return [];
  return [...tileLayers(shot, W, H, resolveTime(shot.start, ctx)), ...(shot.layers ?? [])];
}

async function renderSegment(seg: Segment, edl: Edl, opts: RenderOptions, ctx: TimeContext, W: number, H: number, out: string): Promise<void> {
  const fps = edl.canvas.fps;
  const D = seg.frames / fps;
  const shot = seg.shot;
  const src = shot?.source;
  const inputs: string[] = [];
  const graph: string[] = [];
  let inputCount = 0;
  const addInput = (args: string[]) => {
    inputs.push(...args);
    return inputCount++;
  };
  const still = (file: string) => addInput(["-loop", "1", "-framerate", String(fps), "-t", num(D + 0.2), "-i", file]);

  const info = src && !COLOR.test(src.asset) ? opts.source(src.asset) : undefined;
  const main = sourceChain(seg, info?.path, info?.kind ?? "color", edl, ctx, W, H);
  graph.push(`[${addInput(main.inputs)}:v]${main.filters.join(",")}[pre0]`);
  let pre = "[pre0]";

  // The subject matte feeds a colour background and text behind the subject.
  const behind = behindText(seg, edl, ctx);
  const mattes: string[] = [];
  const matteUses = src?.matte ? (behind.length ? 1 : 0) + (shot?.background ? 1 : 0) : 0;
  if (matteUses && src?.matte) {
    const matte = opts.source(src.matte);
    const m = sourceChain(seg, matte.path, matte.kind, edl, ctx, W, H);
    const labels = Array.from({ length: matteUses }, (_, k) => `[mat${k}]`);
    graph.push(`[${addInput(m.inputs)}:v]${m.filters.join(",")},format=gray${matteUses > 1 ? `,split=${matteUses}` : ""}${labels.join("")}`);
    mattes.push(...labels);
  }
  if (shot?.background && src?.matte) {
    graph.push(
      `${pre}format=rgba[bgk]`,
      `[bgk]${mattes.shift()}alphamerge[bgs]`,
      `color=c=0x${shot.background.slice(1)}:s=${W}x${H}:r=${fps}[bgp]`,
      "[bgp][bgs]overlay=shortest=1:format=auto[pre1]",
    );
    pre = "[pre1]";
  }

  const layers = shotLayers(shot, W, H, ctx);
  const windows: string[] = [];
  const windowCount = layers.filter((l) => l.window).length;
  if (windowCount) {
    for (let k = 0; k < windowCount; k++) windows.push(`[win${k}]`);
    graph.push(`${pre}split=${windowCount + 1}[prefx]${windows.join("")}`);
    pre = "[prefx]";
  }
  graph.push(...fxGraph(shot?.fx, { width: W, height: H, durationSec: D }, pre, "[fx]"));
  let cur = "[fx]";

  const mask = shot?.fx?.mask;
  if (mask) {
    const im = still(await shapeMatte(opts.cacheDir, W, H, maskSpec(mask, W, H)));
    // A growing or travelling window: zoom and pan the matte itself about its centre.
    const moving = mask.sizeTo !== undefined || mask.centerTo !== undefined;
    const matteMove = moving
      ? cameraFilter(
          { zoom: [1, mask.sizeTo ?? 1], ease: "inout", anchor: mask.center, pan: mask.centerTo ? [mask.centerTo[0] - mask.center[0], mask.centerTo[1] - mask.center[1]] : undefined, overscan: 1 },
          { width: W, height: H, fps, durationSec: D, shotStartSec: seg.startSec, time: (t) => resolveTime(t, ctx) },
        )
      : undefined;
    graph.push(
      `${cur}format=rgba[mk0]`,
      `[${im}:v]format=gray${matteMove ? `,${matteMove}` : ""}[mk1]`,
      "[mk0][mk1]alphamerge[mk2]",
      `color=c=0x${mask.color.slice(1)}:s=${W}x${H}:r=${fps}[mk3]`,
      "[mk3][mk2]overlay=shortest=1:format=auto[mk]",
    );
    cur = "[mk]";
  }
  const leak = shot?.fx?.leak;
  if (leak) {
    const il = still(await leakImage(opts.cacheDir, W, H, leak));
    graph.push(`${cur}format=gbrp[lk0]`, `[${il}:v]format=gbrp[lk1]`, "[lk0][lk1]blend=all_mode=screen:shortest=1[lk]");
    cur = "[lk]";
  }

  if (behind.length && src?.matte) {
    // Text behind the subject: graded picture → text → the subject cut out with its matte on top.
    const fontsDir = await ensureFonts(behind.map((b) => b.event.font));
    await ensureFaces(behind.map((b) => b.event));
    const ass = `${out}.behind.ass`;
    await writeFile(ass, textToAss(behind, W, H, capRatio));
    graph.push(
      `${cur}split[bgsrc][fgsrc]`,
      `[bgsrc]subtitles=filename=${q(ass)}:fontsdir=${q(fontsDir)}[bg]`,
      `[fgsrc]${mattes.shift()}alphamerge[fg]`,
      "[bg][fg]overlay=format=auto[bt]",
    );
    cur = "[bt]";
  }

  const shotStart = shot ? resolveTime(shot.start, ctx) : seg.startSec;
  const shotEnd = shot ? resolveTime(shot.end, ctx) : seg.startSec + D;
  for (const [li, layer] of layers.entries()) {
    const L = `l${li}`;
    const a = Math.max(0, (layer.start !== undefined ? resolveTime(layer.start, ctx) : shotStart) - seg.startSec);
    const b = Math.min(D, (layer.end !== undefined ? resolveTime(layer.end, ctx) : shotEnd) - seg.startSec);
    const aF = Math.round(a * fps);
    const frames = Math.round(b * fps) - aF;
    if (frames < 1) continue;
    const [fx, fy, fw, fh] = layer.box;
    const bx = Math.round(fx * W);
    const by = Math.round(fy * H);
    const bw = evenPx(fw * W);
    const bh = evenPx(fh * H);
    const card = layer.shape === "rect" && layer.border ? layer.border : undefined;
    const border = card ? Math.round(card.width * H) : 0;
    const bottom = card ? Math.round(card.bottom * H) : 0;
    const cw = evenPx(bw - 2 * border);
    const ch = evenPx(bh - 2 * border - bottom);

    // Content: a window onto the shot itself, or the layer's own source timed from its start.
    if (layer.window) {
      const wc = windowCrop(layer, bx + border, by + border, W, H, a, b);
      graph.push(`${windows.shift()}crop=${cw}:${ch}:${q(wc.x)}:${q(wc.y)},trim=start_frame=${aF}:end_frame=${aF + frames},setpts=PTS-STARTPTS[${L}c]`);
    } else {
      const lsrc = layer.source;
      const lshot = { start: layer.start ?? shot!.start, end: layer.end ?? shot!.end, source: lsrc, camera: layer.camera } as Shot;
      const lseg: Segment = { shot: lshot, index: seg.index, startSec: seg.startSec + aF / fps, startFrame: seg.startFrame + aF, frames };
      const linfo = !COLOR.test(lsrc.asset) ? opts.source(lsrc.asset) : undefined;
      const c = sourceChain(lseg, linfo?.path, linfo?.kind ?? "color", edl, ctx, cw, ch);
      graph.push(`[${addInput(c.inputs)}:v]${c.filters.join(",")},trim=end_frame=${frames}[${L}c]`);
      if (layer.key && lsrc.matte) {
        const minfo = opts.source(lsrc.matte);
        const m = sourceChain(lseg, minfo.path, minfo.kind, edl, ctx, cw, ch);
        graph.push(`[${addInput(m.inputs)}:v]${m.filters.join(",")},trim=end_frame=${frames},format=gray[${L}m]`);
      }
    }
    graph.push(...fxGraph(layer.fx, { width: cw, height: ch, durationSec: frames / fps }, `[${L}c]`, `[${L}f]`, `${L}x`));

    // Alpha: the subject matte, or a round shape.
    if (layer.key && layer.source.matte && !layer.window) graph.push(`[${L}f]format=rgba[${L}r]`, `[${L}r][${L}m]alphamerge[${L}a]`);
    else if (layer.shape === "circle" || layer.feather > 0) {
      const circle = layer.shape === "circle";
      const r = Math.min(cw, ch) / 2;
      const spec = circle
        ? { shape: "circle" as const, cx: cw / 2, cy: ch / 2, rx: r, ry: r, feather: Math.max(0.015, layer.feather) }
        : { shape: "rect" as const, cx: cw / 2, cy: ch / 2, rx: cw / 2, ry: ch / 2, feather: layer.feather };
      const im = still(await shapeMatte(opts.cacheDir, cw, ch, spec));
      graph.push(`[${L}f]format=rgba[${L}r]`, `[${im}:v]format=gray,trim=end_frame=${frames}[${L}k]`, `[${L}r][${L}k]alphamerge[${L}a]`);
    } else graph.push(`[${L}f]format=rgba[${L}a]`);

    const post: string[] = [];
    const blended = layer.blend !== "normal";
    if (layer.opacity < 1 && !blended) post.push(`colorchannelmixer=aa=${num(layer.opacity)}`);
    if (card) post.push(`pad=${bw}:${bh}:${border}:${border}:color=0x${card.color.slice(1)}FF`);
    // A soft drop shadow travels with the layer: a darkened, blurred copy offset down and right.
    const shadowOff = layer.shadow && !blended ? Math.max(2, Math.round(H * 0.014)) : 0;
    if (shadowOff) {
      graph.push(`[${L}a]${post.length ? post.join(",") : "null"},split[${L}s0][${L}s1]`);
      graph.push(
        `[${L}s1]colorchannelmixer=rr=0:gg=0:bb=0:aa=${num(0.6 * layer.shadow!)},pad=${bw + 2 * shadowOff}:${bh + 2 * shadowOff}:${shadowOff}:${shadowOff}:color=black@0,gblur=sigma=${num(shadowOff * 0.8)},crop=${bw + shadowOff}:${bh + shadowOff}:0:0[${L}s2]`,
        `[${L}s2][${L}s0]overlay=0:0:format=auto[${L}sh]`,
      );
      post.length = 0;
    }
    const layerIn = shadowOff ? `[${L}sh]` : `[${L}a]`;
    if (aF > 0) post.push(`tpad=start=${aF}:start_mode=add:color=black@0`);
    const fadeIn = layer.enter?.type === "fade" ? Math.min(layer.enter.duration, b - a) : 0;
    const fadeOut = layer.exit?.type === "fade" ? Math.min(layer.exit.duration, b - a) : 0;
    if (fadeIn) post.push(`fade=t=in:st=${num(a)}:d=${num(fadeIn)}:alpha=1`);
    if (fadeOut) post.push(`fade=t=out:st=${num(b - fadeOut)}:d=${num(fadeOut)}:alpha=1`);
    const pl = placement(layer, bx, by, bw, bh, W, H, a, b);
    if (pl.scale) post.push(`scale=w=${q(`max(2,trunc(iw*${pl.scale}/2)*2)`)}:h=${q(`max(2,trunc(ih*${pl.scale}/2)*2)`)}:eval=frame`);
    graph.push(`${layerIn}${post.length ? post.join(",") : "null"}[${L}p]`);

    const enable = q(`between(t,${num(a)},${num(b - 0.5 / fps)})`);
    if (!blended) {
      graph.push(`${cur}[${L}p]overlay=x=${q(pl.x)}:y=${q(pl.y)}:eval=frame:enable=${enable}:format=auto[${L}o]`);
    } else {
      // Blend modes need full frames: pad the layer with a colour the mode leaves unchanged.
      graph.push(
        `color=c=${neutralFor(layer.blend)}:s=${W}x${H}:r=${fps}[${L}n]`,
        `[${L}n][${L}p]overlay=x=${q(pl.x)}:y=${q(pl.y)}:eval=frame:enable=${enable}:format=auto,format=gbrp[${L}g]`,
        `${cur}format=gbrp[${L}h]`,
        `[${L}h][${L}g]blend=all_mode=${BLEND_MODES[layer.blend]}:all_opacity=${num(layer.opacity)}:shortest=1[${L}o]`,
      );
    }
    cur = `[${L}o]`;
  }
  graph.push(`${cur}format=yuv420p[v]`);

  const fast = opts.preview;
  await run("ffmpeg", [
    "-v", "error", "-y", ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", "[v]", "-frames:v", String(seg.frames), "-r", String(fps),
    "-c:v", "libx264", "-preset", fast ? "ultrafast" : "veryfast", "-crf", fast ? "22" : "12", "-g", "1",
    "-an", out,
  ]);
}

function cacheKey(seg: Segment, edl: Edl, opts: RenderOptions, ctx: TimeContext, W: number, H: number): string {
  const src = seg.shot?.source;
  const stamp = (id: string | undefined) => {
    if (!id || COLOR.test(id)) return "";
    const info = opts.source(id);
    const st = statSync(info.path);
    return `${info.path}:${st.size}:${st.mtimeMs}`;
  };
  const layerStamps = (seg.shot?.layers ?? []).flatMap((l) => [stamp(l.source.asset), stamp(l.source.matte)]);
  return createHash("sha1")
    .update(JSON.stringify({
      v: 5, shot: seg.shot, start: seg.startSec, frames: seg.frames, W, H, fps: edl.canvas.fps, preview: Boolean(opts.preview),
      stamp: stamp(src?.asset), matte: stamp(src?.matte), layers: layerStamps, beats: opts.beats,
      // Text behind the subject is drawn into the shot; "cap" marks cap-height text sizing.
      behind: behindText(seg, edl, ctx).map((b) => ({ ...b, sizing: "cap" })),
    }))
    .digest("hex")
    .slice(0, 16);
}

function finishFilters(edl: Edl, ctx: TimeContext, W: number, H: number, assPath: string | undefined, fontsDir: string | undefined): string {
  const f = edl.finish;
  const fps = edl.canvas.fps;
  const parts: string[] = [];
  let cur = "[0:v]";
  let chain: string[] = [...lookFilters(f.look)];
  let k = 0;
  const flush = () => {
    const label = `[fin${k++}]`;
    parts.push(`${cur}${chain.length ? chain.join(",") : "null"}${label}`);
    chain = [];
    cur = label;
  };
  // White and black flashes under the titles push brightness; tinted flashes and flashes over the
  // titles are colour plates fading out over the picture.
  const legacy = edl.flashes.filter((fl) => (fl.color === "white" || fl.color === "black") && !fl.overText);
  const plates = edl.flashes.filter((fl) => !legacy.includes(fl));
  const plate = (fl: Edl["flashes"][number]) => {
    flush();
    const a = resolveTime(fl.at, ctx);
    const color = fl.color.startsWith("#") ? `0x${fl.color.slice(1)}` : fl.color;
    const p = `[fp${k}]`;
    parts.push(
      `color=c=${color}:s=${W}x${H}:r=${fps}:d=${num(fl.duration)},format=rgba,colorchannelmixer=aa=${num(fl.intensity)},fade=t=out:st=0:d=${num(fl.duration)}:alpha=1,setpts=PTS+${num(a)}/TB${p}`,
    );
    const label = `[fin${k++}]`;
    parts.push(`${cur}${p}overlay=eof_action=pass:format=auto${label}`);
    cur = label;
  };

  if (f.grain > 0) chain.push(`noise=alls=${Math.round(f.grain * 40)}:allf=t`);
  if (f.vignette > 0) chain.push(`vignette=a=${num(0.25 + 0.5 * f.vignette)}`);
  if (legacy.length) {
    const pulses = legacy.map((fl) => {
      const a = resolveTime(fl.at, ctx);
      const sign = fl.color === "black" ? "-" : "+";
      return `${sign}${num(fl.intensity)}*if(between(t,${num(a)},${num(a + fl.duration)}),1-(t-${num(a)})/${num(fl.duration)},0)`;
    });
    chain.push(`eq=brightness=${q(pulses.join("").replace(/^\+/, ""))}:eval=frame`);
  }
  for (const fl of plates.filter((p) => !p.overText)) plate(fl);
  if (f.letterbox > 0) {
    const bar = even(H * f.letterbox);
    chain.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
  }
  if (assPath && fontsDir) chain.push(`subtitles=filename=${q(assPath)}:fontsdir=${q(fontsDir)}`);
  for (const fl of plates.filter((p) => p.overText)) plate(fl);
  chain.push(`scale=${W}:${H}`, "format=yuv420p");
  parts.push(`${cur}${chain.join(",")}[v]`);
  return parts.join(";");
}

/** Renders an EDL to an MP4 with exactly the planned number of frames. */
export async function renderEdl(edl: Edl, opts: RenderOptions): Promise<RenderResult> {
  const t0 = Date.now();
  const ctx: TimeContext = { fps: edl.canvas.fps, beats: opts.beats };
  const check = checkEdl(edl, ctx);
  const scale = opts.preview ? 0.5 : 1;
  const W = even(edl.canvas.width * scale);
  const H = even(edl.canvas.height * scale);
  const fps = edl.canvas.fps;
  const segs = segments(check.shots, check.totalFrames, fps);
  await mkdir(opts.cacheDir, { recursive: true });
  await mkdir(dirname(opts.outPath), { recursive: true });

  let rendered = 0;
  let cached = 0;
  const files: string[] = [];
  for (const [i, seg] of segs.entries()) {
    const file = join(opts.cacheDir, `${cacheKey(seg, edl, opts, ctx, W, H)}.mp4`);
    if (existsSync(file)) cached++;
    else {
      await renderSegment(seg, edl, opts, ctx, W, H, file);
      rendered++;
    }
    files.push(file);
    opts.onProgress?.(i + 1, segs.length);
  }

  const listPath = join(opts.cacheDir, `concat-${process.pid}-${Date.now()}.txt`);
  await writeFile(listPath, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));

  let assPath: string | undefined;
  let fontsDir: string | undefined;
  // Behind-subject text is drawn inside matted shots; everywhere else it stays a normal overlay.
  const matted = segs.filter((sg) => behindText(sg, edl, ctx).length).map((sg) => [sg.startSec, sg.startSec + sg.frames / fps] as const);
  const overlay: { event: TextEvent; startSec: number; endSec: number }[] = [];
  for (const event of edl.text) {
    let pieces: [number, number][] = [[resolveTime(event.start, ctx), resolveTime(event.end, ctx)]];
    if (event.behind) {
      for (const [a, b] of matted) pieces = pieces.flatMap(([x, y]) => [[x, Math.min(y, a)], [Math.max(x, b), y]] as [number, number][]).filter(([x, y]) => y - x > 1e-3);
    }
    for (const [startSec, endSec] of pieces) overlay.push({ event, startSec, endSec });
  }
  if (overlay.length) {
    fontsDir = await ensureFonts(overlay.map((t) => t.event.font));
    await ensureFaces(overlay.map((t) => t.event));
    assPath = join(opts.cacheDir, `text-${process.pid}-${Date.now()}.ass`);
    await writeFile(assPath, textToAss(overlay, W, H, capRatio));
  }

  const inputs = ["-f", "concat", "-safe", "0", "-i", listPath];
  const maps = ["-map", "[v]"];
  let audioGraph = "";
  const warnings = [...check.warnings];
  if (edl.audio) {
    const info = opts.source(edl.audio.asset);
    if (info.kind === "image" || (info.kind === "video" && !info.hasAudio)) {
      warnings.push(`Audio source ${edl.audio.asset} has no audio stream; the edit is silent.`);
    } else {
      inputs.push("-ss", num(edl.audio.offset), "-i", info.path);
      const dur = check.totalFrames / fps;
      const fade = Math.min(edl.audio.fadeOut, dur / 2);
      audioGraph = `;[1:a]atrim=0:${num(dur)},asetpts=PTS-STARTPTS,volume=${edl.audio.gainDb}dB${fade > 0 ? `,afade=t=out:st=${num(dur - fade)}:d=${num(fade)}` : ""}[a]`;
      maps.push("-map", "[a]");
    }
  }
  // Sound effects: each cue is delayed to its time and mixed under the soundtrack, then limited.
  if (edl.sfx.length) {
    const dur = check.totalFrames / fps;
    const cues: string[] = [];
    let index = inputs.filter((x) => x === "-i").length;
    for (const cue of edl.sfx) {
      const at = resolveTime(cue.at, ctx);
      if (at >= dur) continue;
      const path = BUILTIN_SFX[cue.sound] ? await builtinSfx(cue.sound, opts.cacheDir) : opts.source(cue.sound).path;
      inputs.push("-i", path);
      cues.push(`[${index}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${cue.gainDb}dB,adelay=${Math.round(at * 1000)}:all=1[sfx${index}]`);
      index++;
    }
    if (cues.length) {
      const labels = cues.map((c) => c.slice(c.lastIndexOf("[")));
      const base = audioGraph ? "[a]" : "";
      if (audioGraph) audioGraph = audioGraph.replace(/\[a\]$/, "[music]");
      const mixIn = audioGraph ? ["[music]", ...labels] : labels;
      audioGraph += `;${cues.join(";")};${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=longest,alimiter=limit=0.89,atrim=0:${num(dur)},apad=whole_dur=${num(dur)}[a]`;
      if (!base) maps.push("-map", "[a]");
    }
  }
  const graph = finishFilters(edl, ctx, W, H, assPath, fontsDir) + audioGraph;
  await run("ffmpeg", [
    "-v", "error", "-y", ...inputs,
    "-filter_complex", graph, ...maps,
    "-frames:v", String(check.totalFrames), "-r", String(fps),
    "-c:v", "libx264", "-preset", opts.preview ? "veryfast" : "medium", "-crf", opts.preview ? "24" : "17", "-pix_fmt", "yuv420p",
    ...(audioGraph ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-movflags", "+faststart",
    opts.outPath,
  ]);

  return {
    path: opts.outPath,
    width: W,
    height: H,
    fps,
    frames: check.totalFrames,
    durationSec: check.totalFrames / fps,
    shotsRendered: rendered,
    shotsCached: cached,
    warnings,
    elapsedSec: (Date.now() - t0) / 1000,
  };
}
