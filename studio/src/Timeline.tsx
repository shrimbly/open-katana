import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type AssetT, type Edl, type ShotT } from "./api.js";
import type { Clock } from "./clock.js";
import { addFlash, addSfx, addText, type Ctx, editDuration, moveShotEdge, sec, sourceAdvance, splitShot, stackRows } from "./edits.js";
import type { Editor, Selection } from "./store.js";
import { clamp, type Snap, type Time } from "./time.js";

const HEAD = 104;
const TEXT_ROW = 27;
export const ASSET_MIME = "application/x-katana-asset";

interface Props {
  editor: Editor;
  clock: Clock;
  snap: Snap;
  setSnap: (s: Snap) => void;
  pps: number;
  setPps: (n: number) => void;
  showShortcuts: () => void;
}

interface Drag {
  kind: Selection["kind"];
  index: number;
  edge: "start" | "end" | "move" | "slip";
  origin: Edl;
  x0: number;
  key: string;
  moved: boolean;
}

interface Candidate {
  sec: number;
  value: Time;
}

const isColor = (s: string) => s === "black" || s === "white" || /^#[0-9a-f]{6}$/i.test(s);

function shotTags(s: ShotT): string {
  const tags: string[] = [];
  const src = s.source;
  if (src.speed === 0) tags.push("freeze");
  else if (src.speedTo !== undefined) tags.push(`ramp ${src.speed}→${src.speedTo}`);
  else if (src.speed !== 1) tags.push(`×${src.speed}`);
  if (src.reverse) tags.push("rev");
  const c = s.camera;
  if (c) {
    if (Array.isArray(c.zoom)) tags.push(c.zoom[1] >= c.zoom[0] ? "push" : "pull");
    if (c.punch) tags.push(`punch×${c.punch.at.length}`);
    if (c.shake) tags.push("shake");
    if (c.pan) tags.push("pan");
    if (c.roll !== undefined) tags.push("roll");
    if (c.handheld) tags.push("drift");
  }
  const f = s.fx;
  if (f) {
    if (f.look && f.look !== "none") tags.push(f.look);
    if (f.flashIn || f.flashOut) tags.push("flash");
    if (f.dipIn || f.dipOut) tags.push("dip");
    if (f.glow) tags.push("glow");
    if (f.rgbSplit) tags.push("rgb");
    if (f.trail) tags.push("trail");
    if (f.strobe) tags.push("strobe");
    if (f.bw) tags.push("b&w");
    if (f.invert) tags.push("invert");
    if (f.blur) tags.push("blur");
    if (f.mirror) tags.push("mirror");
  }
  if (f?.mask) tags.push(f.mask.shape === "circle" ? "iris" : "mask");
  if (f?.duotone) tags.push("duotone");
  if (f?.tint) tags.push("tint");
  if (f?.keepColor) tags.push("keep colour");
  if (f?.threshold !== undefined) tags.push("1-bit");
  if (f?.motionBlur) tags.push("whip blur");
  if (f?.zoomBlur) tags.push("zoom blur");
  if (f?.frameStrobe) tags.push("frame strobe");
  if (f?.leak) tags.push("leak");
  if (s.background) tags.push("bg");
  if (s.tile) tags.push(`tiles ${s.tile.cols}×${s.tile.rows}`);
  if (s.layers?.length) tags.push(`layers×${s.layers.length}`);
  if (src.matte) tags.push("matte");
  return tags.join(" · ");
}

export function Timeline({ editor, clock, snap, setSnap, pps, setPps, showShortcuts }: Props) {
  const { edl, state, selection, setSelection, apply, locked } = editor;
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [guide, setGuide] = useState<number | null>(null);
  const [dropShot, setDropShot] = useState<number | null>(null);
  const [showRef, setShowRef] = useState(true);
  const [wave, setWave] = useState<{ perSec: number; peaks: number[] } | null>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);

  const fps = edl?.canvas.fps ?? 24;
  const beats = editor.beats;
  const ctx: Ctx = { fps, beats };
  const D = edl ? editDuration(edl, ctx) : 0;
  const maxPps = Math.max(40, Math.min(640, 30000 / Math.max(D, 1)));
  const innerW = HEAD + D * pps + 160;
  const assets = useMemo(() => new Map((state?.assets ?? []).map((a) => [a.id, a])), [state?.assets]);
  const reference = state?.assets.find((a) => a.role === "reference");
  const refCuts = useMemo(() => {
    if (!state?.reference || !edl?.audio) return [];
    const isRef = edl.audio.asset === "ref" || edl.audio.asset === reference?.id;
    if (!isRef) return [];
    return state.reference.shots.slice(1).map((s) => s.startSec - (edl.audio?.offset ?? 0)).filter((t) => t > 0 && t < D);
  }, [state?.reference, edl?.audio, D, reference?.id]);

  // Soundtrack waveform.
  const audioAsset = edl?.audio?.asset;
  useEffect(() => {
    if (!audioAsset) return setWave(null);
    api.waveform(editor.projectId, audioAsset).then(setWave, () => setWave(null));
  }, [audioAsset, editor.projectId]);
  useEffect(() => {
    const c = waveRef.current;
    if (!c || !wave || !edl?.audio) return;
    const w = Math.max(1, Math.ceil(D * pps));
    const h = 44;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.min(32000, Math.ceil(w * dpr));
    c.height = h * dpr;
    c.style.width = `${w}px`;
    const g = c.getContext("2d")!;
    g.scale(c.width / w, dpr);
    g.fillStyle = getComputedStyle(c).getPropertyValue("--wave").trim() || "rgba(154,158,166,0.55)";
    const off = edl.audio.offset;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((off + x / pps) * wave.perSec);
      const i1 = Math.max(i0 + 1, Math.floor((off + (x + 1) / pps) * wave.perSec));
      let m = 0;
      for (let i = i0; i < i1 && i < wave.peaks.length; i++) m = Math.max(m, wave.peaks[i]!);
      const bh = Math.max(1, m * (h - 6));
      g.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [wave, pps, D, edl?.audio?.offset, edl?.audio]);

  // The playhead moves without re-rendering the timeline; it follows playback when it leaves the view.
  useEffect(
    () =>
      clock.subscribe(() => {
        const x = HEAD + clock.time * pps;
        if (playheadRef.current) playheadRef.current.style.left = `${x}px`;
        const sc = scrollRef.current;
        if (sc && clock.playing && (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft + HEAD)) sc.scrollLeft = x - HEAD - 60;
      }),
    [clock, pps],
  );

  const timeAt = (clientX: number) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return clamp((clientX - r.left + scrollRef.current!.scrollLeft - HEAD) / pps, 0, D);
  };

  // Ctrl/Cmd + wheel zooms around the pointer.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const t = timeAt(e.clientX);
      const next = clamp(pps * Math.exp(-e.deltaY * 0.0025), 8, maxPps);
      setPps(next);
      const r = sc.getBoundingClientRect();
      requestAnimationFrame(() => (sc.scrollLeft = t * next - (e.clientX - r.left - HEAD)));
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  });

  if (!edl) return <section class="timeline" aria-label="Timeline" />;

  const shots = edl.shots.map((s) => ({ a: sec(s.start, ctx), b: sec(s.end, ctx) }));
  const texts = edl.text.map((t) => ({ a: sec(t.start, ctx), b: sec(t.end, ctx) }));
  const { rows: textRows, count: textRowCount } = stackRows(texts);
  const textH = textRowCount * TEXT_ROW + 8;
  const beatPeriod = beats.length > 1 ? (beats.at(-1)! - beats[0]!) / (beats.length - 1) : 0;

  /** Snap candidates for a drag: beats, other edges and the playhead. */
  const candidates = (exclude: Set<string>): Candidate[] => {
    const out: Candidate[] = [];
    if (snap === "off") return out;
    if (snap === "beats") {
      beats.forEach((b, i) => {
        out.push({ sec: b, value: `b${i}` });
        if (i + 1 < beats.length) out.push({ sec: (b + beats[i + 1]!) / 2, value: `b${i}.5` });
      });
    }
    edl.shots.forEach((s, i) => {
      if (!exclude.has(`shot:${i}:start`)) out.push({ sec: shots[i]!.a, value: s.start });
      if (!exclude.has(`shot:${i}:end`)) out.push({ sec: shots[i]!.b, value: s.end });
    });
    edl.text.forEach((t, i) => {
      if (exclude.has(`text:${i}`)) return;
      out.push({ sec: texts[i]!.a, value: t.start }, { sec: texts[i]!.b, value: t.end });
    });
    out.push({ sec: clock.time, value: +(clock.frame / fps).toFixed(4) });
    return out;
  };

  const snapSec = (s: number, cands: Candidate[]): Candidate & { snapped: boolean } => {
    const tol = 8 / pps;
    let best: Candidate | null = null;
    for (const c of cands) if (Math.abs(c.sec - s) <= tol && (!best || Math.abs(c.sec - s) < Math.abs(best.sec - s))) best = c;
    if (best) return { ...best, snapped: true };
    const f = Math.max(0, Math.round(s * fps));
    return { sec: f / fps, value: +(f / fps).toFixed(4), snapped: false };
  };

  const restore = (draft: Edl, origin: Edl) => {
    draft.shots = structuredClone(origin.shots);
    draft.text = structuredClone(origin.text);
    draft.flashes = structuredClone(origin.flashes);
    draft.sfx = structuredClone(origin.sfx);
  };

  const onDragMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const dt = dx / pps;
    const o = d.origin;
    let guideAt: number | null = null;
    apply((draft) => {
      restore(draft, o);
      if (d.kind === "shot") {
        const s = o.shots[d.index]!;
        if (d.edge === "slip") {
          const dur = shots[d.index]!.b - shots[d.index]!.a;
          const asset = assets.get(s.source.asset);
          const room = asset?.durationSec !== undefined ? Math.max(0, asset.durationSec - sourceAdvance(s, dur, dur)) : Number.POSITIVE_INFINITY;
          draft.shots[d.index]!.source.in = +clamp(s.source.in - dt * Math.max(s.source.speed, 0.05), 0, room).toFixed(4);
          return;
        }
        if (d.edge === "move") return;
        const edge = d.edge;
        const from = edge === "start" ? shots[d.index]!.a : shots[d.index]!.b;
        const c = snapSec(from + dt, candidates(new Set([`shot:${d.index}:start`, `shot:${d.index}:end`])).filter((k) => Math.abs(k.sec - from) > 1e-4));
        if (moveShotEdge(draft, d.index, edge, c.value, ctx) && c.snapped) guideAt = c.sec;
        return;
      }
      if (d.kind === "text") {
        const t = o.text[d.index]!;
        const { a, b } = texts[d.index]!;
        const cands = candidates(new Set([`text:${d.index}`]));
        const target = draft.text[d.index]!;
        if (d.edge === "move") {
          const cs = snapSec(a + dt, cands);
          const ce = snapSec(b + dt, cands);
          const useEnd = ce.snapped && (!cs.snapped || Math.abs(ce.sec - (b + dt)) < Math.abs(cs.sec - (a + dt)));
          const shift = (useEnd ? ce.sec - b : cs.sec - a) || 0;
          const na = Math.max(0, a + shift);
          const beatShift = typeof t.start === "string" && t.start[0] === "b" && typeof t.end === "string" && t.end[0] === "b";
          const startVal = useEnd ? null : cs.value;
          if (beatShift && typeof startVal === "string" && startVal[0] === "b") {
            const k = Number(startVal.slice(1)) - Number(t.start.toString().slice(1));
            target.start = startVal;
            target.end = `b${+(Number(t.end.toString().slice(1)) + k).toFixed(3)}`;
          } else if (useEnd) {
            target.end = ce.value;
            target.start = +Math.max(0, ce.sec - (b - a)).toFixed(4);
          } else {
            target.start = cs.value;
            target.end = +(na + (b - a)).toFixed(4);
          }
          guideAt = useEnd ? ce.sec : cs.snapped ? cs.sec : null;
        } else {
          const from = d.edge === "start" ? a : b;
          const c = snapSec(from + dt, cands);
          const minGap = 1 / fps;
          if (d.edge === "start" && c.sec < b - minGap) target.start = c.value;
          if (d.edge === "end" && c.sec > a + minGap) target.end = c.value;
          if (c.snapped) guideAt = c.sec;
        }
        return;
      }
      const list = d.kind === "flash" ? o.flashes : o.sfx;
      const at = sec(list[d.index]!.at, ctx);
      const c = snapSec(at + dt, candidates(new Set()));
      (d.kind === "flash" ? draft.flashes : draft.sfx)[d.index]!.at = c.value;
      if (c.snapped) guideAt = c.sec;
    }, d.key);
    setGuide(guideAt);
  };

  const onDragEnd = () => {
    window.removeEventListener("pointermove", onDragMove);
    const d = dragRef.current;
    dragRef.current = null;
    setGuide(null);
    if (d && !d.moved && d.edge !== "slip") {
      // A click selects and moves the playhead into the item so the viewer shows it.
      const at = d.kind === "shot" ? shots[d.index]!.a : d.kind === "text" ? texts[d.index]!.a : sec((d.kind === "flash" ? edl.flashes : edl.sfx)[d.index]!.at, ctx);
      if (clock.time < at || (d.kind === "shot" && clock.time >= shots[d.index]!.b) || (d.kind === "text" && clock.time >= texts[d.index]!.b)) clock.seek(at + (d.kind === "text" ? Math.min(0.3, (texts[d.index]!.b - at) / 2) : 0));
    }
  };

  const startDrag = (e: PointerEvent, kind: Selection["kind"], index: number, edge: Drag["edge"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSelection({ kind, index });
    const slip = kind === "shot" && edge === "move" && e.altKey;
    dragRef.current = { kind, index, edge: slip ? "slip" : edge, origin: structuredClone(edl), x0: e.clientX, key: `drag:${kind}:${index}:${edge}:${Date.now()}`, moved: false };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd, { once: true });
  };

  const scrub = (e: PointerEvent) => {
    if (e.button !== 0) return;
    clock.seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => clock.seek(timeAt(ev.clientX));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  };

  const onLaneDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    setSelection(null);
    scrub(e);
  };

  const sel = (kind: Selection["kind"], i: number) => selection?.kind === kind && selection.index === i;
  const playheadValue = (): Time => {
    const t = clock.time;
    if (snap === "beats") {
      const c = snapSec(t, candidates(new Set()));
      if (c.snapped) return c.value;
    }
    return +(clock.frame / fps).toFixed(4);
  };

  // Ruler ticks.
  const secStep = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 64) ?? 60;
  const secTicks: number[] = [];
  for (let t = 0; t <= D + 1e-6; t += secStep) secTicks.push(+t.toFixed(3));
  const showBeats = beatPeriod * pps >= 5;
  const showBarLabels = beatPeriod * 4 * pps >= 26;

  const lanes = { ruler: 34, ref: refCuts.length ? 16 : 0, text: textH, flash: 22, picture: 70, sfx: 26, music: 46 };

  return (
    <section class="timeline" aria-label="Timeline">
      <div class="tl-toolbar">
        <div class="group">
          <span class="label">Snap</span>
          <div class="segmented" role="group" aria-label="Snapping">
            {(["beats", "frames", "off"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={snap === s} onClick={() => setSnap(s)} disabled={s === "beats" && !beats.length}>
                {s === "beats" ? "Beats" : s === "frames" ? "Edges" : "Off"}
              </button>
            ))}
          </div>
        </div>
        <div class="group">
          <span class="label">Zoom</span>
          <input type="range" min={Math.log(8)} max={Math.log(maxPps)} step={0.01} value={Math.log(pps)} onInput={(e) => setPps(Math.exp(Number((e.target as HTMLInputElement).value)))} aria-label="Timeline zoom" />
          <button
            class="btn small ghost"
            type="button"
            onClick={() => {
              const w = (scrollRef.current?.clientWidth ?? 800) - HEAD - 40;
              setPps(clamp(w / Math.max(D, 0.1), 8, maxPps));
            }}
          >
            Fit
          </button>
        </div>
        {refCuts.length > 0 && (
          <label class="check" title="Hairlines where the reference edit cuts">
            <input type="checkbox" checked={showRef} onChange={(e) => setShowRef((e.target as HTMLInputElement).checked)} />
            Reference cuts
          </label>
        )}
        <span class="spacer" />
        <div class="group">
          <button
            class="btn small"
            type="button"
            disabled={locked}
            title="Split the shot under the playhead (S)"
            onClick={() => {
              const i = edl.shots.findIndex((_, k) => shots[k]!.a < clock.time && clock.time < shots[k]!.b);
              if (i >= 0) apply((d) => void splitShot(d, i, +(clock.frame / fps).toFixed(4), ctx));
            }}
          >
            Split
          </button>
          <button
            class="btn small"
            type="button"
            disabled={locked}
            title="Add text at the playhead (T)"
            onClick={() => {
              let idx = 0;
              apply((d) => void (idx = addText(d, playheadValue(), ctx)));
              setTimeout(() => setSelection({ kind: "text", index: idx }));
            }}
          >
            + Text
          </button>
          <button
            class="btn small"
            type="button"
            disabled={locked}
            title="Add a flash at the playhead (F)"
            onClick={() => {
              let idx = 0;
              apply((d) => void (idx = addFlash(d, playheadValue(), ctx)));
              setTimeout(() => setSelection({ kind: "flash", index: idx }));
            }}
          >
            + Flash
          </button>
          <button
            class="btn small"
            type="button"
            disabled={locked}
            title="Add a sound effect at the playhead"
            onClick={() => {
              let idx = 0;
              apply((d) => void (idx = addSfx(d, playheadValue(), "hit", ctx)));
              setTimeout(() => setSelection({ kind: "sfx", index: idx }));
            }}
          >
            + Sound
          </button>
          <button class="btn small ghost" type="button" onClick={showShortcuts} title="Keyboard shortcuts (?)">
            Shortcuts
          </button>
        </div>
      </div>

      <div class="tl-scroll" ref={scrollRef}>
        <div class="tl-inner" style={{ width: `${innerW}px`, minHeight: "100%" }}>
          {/* Bar lines and reference cuts run behind every lane. */}
          <div style={{ position: "absolute", left: `${HEAD}px`, top: 0, bottom: 0, right: 0, pointerEvents: "none" }}>
            {showBeats &&
              beats.map((b, i) => (i % 4 === 0 ? <div key={`g${i}`} class="grid-line bar" style={{ left: `${b * pps}px` }} /> : null))}
            {showRef && refCuts.map((t, i) => <div key={`r${i}`} class="grid-line ref" style={{ left: `${t * pps}px`, top: `${lanes.ruler + lanes.ref + lanes.text + lanes.flash}px`, bottom: "auto", height: `${lanes.picture}px` }} />)}
          </div>

          <div class="lane ruler" style={{ height: `${lanes.ruler}px` }} onPointerDown={scrub}>
            <div class="lane-head">
              <span class="label">{beats.length ? "Bars" : "Time"}</span>
            </div>
            <div class="lane-body">
              {secTicks.map((t) => (
                <div key={`s${t}`}>
                  <div class="tick sec" style={{ left: `${t * pps}px` }} />
                  <span class="tick-label sec" style={{ left: `${t * pps}px` }}>
                    {secStep < 1 ? t.toFixed(2) : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`}
                  </span>
                </div>
              ))}
              {showBeats &&
                beats.map((b, i) =>
                  b <= D ? (
                    <div key={`b${i}`}>
                      <div class={`tick ${i % 4 === 0 ? "bar" : "beat"}`} style={{ left: `${b * pps}px` }} />
                      {i % 4 === 0 && showBarLabels && (
                        <span class="tick-label bar" style={{ left: `${b * pps}px` }}>
                          {i / 4 + 1}
                        </span>
                      )}
                    </div>
                  ) : null,
                )}
            </div>
          </div>

          {lanes.ref > 0 && showRef && (
            <div class="lane" style={{ height: `${lanes.ref}px` }} onPointerDown={onLaneDown}>
              <div class="lane-head">
                <span class="label">Reference</span>
              </div>
              <div class="lane-body">
                {refCuts.map((t, i) => (
                  <div key={i} class="ref-cut" style={{ left: `${t * pps}px` }} />
                ))}
              </div>
            </div>
          )}

          <div class="lane" style={{ height: `${lanes.text}px` }} onPointerDown={onLaneDown}>
            <div class="lane-head">
              <span class="label">Text</span>
            </div>
            <div class="lane-body">
              {edl.text.map((t, i) => {
                const { a, b } = texts[i]!;
                return (
                  <div
                    key={`t${i}`}
                    class={`clip text-chip${sel("text", i) ? " selected" : ""}${t.behind ? " behind" : ""}`}
                    style={{ left: `${a * pps}px`, width: `${Math.max(4, (b - a) * pps)}px`, top: `${4 + textRows[i]! * TEXT_ROW}px`, fontFamily: `"${t.font}", var(--ui)`, fontStyle: t.italic ? "italic" : undefined }}
                    title={`${t.text} · ${t.font} · ${t.anim}${t.behind ? " · behind subject" : ""}`}
                    onPointerDown={(e) => startDrag(e, "text", i, "move")}
                  >
                    <span>{t.uppercase ? t.text.toUpperCase() : t.text}</span>
                    <div class="edge l" onPointerDown={(e) => startDrag(e, "text", i, "start")} />
                    <div class="edge r" onPointerDown={(e) => startDrag(e, "text", i, "end")} />
                  </div>
                );
              })}
            </div>
          </div>

          <div class="lane" style={{ height: `${lanes.flash}px` }} onPointerDown={onLaneDown}>
            <div class="lane-head">
              <span class="label">Flashes</span>
            </div>
            <div class="lane-body">
              {edl.flashes.map((f, i) => (
                <div
                  key={`f${i}`}
                  class={`flash-mark ${f.color.startsWith("#") ? "tint" : f.color}${sel("flash", i) ? " selected" : ""}${f.overText ? " over" : ""}`}
                  style={{ left: `${sec(f.at, ctx) * pps - 2}px`, width: `${Math.max(5, f.duration * pps)}px`, opacity: 0.35 + 0.65 * f.intensity, background: f.color.startsWith("#") ? f.color : undefined }}
                  title={`${f.color} flash · ${Math.round(f.duration * 1000)} ms${f.overText ? " · over titles" : ""}`}
                  onPointerDown={(e) => startDrag(e, "flash", i, "move")}
                />
              ))}
            </div>
          </div>

          <div class="lane" style={{ height: `${lanes.picture}px` }} onPointerDown={onLaneDown}>
            <div class="lane-head">
              <span class="label">Picture</span>
            </div>
            <div class="lane-body">
              {edl.shots.map((s, i) => (
                <ShotClip
                  key={`s${i}`}
                  shot={s}
                  index={i}
                  a={shots[i]!.a}
                  b={shots[i]!.b}
                  pps={pps}
                  height={lanes.picture - 8}
                  aspect={edl.canvas.width / edl.canvas.height}
                  asset={assets.get(s.source.asset)}
                  projectId={editor.projectId}
                  selected={sel("shot", i)}
                  drop={dropShot === i}
                  onDown={(e, edge) => startDrag(e, "shot", i, edge)}
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types.includes(ASSET_MIME)) {
                      e.preventDefault();
                      setDropShot(i);
                    }
                  }}
                  onDragLeave={() => setDropShot(null)}
                  onDrop={(e) => {
                    const id = e.dataTransfer?.getData(ASSET_MIME);
                    setDropShot(null);
                    if (!id) return;
                    e.preventDefault();
                    apply((d) => {
                      const src = d.shots[i]!.source;
                      src.asset = id;
                      src.in = 0;
                      delete src.matte;
                    });
                    setSelection({ kind: "shot", index: i });
                  }}
                />
              ))}
            </div>
          </div>

          <div class="lane" style={{ height: `${lanes.sfx}px` }} onPointerDown={onLaneDown}>
            <div class="lane-head">
              <span class="label">Sound FX</span>
            </div>
            <div class="lane-body">
              {edl.sfx.map((c, i) => (
                <div key={`x${i}`} class={`sfx-mark${sel("sfx", i) ? " selected" : ""}`} style={{ left: `${sec(c.at, ctx) * pps - 1}px` }} onPointerDown={(e) => startDrag(e, "sfx", i, "move")} title={`${c.sound} · ${c.gainDb} dB`}>
                  {assets.get(c.sound)?.label ?? c.sound}
                </div>
              ))}
            </div>
          </div>

          <div class="lane" style={{ height: `${lanes.music}px` }} onPointerDown={onLaneDown}>
            <div class="lane-head">
              <span class="label">Music</span>
            </div>
            <div class="lane-body">{edl.audio ? <canvas ref={waveRef} class="wave" height={44} /> : <span class="hint" style={{ padding: "12px" }}>Silent</span>}</div>
          </div>

          {guide !== null && <div class="snap-guide" style={{ left: `${HEAD + guide * pps}px` }} />}
          <div class="playhead" ref={playheadRef} style={{ left: `${HEAD + clock.time * pps}px` }}>
            <span class="cap" />
          </div>
        </div>
      </div>
    </section>
  );
}

function ShotClip(props: {
  shot: ShotT;
  index: number;
  a: number;
  b: number;
  pps: number;
  height: number;
  aspect: number;
  asset?: AssetT;
  projectId: string;
  selected: boolean;
  drop: boolean;
  onDown: (e: PointerEvent, edge: Drag["edge"]) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}) {
  const { shot, a, b, pps, height, asset } = props;
  const width = Math.max(2, (b - a) * pps);
  const dur = b - a;
  const thumbW = Math.max(24, height * props.aspect);
  const src = shot.source.asset;
  const color = isColor(src) ? src : null;
  let thumbs: string[] = [];
  if (!color && asset && asset.kind !== "audio") {
    const n = Math.max(1, Math.ceil(width / thumbW));
    thumbs = Array.from({ length: Math.min(n, 24) }, (_, k) => {
      if (asset.kind === "image") return api.thumb(props.projectId, asset.id, 0, 120);
      const tau = ((k + 0.5) / n) * dur;
      let t = shot.source.reverse ? shot.source.in + sourceAdvance(shot, dur - tau, dur) : shot.source.in + sourceAdvance(shot, tau, dur);
      t = Math.round(Math.min(t, Math.max(0, (asset.durationSec ?? t) - 0.05)) * 10) / 10;
      return api.thumb(props.projectId, asset.id, t, 120);
    });
  }
  // How much of the shot the clip can't cover (its last frame holds there).
  let overrun = 0;
  if (asset?.kind === "video" && asset.durationSec !== undefined && shot.source.speed > 0) {
    const need = sourceAdvance(shot, dur, dur);
    const have = asset.durationSec - shot.source.in;
    if (need > have + 0.05) overrun = dur * (1 - Math.max(0, have) / need);
  }
  const label = color ? (src === "black" ? "Black" : src === "white" ? "White" : src) : src;
  const tags = shotTags(shot);
  return (
    <div
      class={`clip shot${props.selected ? " selected" : ""}${props.drop ? " drop" : ""}`}
      style={{ left: `${a * pps}px`, width: `${width}px`, background: color ?? undefined }}
      title={`${shot.id ? `${shot.id} · ` : ""}${label}${asset?.label ? `\n${asset.label}` : ""}${shot.note ? `\n${shot.note}` : ""}\nAlt-drag to slip the clip`}
      onPointerDown={(e) => props.onDown(e, "move")}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
    >
      {thumbs.map((u, k) => (
        <img key={k} src={u} alt="" loading="lazy" draggable={false} style={{ width: `${thumbW}px` }} />
      ))}
      {overrun > 0 && <div class="overrun" style={{ width: `${overrun * pps}px` }} title="The clip runs out here; its last frame holds." />}
      {width > 34 && <span class="shot-label">{label}</span>}
      {width > 60 && tags && <span class="shot-tags">{tags}</span>}
      <div class="edge l" onPointerDown={(e) => props.onDown(e, "start")} />
      <div class="edge r" onPointerDown={(e) => props.onDown(e, "end")} />
    </div>
  );
}
