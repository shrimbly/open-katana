import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Clock } from "./clock.js";
import { useClock } from "./clock.js";
import { cutTimes, editDuration } from "./edits.js";
import type { Editor } from "./store.js";
import { drawText, layout } from "./textdraw.js";
import { timecode, toSec } from "./time.js";

export type ViewMode = "live" | "preview" | "master";

/** The selection colour from tokens.css (canvas strokes can't use var()), read once. */
let sodiumColor: string | undefined;
const sodium = (el: Element) => (sodiumColor ||= getComputedStyle(el).getPropertyValue("--sodium").trim() || "#f2a33a");

interface Props {
  editor: Editor;
  clock: Clock;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  lastEditAt: number;
}

/** Fits a w×h box inside the stage. */
function useFit(stage: HTMLElement | null, w: number, h: number) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect();
      const pad = 32;
      const k = Math.min((r.width - pad) / w, (r.height - pad) / h);
      setSize({ w: Math.max(0, Math.floor(w * k)), h: Math.max(0, Math.floor(h * k)) });
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [stage, w, h]);
  return size;
}

export function Viewer({ editor, clock, mode, setMode, lastEditAt }: Props) {
  const { edl, state, selection, setSelection, apply, render } = editor;
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ index: number; startX: number; startY: number; ax: number; ay: number; key: string } | null>(null);
  const [guide, setGuide] = useState(false);
  const W = edl?.canvas.width ?? 16;
  const H = edl?.canvas.height ?? 9;
  const fit = useFit(stage, W, H);
  const beats = editor.beats;
  const fps = edl?.canvas.fps ?? 24;
  const ctx = { fps, beats };

  const renders = state?.renders ?? {};
  const live = renders.notext;
  const src = mode === "live" ? (live ?? renders.preview) : mode === "preview" ? renders.preview : renders.master;
  const overlay = mode === "live" && Boolean(live);
  const url = src ? `${src.url}?v=${Math.round(src.mtime)}` : undefined;

  useEffect(() => {
    if (edl) {
      clock.duration = editDuration(edl, ctx);
      clock.fps = fps;
    }
  });

  useEffect(() => {
    clock.attach(videoRef.current);
    return () => clock.attach(null);
  }, [url, clock]);

  // Live text draws on a canvas over the picture, every frame while playing and on every edit.
  const drawRef = useRef<() => void>(() => undefined);
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas || !edl) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(fit.w * dpr);
    const ch = Math.round(fit.h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const g = canvas.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const k = (fit.w / W) * dpr;
    g.setTransform(k, 0, 0, k, 0, 0);
    const t = clock.time;
    edl.text.forEach((ev, i) => {
      const a = toSec(ev.start, fps, beats);
      const b = toSec(ev.end, fps, beats);
      const visible = t >= a - 1e-6 && t < b;
      const selected = selection?.kind === "text" && selection.index === i;
      if (overlay && visible && !ev.behind) drawText(g, ev, (t - a) * 1000, (b - a) * 1000, W, H, k, a);
      if (selected && (visible || drag.current)) {
        const L = layout(g, ev, W, H);
        g.save();
        g.strokeStyle = sodium(canvas);
        g.lineWidth = 1.5 / k;
        g.setLineDash(ev.behind ? [6 / k, 4 / k] : []);
        const pad = L.fs * 0.08;
        g.strokeRect(L.box.x - pad, L.box.y - pad, L.box.w + pad * 2, L.box.h + pad * 2);
        g.restore();
      }
    });
    // Flashes that wash over the titles sit above the live text, as in the render.
    if (overlay) {
      for (const f of edl.flashes) {
        if (!f.overText) continue;
        const a = toSec(f.at, fps, beats);
        if (t < a || t >= a + f.duration) continue;
        g.save();
        g.globalAlpha = f.intensity * (1 - (t - a) / f.duration);
        g.fillStyle = f.color === "white" ? "#FFFFFF" : f.color === "black" ? "#000000" : f.color;
        g.fillRect(0, 0, W, H);
        g.restore();
      }
    }
    if (guide) {
      g.save();
      g.strokeStyle = sodium(canvas);
      g.globalAlpha = 0.8;
      g.lineWidth = 1 / k;
      g.setLineDash([4 / k, 4 / k]);
      g.beginPath();
      g.moveTo(W / 2, 0);
      g.lineTo(W / 2, H);
      g.stroke();
      g.restore();
    }
  };
  useEffect(() => clock.subscribe(() => drawRef.current()), [clock]);
  useEffect(() => {
    drawRef.current();
    void document.fonts.ready.then(() => drawRef.current());
  });

  const toScript = (e: PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!edl || !overlay) return;
    const p = toScript(e);
    const g = canvasRef.current!.getContext("2d")!;
    const t = clock.time;
    let hit = -1;
    edl.text.forEach((ev, i) => {
      const a = toSec(ev.start, fps, beats);
      const b = toSec(ev.end, fps, beats);
      if (t < a - 1e-6 || t >= b) return;
      const { box, fs } = layout(g, ev, W, H);
      const pad = fs * 0.1;
      if (p.x >= box.x - pad && p.x <= box.x + box.w + pad && p.y >= box.y - pad && p.y <= box.y + box.h + pad) hit = i;
    });
    if (hit < 0) {
      if (selection?.kind === "text") setSelection(null);
      return;
    }
    setSelection({ kind: "text", index: hit });
    const ev = edl.text[hit]!;
    const L = layout(g, ev, W, H);
    const ax = ev.align === "left" ? L.box.x : ev.align === "right" ? L.box.x + L.box.w : L.box.x + L.box.w / 2;
    drag.current = { index: hit, startX: p.x, startY: p.y, ax, ay: L.box.y + L.box.h / 2, key: `drag:text-pos:${hit}:${Date.now()}` };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toScript(e);
    let x = d.ax + (p.x - d.startX);
    const y = d.ay + (p.y - d.startY);
    const ev = edl!.text[d.index]!;
    const centred = ev.align === "center" && Math.abs(x - W / 2) < W * 0.012;
    if (centred) x = W / 2;
    setGuide(centred);
    const pos: [number, number] = [+Math.min(1, Math.max(0, x / W)).toFixed(4), +Math.min(1, Math.max(0, y / H)).toFixed(4)];
    apply((draft) => {
      draft.text[d.index]!.position = pos;
    }, d.key);
  };

  const onPointerUp = () => {
    drag.current = null;
    setGuide(false);
  };

  const pictureBusy = render.running && render.mode === "notext";
  const rendered = mode === "preview" ? renders.preview : mode === "master" ? renders.master : undefined;
  const stale = rendered && lastEditAt > rendered.mtime;

  return (
    <section class="viewer" aria-label="Viewer">
      <div class="stage" ref={setStage}>
        {edl ? (
          <div class="frame" style={{ width: `${fit.w}px`, height: `${fit.h}px` }}>
            {url ? (
              <video ref={videoRef} src={url} preload="auto" playsInline onLoadedData={() => clock.attach(videoRef.current)} />
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--dim)" }}>
                {mode === "live" ? "Building the picture preview…" : "Not rendered yet."}
              </div>
            )}
            <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} style={{ cursor: overlay ? "default" : "auto" }} />
          </div>
        ) : (
          <div class="empty-stage">
            <p>This project has no edit yet. Ask the agent to cut one; it appears here as soon as it is saved.</p>
          </div>
        )}
        {mode === "live" && !live && renders.preview && <div class="stage-note">Showing the last preview render with its text burned in. Live text turns on when the picture-only preview is ready.</div>}
        {pictureBusy && (
          <div class="stage-note">
            <span class="dot" />
            Updating picture{render.total ? ` · shot ${render.done} of ${render.total}` : "…"}
          </div>
        )}
        {stale && !render.running && <div class="stage-note">This render is older than your latest changes.</div>}
      </div>
      <Transport editor={editor} clock={clock} mode={mode} setMode={setMode} />
    </section>
  );
}

function Transport({ editor, clock, mode, setMode }: { editor: Editor; clock: Clock; mode: ViewMode; setMode: (m: ViewMode) => void }) {
  useClock(clock);
  const { edl, state } = editor;
  const fps = edl?.canvas.fps ?? 24;
  const beats = editor.beats;
  const t = clock.time;
  let beat = -1;
  for (let i = 0; i < beats.length; i++) if (beats[i]! <= t + 1e-6) beat = i;
  const cuts = edl ? cutTimes(edl, { fps, beats }) : [];
  const prevCut = () => clock.seek([...cuts].reverse().find((c) => c < t - 0.5 / fps) ?? 0);
  const nextCut = () => clock.seek(cuts.find((c) => c > t + 0.5 / fps) ?? clock.duration);
  return (
    <div class="transport">
      <div>
        <div class="timecode" aria-live="off">
          {timecode(t, fps)}
          <small>/ {timecode(clock.duration, fps).slice(3)}</small>
        </div>
        <div class="beat-readout">
          {beat >= 0 ? (
            <>
              Bar <b>{Math.floor(beat / 4) + 1}</b> · beat {(beat % 4) + 1} · frame {clock.frame}
            </>
          ) : (
            <>Frame {clock.frame}</>
          )}
        </div>
      </div>
      <div class="transport-buttons">
        <button class="btn" type="button" onClick={prevCut} title="Previous cut (↑)" aria-label="Previous cut">
          ⇤
        </button>
        <button class="btn" type="button" onClick={() => clock.seekFrame(clock.frame - 1)} title="Back one frame (←)" aria-label="Back one frame">
          ‹
        </button>
        <button class="btn play" type="button" onClick={() => clock.toggle()} title="Play / pause (space)">
          {clock.playing ? "Pause" : "Play"}
        </button>
        <button class="btn" type="button" onClick={() => clock.seekFrame(clock.frame + 1)} title="Forward one frame (→)" aria-label="Forward one frame">
          ›
        </button>
        <button class="btn" type="button" onClick={nextCut} title="Next cut (↓)" aria-label="Next cut">
          ⇥
        </button>
      </div>
      <div class="view-switch">
        <div class="segmented" role="group" aria-label="What the viewer shows">
          <button type="button" aria-pressed={mode === "live"} onClick={() => setMode("live")} title="The picture with text drawn live as you edit">
            Live
          </button>
          <button type="button" aria-pressed={mode === "preview"} disabled={!state?.renders.preview} onClick={() => setMode("preview")} title="The last half-resolution render, text included">
            Preview render
          </button>
          <button type="button" aria-pressed={mode === "master"} disabled={!state?.renders.master} onClick={() => setMode("master")} title="The last full-quality render">
            Final render
          </button>
        </div>
      </div>
    </div>
  );
}
