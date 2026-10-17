import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { CutMapData, CutMapShot } from "../../../src/app/types.js";
import { fmtTime, indexAt } from "./beat.js";
import { reducedMotion } from "./flash.js";

/**
 * The Cut Map (spec §5.5): an edit as one barcode. Shots in their colour with a 1 px cut between them,
 * flash ticks rising above, beat dots below, words as hairlines on top. One canvas at device pixel
 * ratio; the same component draws tiles (20), the template page and result (36), progress (64) and
 * the decode lanes (72 + lanes).
 */
export interface CutMapProps {
  data: CutMapData;
  height: 20 | 36 | 64 | 72;
  label: string; // aria-label
  currentTime?: number; // seconds; draws the playhead
  highlightSlot?: string; // lights cells with this slot
  reveal?: Partial<Record<"cuts" | "flashes" | "beats" | "camera" | "energy", boolean>>; // decode: lanes revealed so far
  lanes?: boolean; // decode: draw labelled lanes (CUTS, FLASHES, BEAT, CAMERA, ENERGY)
  onSeek?: (t: number) => void;
  onScrub?: (t: number | undefined) => void;
  onShot?: (index: number) => void;
  /** Draws every cell in this colour (the typographic template card draws the map in its accent). */
  tint?: string;
  class?: string;
}

type LaneId = "cuts" | "flashes" | "beats" | "camera" | "energy";
const LANE_IDS: LaneId[] = ["cuts", "flashes", "beats", "camera", "energy"];

/** Decode lanes, top to bottom (CSS px). */
const LANE_ROWS: { id: LaneId; label: string; h: number }[] = [
  { id: "cuts", label: "Cuts", h: 56 },
  { id: "flashes", label: "Flashes", h: 16 },
  { id: "beats", label: "Beat", h: 16 },
  { id: "camera", label: "Camera", h: 20 },
  { id: "energy", label: "Energy", h: 24 },
];
const LANE_GAP = 8;
const LANES_HEIGHT = LANE_ROWS.reduce((s, r) => s + r.h, 0) + LANE_GAP * (LANE_ROWS.length - 1);
const REVEAL_MS = 420;

/** Vertical layout in CSS px for a box `h` tall. */
interface Rows {
  text?: number;
  flash: [number, number];
  shots: [number, number];
  under?: [number, number];
  beats: number;
  caret?: number;
  energy?: [number, number];
  camera?: [number, number];
  /** Flashes get their own lane (decode) instead of rising above the shots. */
  flashLane?: boolean;
}

function rowsFor(height: CutMapProps["height"], lanes: boolean, h: number): Rows {
  if (lanes) {
    const at: Record<string, [number, number]> = {};
    let y = 0;
    for (const r of LANE_ROWS) {
      at[r.id] = [y, y + r.h];
      y += r.h + LANE_GAP;
    }
    const cuts = at.cuts!;
    const beats = at.beats!;
    return {
      text: cuts[0] + 1.5,
      flash: at.flashes!,
      flashLane: true,
      shots: [cuts[0] + 6, cuts[1]],
      beats: beats[0] + 5,
      caret: beats[1] - 3,
      camera: at.camera!,
      energy: at.energy!,
    };
  }
  const f = (n: number) => n * h;
  switch (height) {
    case 20:
      return { flash: [0, f(0.2)], shots: [f(0.2), f(0.75)], beats: f(0.88) };
    case 36:
      return { text: 1.5, flash: [f(0.1), f(0.21)], shots: [f(0.21), f(0.72)], beats: f(0.82), caret: f(0.93) };
    case 64:
      return { text: 1.5, flash: [f(0.05), f(0.12)], shots: [f(0.12), f(0.76)], under: [f(0.78), f(0.81)], beats: f(0.88), caret: f(0.96) };
    case 72:
      return { text: 1.5, flash: [f(0.04), f(0.1)], shots: [f(0.1), f(0.6)], beats: f(0.68), caret: f(0.75), energy: [f(0.8), h] };
  }
}

// ---------- colours ----------

interface Tokens {
  night: string;
  raised: string;
  seamStrong: string;
  bone: string;
  ash: string;
  sodium: string;
  sodiumHot: string;
  sodiumInk: string;
  halo: string;
  flash: string;
}
let tokenCache: Tokens | undefined;
if (typeof matchMedia === "function") matchMedia("(prefers-contrast: more)").addEventListener("change", () => (tokenCache = undefined));

function tokens(): Tokens {
  if (tokenCache) return tokenCache;
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  tokenCache = {
    night: v("--night", "#0b0c0d"),
    raised: v("--raised", "#23262a"),
    seamStrong: v("--seam-strong", "#3a3e44"),
    bone: v("--bone", "#ece7dc"),
    ash: v("--ash", "#9a9ea6"),
    sodium: v("--sodium", "#f2a33a"),
    sodiumHot: v("--sodium-hot", "#ffc46b"),
    sodiumInk: v("--sodium-ink", "#1d1407"),
    halo: v("--halo", "rgba(242,163,58,.35)"),
    flash: v("--flash", "#fff6e6"),
  };
  return tokenCache;
}

// ---------- thumbnails ----------

const images = new Map<string, HTMLImageElement>();
const imageWaiters = new Set<() => void>();

/** A loaded thumbnail, or undefined while it loads (the cell shows its colour meanwhile). */
function thumbImage(url: string): HTMLImageElement | undefined {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.onload = () => {
      for (const w of imageWaiters) w();
    };
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : undefined;
}

// ---------- drawing ----------

const CAMERA_GLYPHS: Record<string, string> = { "zoom-in": "↗", "zoom-out": "↙", punch: "✶", shake: "≈", pan: "→", tilt: "↕", roll: "↻" };

function cameraGlyph(e: NonNullable<CutMapData["camera"]>[number]): string {
  if (e.type === "pan" && e.direction) return /left/.test(e.direction) ? "←" : "→";
  if (e.type === "tilt" && e.direction) return /up/.test(e.direction) ? "↑" : "↓";
  return CAMERA_GLYPHS[e.type] ?? "·";
}

interface DrawState {
  w: number; // CSS px
  h: number;
  dpr: number;
  progress: Record<LaneId, number>;
  focusIndex: number; // keyboard-focused shot, -1 when none
  reduced: boolean;
}

function draw(ctx: CanvasRenderingContext2D, p: CutMapProps, s: DrawState): void {
  const { w, h, dpr } = s;
  const t = tokens();
  const data = p.data;
  const dur = Math.max(0.001, data.durationSec);
  const rows = rowsFor(p.height, Boolean(p.lanes), h);
  const X = (sec: number) => (Math.min(dur, Math.max(0, sec)) / dur) * w;
  // Device-pixel snapping keeps cuts crisp.
  const snap = (x: number) => Math.round(x * dpr) / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const lane = (id: LaneId, y0: number, y1: number, body: () => void) => {
    const prog = s.progress[id];
    if (prog <= 0) return;
    ctx.save();
    if (prog < 1) {
      ctx.beginPath();
      ctx.rect(0, y0 - 6, w * prog, y1 - y0 + 12);
      ctx.clip();
    }
    body();
    ctx.restore();
  };

  const [s0, s1] = rows.shots;
  const bandH = s1 - s0;
  const shots = data.shots;
  const highlight = p.highlightSlot;

  // Cuts: the band, recipe sketch, cells, slot letters, cell states, your-pick underline, words.
  lane("cuts", rows.text ?? s0, s1, () => {
    ctx.fillStyle = p.tint ? "transparent" : t.night;
    if (!p.tint && (shots.length || data.sketch?.length)) ctx.fillRect(0, s0, w, bandH);

    if (!shots.length && data.sketch?.length) {
      ctx.font = `650 ${Math.max(8, Math.min(10.5, bandH * 0.42))}px Archivo, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      for (const b of data.sketch) {
        const x0 = snap(X(b.start));
        const x1 = snap(X(b.end));
        const bw = Math.max(1, x1 - x0 - 2);
        ctx.strokeStyle = p.tint ?? t.seamStrong;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, s0 + 0.5, bw - 1, bandH - 1);
        const text = b.label.toUpperCase();
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 3, s0, bw - 6, bandH);
        ctx.clip();
        ctx.fillStyle = p.tint ?? t.ash;
        if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0.08em";
        if (bandH >= 9 && ctx.measureText(text).width < bw - 6) ctx.fillText(text, x0 + 5, s0 + bandH / 2 + 0.5);
        ctx.restore();
      }
    }

    const letterSize = Math.max(8, Math.min(11, bandH * 0.45));
    for (const [i, shot] of shots.entries()) {
      const x0 = snap(X(shot.start));
      const x1 = snap(X(shot.end));
      const full = x1 - x0;
      const gap = full >= 3 ? 1 : 0;
      const cw = Math.max(1 / dpr, full - gap);
      const lit = highlight !== undefined && shot.slot === highlight;
      ctx.globalAlpha = highlight !== undefined && !lit ? 0.35 : 1;
      drawCell(ctx, shot, i, { x: x0, y: s0, w: cw, h: bandH }, { t, tint: p.tint, lit, letterSize, dpr, thumbs: p.height >= 64 });
      ctx.globalAlpha = 1;
      if (shot.yours && cw >= 2) {
        const [u0, u1] = rows.under ?? [s1 - 2, s1];
        ctx.fillStyle = t.sodium;
        ctx.fillRect(x0, u0, cw, Math.max(2, u1 - u0));
      }
    }

    if (rows.text !== undefined) {
      ctx.fillStyle = t.bone;
      for (const card of data.text) {
        const x0 = snap(X(card.start));
        const x1 = snap(X(card.end));
        ctx.fillRect(x0, Math.round(rows.text) - 0.5, Math.max(1, x1 - x0 - 1), 1);
      }
    }

    if (s.focusIndex >= 0 && shots[s.focusIndex]) {
      const f = shots[s.focusIndex]!;
      const x0 = snap(X(f.start));
      const x1 = snap(X(f.end));
      ctx.strokeStyle = t.sodium;
      ctx.lineWidth = 2;
      ctx.strokeRect(x0 + 1, s0 + 1, Math.max(2, x1 - x0 - 2), bandH - 2);
    }
  });

  // Flashes: ticks rising above the shots, or their own lane.
  const [f0, f1] = rows.flash;
  lane("flashes", f0, f1, () => {
    ctx.fillStyle = p.tint ?? t.flash;
    for (const fl of data.flashes) {
      const x = snap(X(fl.t));
      if (rows.flashLane) ctx.fillRect(x, f0, Math.max(2, (fl.durationSec / dur) * w), f1 - f0);
      else ctx.fillRect(x - 1, f0, 2, Math.max(2, s0 - f0));
    }
  });

  // Beats: sodium dots, downbeats larger; they pulse as the playhead passes. Then the drop caret.
  lane("beats", rows.beats - 4, (rows.caret ?? rows.beats) + 4, () => {
    const beats = data.beats;
    const down = new Set(data.downbeats.map((b) => b.toFixed(3)));
    const spacing = beats.length > 1 ? w / beats.length : w;
    const base = p.height === 20 && !p.lanes ? Math.max(0.8, Math.min(1.6, h * 0.045)) : 1.15;
    const ct = s.reduced ? undefined : p.currentTime;
    ctx.globalAlpha = data.approximate ? 0.5 : 1;
    for (const b of beats) {
      const isDown = down.has(b.toFixed(3));
      if (spacing < 3.5 && !isDown) continue;
      let r = isDown ? base * 1.6 : base;
      let color = p.tint ?? t.sodium;
      if (ct !== undefined && ct >= b && ct - b < 0.14) {
        const k = 1 - (ct - b) / 0.14;
        r *= 1 + 1.2 * k;
        color = t.sodiumHot;
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(snap(X(b)), rows.beats, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (data.dropSec !== undefined && rows.caret !== undefined) {
      const x = X(data.dropSec);
      ctx.save();
      ctx.shadowColor = t.halo;
      ctx.shadowBlur = 6;
      ctx.fillStyle = t.sodium;
      ctx.beginPath();
      ctx.moveTo(x, rows.caret - 3.5);
      ctx.lineTo(x + 3.5, rows.caret + 2);
      ctx.lineTo(x - 3.5, rows.caret + 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  });

  if (rows.camera && data.camera?.length) {
    const [c0, c1] = rows.camera;
    lane("camera", c0, c1, () => {
      const mid = (c0 + c1) / 2;
      ctx.font = `600 12px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "middle";
      for (const e of data.camera!) {
        const x0 = X(e.t);
        const x1 = X(e.end);
        ctx.fillStyle = t.seamStrong;
        if (x1 - x0 > 10) ctx.fillRect(x0 + 8, mid - 0.5, x1 - x0 - 8, 1);
        ctx.fillStyle = t.bone;
        ctx.fillText(cameraGlyph(e), x0 - 3, mid + 0.5);
      }
    });
  }

  if (rows.energy && data.energy?.length) {
    const [e0, e1] = rows.energy;
    lane("energy", e0, e1, () => {
      const en = data.energy!;
      ctx.beginPath();
      ctx.moveTo(0, e1);
      for (const [i, v] of en.entries()) ctx.lineTo(X(Math.min(dur, i + 0.5)), e1 - Math.max(0, Math.min(1, v)) * (e1 - e0));
      ctx.lineTo(w, e1);
      ctx.closePath();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = t.ash;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  if (p.currentTime !== undefined) {
    const x = snap(X(p.currentTime));
    ctx.fillStyle = t.flash;
    ctx.fillRect(Math.min(w - 1, x), 0, 1, h);
  }
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  shot: CutMapShot,
  i: number,
  r: { x: number; y: number; w: number; h: number },
  o: { t: Tokens; tint?: string; lit: boolean; letterSize: number; dpr: number; thumbs: boolean },
): void {
  const { t } = o;
  const state = shot.state;
  if (state === "sketch") {
    ctx.strokeStyle = o.tint ?? t.seamStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), r.h - 1);
    return;
  }
  const plain = o.tint ?? (i % 2 ? t.seamStrong : t.raised);
  ctx.fillStyle = o.lit ? t.sodium : (shot.color ?? plain);
  if (o.tint && !o.lit) ctx.globalAlpha *= i % 2 ? 0.55 : 0.9;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (o.tint) ctx.globalAlpha = 1;

  // Thumbnails only on the 64 px progress map and taller; a tile's 20 px strip stays colour.
  const img = o.thumbs && shot.thumb && r.w >= 6 && state !== "making" && state !== "empty" ? thumbImage(shot.thumb) : undefined;
  if (img) {
    // Cover-fit the thumbnail into the cell.
    const scale = Math.max(r.w / img.naturalWidth, r.h / img.naturalHeight);
    const sw = r.w / scale;
    const sh = r.h / scale;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, r.x, r.y, r.w, r.h);
  }

  if (state === "making") {
    // Static diagonal hatch: in flight, never animated.
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.strokeStyle = t.seamStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = r.x - r.h; x < r.x + r.w; x += 5) {
      ctx.moveTo(x, r.y + r.h);
      ctx.lineTo(x + r.h, r.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (state === "clip" && r.w >= 10 && r.h >= 12) {
    const s = Math.min(7, r.h * 0.22);
    ctx.fillStyle = t.flash;
    ctx.beginPath();
    ctx.moveTo(r.x + 3, r.y + 3);
    ctx.lineTo(r.x + 3 + s, r.y + 3 + s / 2);
    ctx.lineTo(r.x + 3, r.y + 3 + s);
    ctx.closePath();
    ctx.fill();
  }

  if (!img && !shot.color && !o.tint && shot.slot && r.w >= 9 && r.h >= 12) {
    ctx.font = `650 ${o.letterSize}px Archivo, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = o.lit ? t.sodiumInk : t.ash;
    ctx.fillText(shot.slot[0]!.toUpperCase(), r.x + 3, r.y + r.h / 2 + 0.5);
  }
}

// ---------- component ----------

function shotsSummary(d: CutMapData): string {
  return d.shots.length ? `${d.shots.length} shots` : `${d.sketch?.length ?? 0} parts`;
}

export function CutMap(props: CutMapProps) {
  const { data, height, label, lanes = false } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const progress = useRef<Record<LaneId, number>>({ cuts: 1, flashes: 1, beats: 1, camera: 1, energy: 1 });
  const revealStart = useRef<Partial<Record<LaneId, number>>>({});
  const [focusIndex, setFocusIndex] = useState(-1);
  const frame = useRef(0);
  const latest = useRef(props);
  latest.current = props;
  const focusRef = useRef(focusIndex);
  focusRef.current = focusIndex;

  const interactive = Boolean(props.onSeek || props.onScrub || props.onShot);
  const cssHeight = lanes ? LANES_HEIGHT : height;

  const paint = () => {
    frame.current = 0;
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !size.current.w) return;
    const reduced = reducedMotion();
    // Advance lane reveals.
    const now = performance.now();
    const reveal = latest.current.reveal;
    let animating = false;
    for (const id of LANE_IDS) {
      if (!reveal) {
        progress.current[id] = 1;
        continue;
      }
      if (!reveal[id]) {
        progress.current[id] = 0;
        delete revealStart.current[id];
        continue;
      }
      if (reduced) {
        progress.current[id] = 1;
        continue;
      }
      const start = (revealStart.current[id] ??= now);
      const k = Math.min(1, (now - start) / REVEAL_MS);
      progress.current[id] = 1 - (1 - k) ** 3;
      if (k < 1) animating = true;
    }
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const { w, h } = size.current;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    draw(ctx, latest.current, { w, h, dpr, progress: progress.current, focusIndex: focusRef.current, reduced });
    if (animating) schedule();
  };
  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  };

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => {
      size.current = { w: el.clientWidth, h: el.clientHeight };
      schedule();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    imageWaiters.add(schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    return () => {
      ro.disconnect();
      imageWaiters.delete(schedule);
      document.fonts.removeEventListener("loadingdone", schedule);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  // Every prop change repaints (one frame at most).
  useEffect(schedule);

  const dur = data.durationSec;
  const units = data.shots.length ? data.shots : (data.sketch ?? []);
  const timeAt = (e: PointerEvent | MouseEvent) => {
    const el = canvas.current!;
    const rect = el.getBoundingClientRect();
    return Math.min(dur, Math.max(0, ((e.clientX - rect.left) / rect.width) * dur));
  };
  const current = focusIndex >= 0 ? focusIndex : indexAt(units, props.currentTime ?? 0);

  const step = (to: number) => {
    if (!units.length) return;
    const i = Math.max(0, Math.min(units.length - 1, to));
    setFocusIndex(i);
    props.onSeek?.(units[i]!.start + 1e-3);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const from = current < 0 ? -1 : current;
    if (e.key === "ArrowRight") step(from + 1);
    else if (e.key === "ArrowLeft") step(Math.max(0, from - 1));
    else if (e.key === "Home") step(0);
    else if (e.key === "End") step(units.length - 1);
    else if (e.key === "Enter" && from >= 0) props.onShot?.(from);
    else return;
    e.preventDefault();
  };

  const valueText =
    units.length && current >= 0 ? `${data.shots.length ? "Shot" : "Part"} ${current + 1} of ${units.length}, ${fmtTime(units[current]!.start)}` : fmtTime(props.currentTime ?? 0);
  const a11y = interactive
    ? {
        role: "slider" as const,
        tabIndex: 0,
        "aria-label": label,
        "aria-valuemin": 0,
        "aria-valuemax": Number(dur.toFixed(1)),
        "aria-valuenow": Number((props.currentTime ?? 0).toFixed(1)),
        "aria-valuetext": valueText,
        onKeyDown,
        onFocus: () => setFocusIndex(-1),
        onBlur: () => setFocusIndex(-1),
        onPointerMove: (e: PointerEvent) => {
          const at = timeAt(e);
          props.onScrub?.(at);
          if (e.buttons & 1) props.onSeek?.(at);
        },
        onPointerLeave: () => props.onScrub?.(undefined),
        onClick: (e: MouseEvent) => props.onSeek?.(timeAt(e)),
      }
    : { role: "img" as const, "aria-label": label };

  const table =
    (height >= 36 || lanes) && data.shots.length > 0 ? (
      <div class="kt-sr">
        <table>
          <caption>{`${label}: ${shotsSummary(data)}`}</caption>
          <thead>
            <tr>
              <th scope="col">Shot</th>
              <th scope="col">Starts</th>
              <th scope="col">Ends</th>
            </tr>
          </thead>
          <tbody>
            {data.shots.slice(0, 200).map((s, i) => (
              <tr key={i}>
                <td>{s.label ?? s.slot ?? i + 1}</td>
                <td>{fmtTime(s.start)}</td>
                <td>{fmtTime(s.end)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : null;

  const canvasEl = (
    <canvas ref={canvas} class={["kt-cutmap", interactive && "interactive", props.class].filter(Boolean).join(" ")} style={{ height: `${cssHeight}px` }} {...a11y} />
  );

  if (!lanes)
    return (
      <div class="kt-cutmap-wrap" data-h={height}>
        {canvasEl}
        {table}
      </div>
    );
  return (
    <div class="kt-cutmap-wrap kt-cutmap-lanes">
      <div class="kt-lane-labels" aria-hidden="true">
        {LANE_ROWS.map((r) => (
          <span class="label" style={{ height: `${r.h}px`, opacity: props.reveal && !props.reveal[r.id] ? 0.45 : 1 }}>
            {r.label}
          </span>
        ))}
      </div>
      {canvasEl}
      {table}
    </div>
  );
}
