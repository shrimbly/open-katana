import { useEffect, useState } from "preact/hooks";
import type { Edl, ShotT, TextT } from "./api.js";
import { type Clock, useClock } from "./clock.js";
import { Check, Chips, ColorField, Field, NumberBox, Section, Slider, TimeField } from "./controls.js";
import { applyStyleToAll, type Ctx, sec, setOpt, splitShot } from "./edits.js";
import { fontCatalog, loadFonts } from "./fonts.js";
import type { Editor } from "./store.js";

const LOOKS = ["none", "teal-night", "cold-blue", "warm-film", "bw-contrast", "bleach", "crushed", "sepia", "neon", "dreamy"] as const;
const ANIMS = ["none", "pop", "slam", "fade", "rise", "type", "flicker", "glitch"] as const;
const EXITS = ["none", "fade", "flicker", "shrink", "blur"] as const;
const EXIT_LABELS = { none: "Cut", fade: "Fade", flicker: "Flicker", shrink: "Shrink", blur: "Blur" };
const WEIGHTS = [300, 400, 500, 700, 900] as const;
const WEIGHT_LABELS = { 300: "Light", 400: "Regular", 500: "Medium", 700: "Bold", 900: "Black" } as Record<number, string>;
const POSITIONS = ["top", "upper-third", "center", "lower-third", "bottom"] as const;
const POSITION_LABELS = { top: "Top", "upper-third": "Upper third", center: "Centre", "lower-third": "Lower third", bottom: "Bottom" };
const ANIM_LABELS = { none: "None", pop: "Pop", slam: "Slam", fade: "Fade", rise: "Rise", type: "Type", flicker: "Flicker", glitch: "Glitch" };
const BUILTIN_SFX = ["whoosh", "hit", "boom", "riser", "tick", "glitch"];

interface Props {
  editor: Editor;
  clock: Clock;
}

export function Inspector({ editor, clock }: Props) {
  const { edl, state, selection } = editor;
  if (!edl || !state) return <aside class="panel right" aria-label="Inspector" />;
  const ctx: Ctx = { fps: edl.canvas.fps, beats: editor.beats };
  const item =
    selection?.kind === "text" ? edl.text[selection.index] : selection?.kind === "shot" ? edl.shots[selection.index] : selection?.kind === "flash" ? edl.flashes[selection.index] : selection?.kind === "sfx" ? edl.sfx[selection.index] : undefined;
  return (
    <aside class="panel right" aria-label="Inspector">
      <div class="inspector">
        {selection && item ? (
          selection.kind === "text" ? (
            <TextInspector editor={editor} clock={clock} index={selection.index} t={item as TextT} ctx={ctx} />
          ) : selection.kind === "shot" ? (
            <ShotInspector editor={editor} clock={clock} index={selection.index} s={item as ShotT} ctx={ctx} />
          ) : selection.kind === "flash" ? (
            <FlashInspector editor={editor} index={selection.index} ctx={ctx} />
          ) : (
            <SfxInspector editor={editor} index={selection.index} ctx={ctx} />
          )
        ) : (
          <EditInspector editor={editor} />
        )}
      </div>
    </aside>
  );
}

function Head({ title, onDelete, children }: { title: string; onDelete?: () => void; children?: preact.ComponentChildren }) {
  return (
    <div class="panel-head" style={{ padding: "14px 0 10px" }}>
      <h2>{title}</h2>
      <div class="row">
        {children}
        {onDelete && (
          <button class="btn small ghost danger" type="button" onClick={onDelete} title="Delete (⌫)">
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function Timing({ start, end, ctx, onStart, onEnd }: { start: ShotT["start"]; end: ShotT["end"]; ctx: Ctx; onStart: (v: ShotT["start"]) => void; onEnd: (v: ShotT["end"]) => void }) {
  const d = sec(end, ctx) - sec(start, ctx);
  return (
    <Section title={`Timing · ${d.toFixed(2)} s · ${Math.round(d * ctx.fps)} frames`}>
      <Field label="Starts">
        <TimeField value={start} fps={ctx.fps} beats={ctx.beats} onChange={onStart} />
      </Field>
      <Field label="Ends">
        <TimeField value={end} fps={ctx.fps} beats={ctx.beats} onChange={onEnd} />
      </Field>
    </Section>
  );
}

function TextInspector({ editor, clock, index, t, ctx }: { editor: Editor; clock: Clock; index: number; t: TextT; ctx: Ctx }) {
  const { apply, setSelection } = editor;
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    void fontCatalog().then((c) => {
      const names = Object.keys(c);
      setFonts(names);
      void loadFonts(names);
    });
  }, []);
  const set = (fn: (d: TextT) => void, key?: string) => apply((d) => fn(d.text[index]!), key ? `text:${index}:${key}` : undefined);
  const custom = Array.isArray(t.position);
  const a = sec(t.start, ctx);
  const b = sec(t.end, ctx);
  return (
    <>
      <Head
        title="Text"
        onDelete={() => {
          apply((d) => void d.text.splice(index, 1));
          setSelection(null);
        }}
      >
        <button class="btn small ghost" type="button" title="Play this text's entrance" onClick={() => (clock.seek(Math.max(0, a - 0.15)), clock.play(b + 0.1))}>
          Replay
        </button>
      </Head>
      <Field label="Words" stack>
        <textarea class="input" value={t.text} onInput={(e) => set((d) => void (d.text = (e.target as HTMLTextAreaElement).value || " "), "words")} style={{ fontFamily: `"${t.font}", var(--ui)` }} rows={2} />
      </Field>
      <Section title="Type">
        <div class="font-list" role="listbox" aria-label="Font">
          {fonts.map((f) => (
            <button key={f} type="button" class="font-tile" aria-pressed={f === t.font} style={{ fontFamily: `"${f}", var(--ui)` }} onClick={() => set((d) => void (d.font = f))} title={f}>
              {f}
            </button>
          ))}
        </div>
        <Field label="Size">
          <Slider value={t.size} min={0.005} max={1} step={0.001} scale={100} suffix="%" onInput={(v) => set((d) => void (d.size = +v.toFixed(4)), "size")} />
        </Field>
        <Field label="Weight">
          <div class="chips" role="group">
            {WEIGHTS.map((w) => (
              <button key={w} type="button" aria-pressed={(t.weight ?? 400) === w} style={{ fontWeight: w }} onClick={() => set((d) => setOpt(d, "weight", w, 400))}>
                {WEIGHT_LABELS[w]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Tracking">
          <Slider value={t.tracking} min={-0.2} max={1} step={0.01} onInput={(v) => set((d) => void (d.tracking = +v.toFixed(3)), "tracking")} />
        </Field>
        <Field label="Case">
          <div class="row">
            <Check checked={t.uppercase} onChange={(v) => set((d) => void (d.uppercase = v))}>
              Capitals
            </Check>
            <Check checked={t.italic} onChange={(v) => set((d) => void (d.italic = v))}>
              Italic
            </Check>
          </div>
        </Field>
      </Section>
      <Section title="Colour & finish">
        <Field label="Fill">
          <ColorField value={t.color} onInput={(v) => set((d) => void (d.color = v), "color")} />
        </Field>
        <Field label="Opacity">
          <Slider value={t.opacity} min={0} max={1} step={0.01} scale={100} suffix="%" onInput={(v) => set((d) => void (d.opacity = +v.toFixed(3)), "opacity")} />
        </Field>
        <Field label="Outline">
          <div class="row">
            <Check checked={Boolean(t.outline)} onChange={(v) => set((d) => (v ? (d.outline = { color: "#000000", width: 0.06 }) : delete d.outline))}>
              {""}
            </Check>
            {t.outline && <ColorField value={t.outline.color} onInput={(v) => set((d) => void (d.outline!.color = v), "outline-color")} />}
          </div>
        </Field>
        {t.outline && (
          <Field label="Outline width">
            <Slider value={t.outline.width} min={0} max={0.3} step={0.005} onInput={(v) => set((d) => void (d.outline!.width = +v.toFixed(3)), "outline-width")} />
          </Field>
        )}
        <Field label="Shadow">
          <Slider value={t.shadow ?? 0} min={0} max={0.2} step={0.005} onInput={(v) => set((d) => setOpt(d, "shadow", +v.toFixed(3), 0), "shadow")} />
        </Field>
        <Field label="Glow">
          <Slider value={t.glow ?? 0} min={0} max={20} step={0.5} onInput={(v) => set((d) => setOpt(d, "glow", v, 0), "glow")} />
        </Field>
      </Section>
      <Section title="Placement">
        <Chips
          value={custom ? ("custom" as never) : (t.position as (typeof POSITIONS)[number])}
          options={POSITIONS}
          labels={POSITION_LABELS}
          onPick={(p) => set((d) => void (d.position = p))}
        />
        <p class="hint" style={{ margin: 0 }}>
          {custom ? `Placed by hand at ${Math.round((t.position as number[])[0]! * 100)}%, ${Math.round((t.position as number[])[1]! * 100)}%.` : "Drag the words in the viewer to place them anywhere."}
        </p>
        <Field label="Align">
          <Chips value={t.align} options={["left", "center", "right"] as const} labels={{ left: "Left", center: "Centre", right: "Right" }} onPick={(v) => set((d) => void (d.align = v))} />
        </Field>
        <Check checked={t.behind} onChange={(v) => set((d) => void (d.behind = v))}>
          Behind the subject
        </Check>
        {t.behind && <p class="hint" style={{ margin: 0 }}>Shows behind the person on shots with a subject matte, on top elsewhere. Part of the picture, so it updates after the picture re-renders.</p>}
      </Section>
      <Section title="Entrance & exit">
        <Field label="In">
          <Chips value={t.anim} options={ANIMS} labels={ANIM_LABELS} onPick={(v) => set((d) => void (d.anim = v))} />
        </Field>
        <Field label="Out">
          <Chips value={t.exit} options={EXITS} labels={EXIT_LABELS} onPick={(v) => set((d) => void (d.exit = v))} />
        </Field>
      </Section>
      <Timing start={t.start} end={t.end} ctx={ctx} onStart={(v) => set((d) => void (d.start = v))} onEnd={(v) => set((d) => void (d.end = v))} />
      <div class="section">
        <button class="btn small" type="button" onClick={() => apply((d) => applyStyleToAll(d, index))} title="Font, size, colour, finish and entrance">
          Use this style for all text
        </button>
      </div>
    </>
  );
}

function ShotInspector({ editor, clock, index, s, ctx }: { editor: Editor; clock: Clock; index: number; s: ShotT; ctx: Ctx }) {
  const { apply, setSelection, state } = editor;
  const set = (fn: (d: ShotT) => void, key?: string) => apply((d) => fn(d.shots[index]!), key ? `shot:${index}:${key}` : undefined);
  const cam: NonNullable<ShotT["camera"]> = s.camera ?? { ease: "out" };
  const fx: NonNullable<ShotT["fx"]> = s.fx ?? {};
  const camSet = (fn: (c: NonNullable<ShotT["camera"]>) => void, key?: string) =>
    set((d) => {
      d.camera ??= { ease: "out" };
      fn(d.camera);
    }, key);
  const fxSet = (fn: (f: NonNullable<ShotT["fx"]>) => void, key?: string) =>
    set((d) => {
      d.fx ??= {};
      fn(d.fx);
      if (!Object.keys(d.fx).length) delete d.fx;
    }, key);
  const pictures = (state?.assets ?? []).filter((a) => a.kind !== "audio");
  const asset = state?.assets.find((a) => a.id === s.source.asset);
  const zoom = Array.isArray(cam.zoom) ? cam.zoom : [cam.zoom ?? 1, cam.zoom ?? 1];
  const roll = Array.isArray(cam.roll) ? cam.roll : [cam.roll ?? 0, cam.roll ?? 0];
  const a = sec(s.start, ctx);
  const b = sec(s.end, ctx);
  return (
    <>
      <Head
        title={`Shot ${s.id ?? index + 1}`}
        onDelete={() => {
          apply((d) => void d.shots.splice(index, 1));
          setSelection(null);
        }}
      >
        <AtPlayhead clock={clock} from={a} to={b} class="btn small ghost" title="Split at the playhead (S)" onClick={() => apply((d) => void splitShot(d, index, +(clock.frame / ctx.fps).toFixed(4), ctx))}>
          Split
        </AtPlayhead>
      </Head>
      {s.note && <p class="hint" style={{ marginTop: 0 }}>{s.note}</p>}
      <Section title="Clip">
        <Field label="Source">
          <select
            class="input"
            value={s.source.asset}
            onChange={(e) =>
              set((d) => {
                d.source.asset = (e.target as HTMLSelectElement).value;
                d.source.in = 0;
                delete d.source.matte;
              })
            }
          >
            <optgroup label="Colour">
              <option value="black">Black</option>
              <option value="white">White</option>
            </optgroup>
            <optgroup label="Media">
              {pictures.map((p) => (
                <option key={p.id} value={p.id} title={p.label}>
                  {p.id} · {p.kind === "video" ? `${(p.durationSec ?? 0).toFixed(1)} s` : "still"}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        {asset?.kind === "video" && (
          <>
            <Field label="Starts at">
              <Slider value={s.source.in} min={0} max={Math.max(0.1, asset.durationSec ?? 10)} step={1 / ctx.fps} suffix=" s" onInput={(v) => set((d) => void (d.source.in = +v.toFixed(4)), "in")} />
            </Field>
            <Field label="Speed">
              <Slider value={s.source.speed} min={0} max={4} step={0.05} suffix="×" onInput={(v) => set((d) => void (d.source.speed = +v.toFixed(2)), "speed")} />
            </Field>
            <Field label="Ramp to">
              <div class="row">
                <NumberBox value={s.source.speedTo} min={0.05} max={8} placeholder="none" onInput={(v) => set((d) => setOpt(d.source, "speedTo", v))} />
                <Check checked={s.source.reverse} onChange={(v) => set((d) => void (d.source.reverse = v))}>
                  Reverse
                </Check>
              </div>
            </Field>
            <Field label="Smooth">
              <Chips value={s.source.interpolate} options={["none", "blend", "motion"] as const} labels={{ none: "Off", blend: "Blend", motion: "Motion" }} onPick={(v) => set((d) => void (d.source.interpolate = v))} />
            </Field>
          </>
        )}
        {asset && (
          <>
            <Field label="Fit">
              <Chips value={s.source.fit} options={["cover", "contain"] as const} labels={{ cover: "Fill frame", contain: "Whole image" }} onPick={(v) => set((d) => void (d.source.fit = v))} />
            </Field>
            <Field label="Focus">
              <div class="row">
                <NumberBox value={s.source.focus[0]} min={0} max={1} onInput={(v) => set((d) => void (d.source.focus = [v ?? 0.5, d.source.focus[1]]))} />
                <NumberBox value={s.source.focus[1]} min={0} max={1} onInput={(v) => set((d) => void (d.source.focus = [d.source.focus[0], v ?? 0.5]))} />
              </div>
            </Field>
          </>
        )}
        <p class="hint" style={{ margin: 0 }}>Drag a clip from the media panel onto this shot to replace it. Alt-drag the shot to slip its content.</p>
      </Section>
      <Section title="Camera">
        <Field label="Zoom from">
          <Slider value={zoom[0]!} min={0.5} max={3} step={0.01} suffix="×" onInput={(v) => camSet((c) => void (c.zoom = [+v.toFixed(3), zoom[1]!]), "zoom0")} />
        </Field>
        <Field label="Zoom to">
          <Slider value={zoom[1]!} min={0.5} max={3} step={0.01} suffix="×" onInput={(v) => camSet((c) => void (c.zoom = [zoom[0]!, +v.toFixed(3)]), "zoom1")} />
        </Field>
        <Field label="Ease">
          <Chips value={cam.ease ?? "out"} options={["linear", "in", "out", "inout"] as const} labels={{ linear: "Linear", in: "In", out: "Out", inout: "In-out" }} onPick={(v) => camSet((c) => void (c.ease = v))} />
        </Field>
        <Field label="Drift x / y">
          <div class="row">
            <NumberBox value={cam.pan?.[0]} min={-1} max={1} placeholder="0" onInput={(v) => camSet((c) => (v || c.pan?.[1] ? (c.pan = [v ?? 0, c.pan?.[1] ?? 0]) : delete c.pan))} />
            <NumberBox value={cam.pan?.[1]} min={-1} max={1} placeholder="0" onInput={(v) => camSet((c) => (v || c.pan?.[0] ? (c.pan = [c.pan?.[0] ?? 0, v ?? 0]) : delete c.pan))} />
          </div>
        </Field>
        <Field label="Roll °">
          <div class="row">
            <NumberBox value={roll[0]} step={0.1} onInput={(v) => camSet((c) => setOpt(c, "roll", [v ?? 0, roll[1]!] as [number, number]))} />
            <NumberBox value={roll[1]} step={0.1} onInput={(v) => camSet((c) => setOpt(c, "roll", [roll[0]!, v ?? 0] as [number, number]))} />
          </div>
        </Field>
        <Field label="Punch-ins">
          <div class="row">
            <span class="mono hint" style={{ flex: 1 }}>
              {cam.punch ? cam.punch.at.join(", ") : "none"}
            </span>
            <AtPlayhead
              clock={clock}
              from={a}
              to={b}
              class="btn small"
              title="Kick the zoom at the playhead"
              onClick={() =>
                camSet((c) => {
                  const at = +(clock.frame / ctx.fps).toFixed(4);
                  c.punch = c.punch ? { ...c.punch, at: [...c.punch.at, at] } : { at: [at], amount: 0.08, decay: 0.18 };
                })
              }
            >
              + at playhead
            </AtPlayhead>
            {cam.punch && (
              <button class="btn small ghost" type="button" onClick={() => camSet((c) => delete c.punch)}>
                Clear
              </button>
            )}
          </div>
        </Field>
        {cam.punch && (
          <Field label="Punch size">
            <Slider value={cam.punch.amount} min={0} max={0.4} step={0.01} onInput={(v) => camSet((c) => void (c.punch!.amount = +v.toFixed(3)), "punch-amount")} />
          </Field>
        )}
        <Field label="Shake">
          <Slider value={cam.shake?.amp ?? 0} min={0} max={0.06} step={0.001} onInput={(v) => camSet((c) => (v > 0 ? (c.shake = { freq: 9, decay: true, ...c.shake, amp: +v.toFixed(4) }) : delete c.shake), "shake")} />
        </Field>
        <Field label="Handheld">
          <Slider value={cam.handheld?.amp ?? 0} min={0} max={0.03} step={0.0005} onInput={(v) => camSet((c) => (v > 0 ? (c.handheld = { freq: 0.7, ...c.handheld, amp: +v.toFixed(4) }) : delete c.handheld), "handheld")} />
        </Field>
        <Field label="Start offset">
          <div class="row">
            <NumberBox value={cam.panFrom?.[0]} min={-1} max={1} placeholder="0" onInput={(v) => camSet((c) => (v || c.panFrom?.[1] ? (c.panFrom = [v ?? 0, c.panFrom?.[1] ?? 0]) : delete c.panFrom))} />
            <NumberBox value={cam.panFrom?.[1]} min={-1} max={1} placeholder="0" onInput={(v) => camSet((c) => (v || c.panFrom?.[0] ? (c.panFrom = [c.panFrom?.[0] ?? 0, v ?? 0]) : delete c.panFrom))} />
          </div>
        </Field>
        <Field label="Scale">
          <NumberBox value={cam.overscan} min={1} max={3} placeholder="auto" onInput={(v) => camSet((c) => setOpt(c, "overscan", v))} />
        </Field>
      </Section>
      <Section title="Look" open={false}>
        <FxControls fx={fx} fxSet={fxSet} />
      </Section>
      <Section title="Edges & strobes" open={false}>
        <Field label="Flash in">
          <Slider value={fx.flashIn ?? 0} min={0} max={1} step={0.01} suffix=" s" onInput={(v) => fxSet((f) => setOpt(f, "flashIn", +v.toFixed(3), 0), "flashIn")} />
        </Field>
        <Field label="Flash out">
          <Slider value={fx.flashOut ?? 0} min={0} max={1} step={0.01} suffix=" s" onInput={(v) => fxSet((f) => setOpt(f, "flashOut", +v.toFixed(3), 0), "flashOut")} />
        </Field>
        <Field label="Fade in">
          <Slider value={fx.dipIn ?? 0} min={0} max={1} step={0.01} suffix=" s" onInput={(v) => fxSet((f) => setOpt(f, "dipIn", +v.toFixed(3), 0), "dipIn")} />
        </Field>
        <Field label="Fade out">
          <Slider value={fx.dipOut ?? 0} min={0} max={1} step={0.01} suffix=" s" onInput={(v) => fxSet((f) => setOpt(f, "dipOut", +v.toFixed(3), 0), "dipOut")} />
        </Field>
        <Field label="Strobe">
          <Slider value={fx.strobe?.rate ?? 0} min={0} max={30} step={0.5} suffix="/s" onInput={(v) => fxSet((f) => (v > 0 ? (f.strobe = { intensity: 0.6, ...f.strobe, rate: v }) : delete f.strobe), "strobe")} />
        </Field>
        <Field label="Frame strobe">
          <div class="row">
            <NumberBox value={fx.frameStrobe?.every} min={2} max={48} step={1} placeholder="off" onInput={(v) => fxSet((f) => (v ? (f.frameStrobe = { on: 1, color: "black", ...f.frameStrobe, every: Math.round(v) }) : delete f.frameStrobe))} />
            {fx.frameStrobe && (
              <Chips value={fx.frameStrobe.color} options={["black", "white"] as const} labels={{ black: "Black", white: "White" }} onPick={(c) => fxSet((f) => void (f.frameStrobe!.color = c))} />
            )}
          </div>
        </Field>
      </Section>
      <Section title="Mask & background" open={false}>
        <Field label="Window">
          <div class="row">
            <Check checked={Boolean(fx.mask)} onChange={(v) => fxSet((f) => (v ? (f.mask = { shape: "circle", center: [0.5, 0.5], size: [0.7, 0.7], feather: 0.06, invert: false, color: "#000000" }) : delete f.mask))}>
              {""}
            </Check>
            {fx.mask && <Chips value={fx.mask.shape} options={["circle", "rect"] as const} labels={{ circle: "Round", rect: "Box" }} onPick={(v) => fxSet((f) => void (f.mask!.shape = v))} />}
          </div>
        </Field>
        {fx.mask && (
          <>
            <Field label="Size">
              <Slider value={fx.mask.size[0]} min={0.05} max={1.5} step={0.01} onInput={(v) => fxSet((f) => void (f.mask!.size = [+v.toFixed(3), f.mask!.shape === "circle" ? +v.toFixed(3) : f.mask!.size[1]]), "mask-size")} />
            </Field>
            <Field label="Centre">
              <div class="row">
                <NumberBox value={fx.mask.center[0]} min={0} max={1} onInput={(v) => fxSet((f) => void (f.mask!.center = [v ?? 0.5, f.mask!.center[1]]))} />
                <NumberBox value={fx.mask.center[1]} min={0} max={1} onInput={(v) => fxSet((f) => void (f.mask!.center = [f.mask!.center[0], v ?? 0.5]))} />
              </div>
            </Field>
            <Field label="Soft edge">
              <Slider value={fx.mask.feather} min={0} max={0.5} step={0.01} onInput={(v) => fxSet((f) => void (f.mask!.feather = +v.toFixed(3)), "mask-feather")} />
            </Field>
            <Field label="Grows to">
              <NumberBox value={fx.mask.sizeTo} min={0.05} max={5} placeholder="stays" onInput={(v) => fxSet((f) => setOpt(f.mask!, "sizeTo", v))} />
            </Field>
            <Field label="Outside">
              <div class="row">
                <ColorField value={fx.mask.color} onInput={(v) => fxSet((f) => void (f.mask!.color = v), "mask-color")} />
                <Check checked={fx.mask.invert} onChange={(v) => fxSet((f) => void (f.mask!.invert = v))}>
                  Swap
                </Check>
              </div>
            </Field>
          </>
        )}
        <Field label="Background">
          <div class="row">
            <Check checked={Boolean(s.background)} onChange={(v) => set((d) => setOpt(d, "background", v ? "#000000" : undefined))}>
              {""}
            </Check>
            {s.background && <ColorField value={s.background} onInput={(v) => set((d) => void (d.background = v), "background")} />}
          </div>
        </Field>
        {s.background && !s.source.matte && <p class="hint" style={{ margin: 0 }}>Needs a subject matte for this clip; ask the agent to make one.</p>}
      </Section>
      <TileControls s={s} set={set} />
      <LayerControls editor={editor} s={s} set={set} />
      <Timing start={s.start} end={s.end} ctx={ctx} onStart={(v) => set((d) => void (d.start = v))} onEnd={(v) => set((d) => void (d.end = v))} />
    </>
  );
}

type FxT = NonNullable<ShotT["fx"]>;

/** Colour and texture effects, shared by shots and layers. */
function FxControls({ fx, fxSet }: { fx: FxT; fxSet: (fn: (f: FxT) => void, key?: string) => void }) {
  const blur = Array.isArray(fx.blur) ? fx.blur : [fx.blur ?? 0, fx.blur ?? 0];
  const ramp = Array.isArray(fx.blur);
  return (
    <>
      <Field label="Grade">
        <select class="input" value={fx.look ?? "none"} onChange={(e) => fxSet((f) => setOpt(f, "look", (e.target as HTMLSelectElement).value as (typeof LOOKS)[number], "none"))}>
          {LOOKS.map((l) => (
            <option key={l} value={l}>
              {l === "none" ? "Edit grade" : l}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Exposure">
        <Slider value={fx.exposure ?? 0} min={-1} max={1} step={0.01} onInput={(v) => fxSet((f) => setOpt(f, "exposure", +v.toFixed(3), 0), "exposure")} />
      </Field>
      <Field label="Contrast">
        <Slider value={fx.contrast ?? 1} min={0} max={3} step={0.01} onInput={(v) => fxSet((f) => setOpt(f, "contrast", +v.toFixed(3), 1), "contrast")} />
      </Field>
      <Field label="Saturation">
        <Slider value={fx.saturation ?? 1} min={0} max={3} step={0.01} onInput={(v) => fxSet((f) => setOpt(f, "saturation", +v.toFixed(3), 1), "saturation")} />
      </Field>
      <Field label="Bloom">
        <div class="row">
          <Slider value={fx.glow ?? 0} min={0} max={1} step={0.01} onInput={(v) => fxSet((f) => setOpt(f, "glow", +v.toFixed(3), 0), "glow")} />
          {fx.glow ? <input type="color" value={fx.glowColor ?? "#FFFFFF"} title="Bloom colour" onInput={(e) => fxSet((f) => setOpt(f, "glowColor", (e.target as HTMLInputElement).value.toUpperCase(), "#FFFFFF"), "glowColor")} /> : null}
        </div>
      </Field>
      <Field label={ramp ? "Blur from" : "Blur"}>
        <Slider value={blur[0]!} min={0} max={40} step={0.5} onInput={(v) => fxSet((f) => setOpt(f, "blur", ramp ? ([v, blur[1]!] as [number, number]) : v, 0), "blur0")} />
      </Field>
      <Field label="Blur to">
        <div class="row">
          <Check checked={ramp} onChange={(v) => fxSet((f) => setOpt(f, "blur", v ? ([blur[0]!, blur[0]! > 0 ? 0 : 12] as [number, number]) : blur[0]!, 0))}>
            Animate
          </Check>
          {ramp && <Slider value={blur[1]!} min={0} max={40} step={0.5} onInput={(v) => fxSet((f) => void (f.blur = [blur[0]!, v]), "blur1")} />}
        </div>
      </Field>
      <Field label="Motion blur">
        <div class="row">
          <Slider value={fx.motionBlur?.amount ?? 0} min={0} max={120} step={1} onInput={(v) => fxSet((f) => (v >= 1 ? (f.motionBlur = { direction: "horizontal", ...f.motionBlur, amount: v }) : delete f.motionBlur), "motion")} />
          {fx.motionBlur && (
            <Chips value={fx.motionBlur.direction} options={["horizontal", "vertical"] as const} labels={{ horizontal: "↔", vertical: "↕" }} onPick={(v) => fxSet((f) => void (f.motionBlur!.direction = v))} />
          )}
        </div>
      </Field>
      <Field label="Zoom blur">
        <Slider value={fx.zoomBlur ?? 0} min={0} max={1} step={0.01} onInput={(v) => fxSet((f) => setOpt(f, "zoomBlur", +v.toFixed(3), 0), "zoomBlur")} />
      </Field>
      <Field label="RGB split">
        <Slider value={fx.rgbSplit ?? 0} min={0} max={40} step={0.5} onInput={(v) => fxSet((f) => setOpt(f, "rgbSplit", v, 0), "rgb")} />
      </Field>
      <Field label="Trail">
        <Slider value={fx.trail ?? 0} min={0} max={1} step={0.01} onInput={(v) => fxSet((f) => setOpt(f, "trail", +v.toFixed(3), 0), "trail")} />
      </Field>
      <Field label="Vignette">
        <Slider value={fx.vignette ?? 0} min={0} max={1} step={0.01} onInput={(v) => fxSet((f) => setOpt(f, "vignette", +v.toFixed(3), 0), "vignette")} />
      </Field>
      <Field label="Tint">
        <div class="row">
          <Check checked={Boolean(fx.tint)} onChange={(v) => fxSet((f) => (v ? (f.tint = { color: "#4FC3F7", amount: 0.5 }) : delete f.tint))}>
            {""}
          </Check>
          {fx.tint && <input type="color" value={fx.tint.color} onInput={(e) => fxSet((f) => void (f.tint!.color = (e.target as HTMLInputElement).value.toUpperCase()), "tint-color")} />}
          {fx.tint && <Slider value={fx.tint.amount} min={0} max={1} step={0.01} onInput={(v) => fxSet((f) => void (f.tint!.amount = +v.toFixed(3)), "tint-amount")} />}
        </div>
      </Field>
      <Field label="Duotone">
        <div class="row">
          <Check checked={Boolean(fx.duotone)} onChange={(v) => fxSet((f) => (v ? (f.duotone = { shadow: "#0B1640", highlight: "#7FB2FF" }) : delete f.duotone))}>
            {""}
          </Check>
          {fx.duotone && <input type="color" value={fx.duotone.shadow} title="Shadows" onInput={(e) => fxSet((f) => void (f.duotone!.shadow = (e.target as HTMLInputElement).value.toUpperCase()), "duo-s")} />}
          {fx.duotone && <input type="color" value={fx.duotone.highlight} title="Highlights" onInput={(e) => fxSet((f) => void (f.duotone!.highlight = (e.target as HTMLInputElement).value.toUpperCase()), "duo-h")} />}
        </div>
      </Field>
      <Field label="Keep colour">
        <div class="row">
          <Check checked={Boolean(fx.keepColor)} onChange={(v) => fxSet((f) => (v ? (f.keepColor = { color: "#D01020", similarity: 0.3, blend: 0.1 }) : delete f.keepColor))}>
            {""}
          </Check>
          {fx.keepColor && <input type="color" value={fx.keepColor.color} onInput={(e) => fxSet((f) => void (f.keepColor!.color = (e.target as HTMLInputElement).value.toUpperCase()), "keep-color")} />}
          {fx.keepColor && <Slider value={fx.keepColor.similarity} min={0.01} max={1} step={0.01} onInput={(v) => fxSet((f) => void (f.keepColor!.similarity = +v.toFixed(3)), "keep-sim")} />}
        </div>
      </Field>
      <Field label="Threshold">
        <div class="row">
          <Check checked={fx.threshold !== undefined} onChange={(v) => fxSet((f) => setOpt(f, "threshold", v ? 0.5 : undefined))}>
            {""}
          </Check>
          {fx.threshold !== undefined && <Slider value={fx.threshold} min={0} max={1} step={0.01} onInput={(v) => fxSet((f) => void (f.threshold = +v.toFixed(3)), "threshold")} />}
        </div>
      </Field>
      <Field label="Posterize">
        <NumberBox value={fx.posterize} min={2} max={16} step={1} placeholder="off" onInput={(v) => fxSet((f) => setOpt(f, "posterize", v ? Math.round(v) : undefined))} />
      </Field>
      <Field label="Invert">
        <Slider value={fx.invert === true ? 1 : typeof fx.invert === "number" ? fx.invert : 0} min={0} max={1} step={0.01} onInput={(v) => fxSet((f) => setOpt(f, "invert", v >= 0.995 ? true : v > 0 ? +v.toFixed(3) : undefined), "invert")} />
      </Field>
      <div class="row" style={{ flexWrap: "wrap", gap: "12px" }}>
        <Check checked={Boolean(fx.bw)} onChange={(v) => fxSet((f) => setOpt(f, "bw", v, false))}>
          Black & white
        </Check>
        <Check checked={Boolean(fx.mirror)} onChange={(v) => fxSet((f) => setOpt(f, "mirror", v, false))}>
          Mirror
        </Check>
      </div>
      <Field label="Light leak">
        <div class="row">
          <Check checked={Boolean(fx.leak)} onChange={(v) => fxSet((f) => (v ? (f.leak = { color: "#FFB46A", side: "left", amount: 0.6 }) : delete f.leak))}>
            {""}
          </Check>
          {fx.leak && <input type="color" value={fx.leak.color} onInput={(e) => fxSet((f) => void (f.leak!.color = (e.target as HTMLInputElement).value.toUpperCase()), "leak-color")} />}
          {fx.leak && (
            <select class="input" value={fx.leak.side} onChange={(e) => fxSet((f) => void (f.leak!.side = (e.target as HTMLSelectElement).value as "left"))}>
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
          )}
        </div>
      </Field>
    </>
  );
}

function TileControls({ s, set }: { s: ShotT; set: (fn: (d: ShotT) => void, key?: string) => void }) {
  const t = s.tile;
  return (
    <Section title="Tiles" open={Boolean(t)}>
      <Check checked={Boolean(t)} onChange={(v) => set((d) => (v ? (d.tile = { cols: 2, rows: 2, mirror: "alternate", offset: 0.15, stagger: 0, gap: 0, enter: "none" }) : delete d.tile))}>
        Repeat this clip in a grid
      </Check>
      {t && (
        <>
          <Field label="Grid">
            <div class="row">
              <NumberBox value={t.cols} min={1} max={6} step={1} onInput={(v) => set((d) => void (d.tile!.cols = Math.round(v ?? 2)))} />
              <span class="hint">×</span>
              <NumberBox value={t.rows} min={1} max={6} step={1} onInput={(v) => set((d) => void (d.tile!.rows = Math.round(v ?? 2)))} />
            </div>
          </Field>
          <Field label="Mirror">
            <Chips value={t.mirror} options={["none", "alternate", "all"] as const} labels={{ none: "None", alternate: "Alternate", all: "All" }} onPick={(v) => set((d) => void (d.tile!.mirror = v))} />
          </Field>
          <Field label="Out of step">
            <Slider value={t.offset} min={-1} max={1} step={0.01} suffix=" s" onInput={(v) => set((d) => void (d.tile!.offset = +v.toFixed(3)), "tile-offset")} />
          </Field>
          <Field label="Reveal every">
            <Slider value={t.stagger} min={0} max={1} step={0.01} suffix=" s" onInput={(v) => set((d) => void (d.tile!.stagger = +v.toFixed(3)), "tile-stagger")} />
          </Field>
          <Field label="Gap">
            <Slider value={t.gap} min={0} max={0.1} step={0.002} onInput={(v) => set((d) => void (d.tile!.gap = +v.toFixed(3)), "tile-gap")} />
          </Field>
          <Field label="Each tile">
            <Chips value={t.enter} options={MOVES} labels={MOVE_LABELS} onPick={(v) => set((d) => void (d.tile!.enter = v))} />
          </Field>
        </>
      )}
    </Section>
  );
}

const MOVES = ["none", "fade", "pop", "slide-left", "slide-right", "slide-up", "slide-down"] as const;
const MOVE_LABELS = { none: "Cut", fade: "Fade", pop: "Pop", "slide-left": "← Slide", "slide-right": "Slide →", "slide-up": "↑ Slide", "slide-down": "Slide ↓" };
const BLENDS = ["normal", "screen", "add", "multiply", "overlay", "difference", "lighten", "darken"] as const;

type LayerT = NonNullable<ShotT["layers"]>[number];

/** Pictures composited over the shot: cards, panels, clones, overlays and regional windows. */
function LayerControls({ editor, s, set }: { editor: Editor; s: ShotT; set: (fn: (d: ShotT) => void, key?: string) => void }) {
  const [open, setOpen] = useState(0);
  const layers = s.layers ?? [];
  const pictures = (editor.state?.assets ?? []).filter((a) => a.kind !== "audio");
  const setLayer = (i: number, fn: (l: LayerT) => void, key?: string) => set((d) => fn(d.layers![i]!), key ? `layer:${i}:${key}` : undefined);
  const add = (preset: "card" | "panel" | "clone" | "window") =>
    set((d) => {
      const other = pictures.find((p) => p.id !== d.source.asset && p.role === "generated") ?? pictures[0];
      const base: LayerT = { source: { asset: other?.id ?? "black", in: 0, speed: 1, reverse: false, interpolate: "none", fit: "cover", focus: [0.5, 0.5] }, box: [0, 0, 1, 1], key: false, window: false, shape: "rect", feather: 0, opacity: 1, blend: "normal" };
      if (preset === "card") Object.assign(base, { box: [0.56, 0.08, 0.36, 0.36], border: { width: 0.012, color: "#FFFFFF", bottom: 0.03 }, shadow: 0.6, enter: { type: "pop", duration: 0.25 } });
      if (preset === "panel") Object.assign(base, { box: [0.5, 0, 0.5, 1], enter: { type: "slide-left", duration: 0.25 } });
      if (preset === "clone") Object.assign(base, { source: { ...d.source, in: d.source.in + 0.2 }, key: true, box: [0.25, 0, 1, 1] });
      if (preset === "window") Object.assign(base, { window: true, box: [0.3, 0.3, 0.4, 0.15], fx: { invert: true } });
      d.layers = [...(d.layers ?? []), base];
      setOpen(d.layers.length - 1);
    });
  return (
    <Section title={`Layers${layers.length ? ` · ${layers.length}` : ""}`} open={layers.length > 0}>
      <div class="chips">
        <button type="button" onClick={() => add("card")} title="A framed picture-in-picture card">
          + Card
        </button>
        <button type="button" onClick={() => add("panel")} title="A split-screen panel">
          + Panel
        </button>
        <button type="button" onClick={() => add("clone")} title="A cut-out copy of the subject (needs a matte)">
          + Clone
        </button>
        <button type="button" onClick={() => add("window")} title="This shot seen through a box with its own effects">
          + Window
        </button>
      </div>
      {layers.map((l, i) => (
        <details key={i} class="layer-item" open={open === i} onToggle={(e) => (e.target as HTMLDetailsElement).open && setOpen(i)}>
          <summary>
            <span>{l.window ? "Window" : l.key ? `Clone · ${l.source.asset}` : l.source.asset}</span>
            <button class="btn small ghost danger" type="button" onClick={(e) => (e.preventDefault(), set((d) => void d.layers!.splice(i, 1)))}>
              Remove
            </button>
          </summary>
          <div class="section-body">
            {!l.window && (
              <Field label="Source">
                <select class="input" value={l.source.asset} onChange={(e) => setLayer(i, (x) => void (x.source = { ...x.source, asset: (e.target as HTMLSelectElement).value, in: 0, matte: undefined }))}>
                  <option value="black">Black</option>
                  <option value="white">White</option>
                  {pictures.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Box x / y">
              <div class="row">
                <NumberBox value={l.box[0]} min={-1} max={2} onInput={(v) => setLayer(i, (x) => void (x.box = [v ?? 0, x.box[1], x.box[2], x.box[3]]))} />
                <NumberBox value={l.box[1]} min={-1} max={2} onInput={(v) => setLayer(i, (x) => void (x.box = [x.box[0], v ?? 0, x.box[2], x.box[3]]))} />
              </div>
            </Field>
            <Field label="Box w / h">
              <div class="row">
                <NumberBox value={l.box[2]} min={0.02} max={2} onInput={(v) => setLayer(i, (x) => void (x.box = [x.box[0], x.box[1], v ?? 0.5, x.box[3]]))} />
                <NumberBox value={l.box[3]} min={0.02} max={2} onInput={(v) => setLayer(i, (x) => void (x.box = [x.box[0], x.box[1], x.box[2], v ?? 0.5]))} />
              </div>
            </Field>
            <Field label="Opacity">
              <Slider value={l.opacity} min={0} max={1} step={0.01} scale={100} suffix="%" onInput={(v) => setLayer(i, (x) => void (x.opacity = +v.toFixed(3)), "opacity")} />
            </Field>
            <Field label="Blend">
              <select class="input" value={l.blend} onChange={(e) => setLayer(i, (x) => void (x.blend = (e.target as HTMLSelectElement).value as LayerT["blend"]))}>
                {BLENDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Field>
            <div class="row" style={{ flexWrap: "wrap", gap: "12px" }}>
              <Check checked={l.shape === "circle"} onChange={(v) => setLayer(i, (x) => void (x.shape = v ? "circle" : "rect"))}>
                Round
              </Check>
              {!l.window && (
                <Check checked={l.key} onChange={(v) => setLayer(i, (x) => void (x.key = v))}>
                  Cut out subject
                </Check>
              )}
              <Check checked={Boolean(l.border)} onChange={(v) => setLayer(i, (x) => (v ? (x.border = { width: 0.012, color: "#FFFFFF", bottom: 0 }) : delete x.border))}>
                Border
              </Check>
            </div>
            {l.border && (
              <Field label="Border">
                <div class="row">
                  <input type="color" value={l.border.color} onInput={(e) => setLayer(i, (x) => void (x.border!.color = (e.target as HTMLInputElement).value.toUpperCase()), "border-color")} />
                  <Slider value={l.border.width} min={0} max={0.06} step={0.001} onInput={(v) => setLayer(i, (x) => void (x.border!.width = +v.toFixed(4)), "border-width")} />
                </div>
              </Field>
            )}
            <Field label="Shadow">
              <Slider value={l.shadow ?? 0} min={0} max={1} step={0.01} onInput={(v) => setLayer(i, (x) => setOpt(x, "shadow", +v.toFixed(3), 0), "shadow")} />
            </Field>
            <Field label="Soft edge">
              <Slider value={l.feather} min={0} max={0.5} step={0.01} onInput={(v) => setLayer(i, (x) => void (x.feather = +v.toFixed(3)), "feather")} />
            </Field>
            <Field label="Moves to x / y">
              <div class="row">
                <NumberBox value={l.boxTo?.[0]} min={-1} max={2} placeholder="stay" onInput={(v) => setLayer(i, (x) => (v === undefined ? delete x.boxTo : (x.boxTo = [v, x.boxTo?.[1] ?? x.box[1]])))} />
                <NumberBox value={l.boxTo?.[1]} min={-1} max={2} placeholder="stay" onInput={(v) => setLayer(i, (x) => (v === undefined ? delete x.boxTo : (x.boxTo = [x.boxTo?.[0] ?? x.box[0], v])))} />
              </div>
            </Field>
            <Field label="In">
              <Chips value={l.enter?.type ?? "none"} options={MOVES} labels={MOVE_LABELS} onPick={(v) => setLayer(i, (x) => (v === "none" ? delete x.enter : (x.enter = { duration: 0.2, ...x.enter, type: v })))} />
            </Field>
            <Field label="Out">
              <Chips value={l.exit?.type ?? "none"} options={MOVES} labels={MOVE_LABELS} onPick={(v) => setLayer(i, (x) => (v === "none" ? delete x.exit : (x.exit = { duration: 0.2, ...x.exit, type: v })))} />
            </Field>
            <Field label="From / until">
              <div class="row">
                <input class="input time" placeholder="shot start" value={l.start === undefined ? "" : String(l.start)} onChange={(e) => setLayer(i, (x) => setOpt(x, "start", parseTime((e.target as HTMLInputElement).value)))} />
                <input class="input time" placeholder="shot end" value={l.end === undefined ? "" : String(l.end)} onChange={(e) => setLayer(i, (x) => setOpt(x, "end", parseTime((e.target as HTMLInputElement).value)))} />
              </div>
            </Field>
            <details>
              <summary class="label">Layer look</summary>
              <div class="section-body">
                <FxControls
                  fx={l.fx ?? {}}
                  fxSet={(fn, key) =>
                    setLayer(
                      i,
                      (x) => {
                        x.fx ??= {};
                        fn(x.fx);
                        if (!Object.keys(x.fx).length) delete x.fx;
                      },
                      key,
                    )
                  }
                />
              </div>
            </details>
          </div>
        </details>
      ))}
    </Section>
  );
}

const parseTime = (raw: string): number | string | undefined => {
  const v = raw.trim();
  if (!v) return undefined;
  if (/^[bf]\d+(\.\d+)?$/.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** A button that is only enabled while the playhead is inside [from, to). */
function AtPlayhead({ clock, from, to, children, ...rest }: { clock: Clock; from: number; to: number; class: string; title: string; onClick: () => void; children: preact.ComponentChildren }) {
  useClock(clock);
  const inside = clock.time > from + 1e-6 && clock.time < to - 1e-6;
  return (
    <button type="button" disabled={!inside} {...rest}>
      {children}
    </button>
  );
}

function FlashInspector({ editor, index, ctx }: { editor: Editor; index: number; ctx: Ctx }) {
  const f = editor.edl!.flashes[index]!;
  const set = (fn: (d: Edl["flashes"][number]) => void, key?: string) => editor.apply((d) => fn(d.flashes[index]!), key ? `flash:${index}:${key}` : undefined);
  return (
    <>
      <Head
        title="Flash"
        onDelete={() => {
          editor.apply((d) => void d.flashes.splice(index, 1));
          editor.setSelection(null);
        }}
      />
      <Field label="At">
        <TimeField value={f.at} fps={ctx.fps} beats={ctx.beats} onChange={(v) => set((d) => void (d.at = v))} />
      </Field>
      <Field label="Colour">
        <div class="row">
          <Chips
            value={f.color === "white" || f.color === "black" ? f.color : "tint"}
            options={["white", "black", "tint"] as const}
            labels={{ white: "White", black: "Black", tint: "Tint" }}
            onPick={(v) => set((d) => void (d.color = v === "tint" ? "#F3EACD" : v))}
          />
          {f.color.startsWith("#") && <input type="color" value={f.color} onInput={(e) => set((d) => void (d.color = (e.target as HTMLInputElement).value.toUpperCase()), "color")} />}
        </div>
      </Field>
      <Check checked={f.overText} onChange={(v) => set((d) => void (d.overText = v))}>
        Wash over the titles too
      </Check>
      <Field label="Length">
        <Slider value={f.duration} min={0.02} max={1} step={1 / ctx.fps / 2} suffix=" s" onInput={(v) => set((d) => void (d.duration = +v.toFixed(3)), "duration")} />
      </Field>
      <Field label="Strength">
        <Slider value={f.intensity} min={0} max={1} step={0.01} onInput={(v) => set((d) => void (d.intensity = +v.toFixed(2)), "intensity")} />
      </Field>
    </>
  );
}

function SfxInspector({ editor, index, ctx }: { editor: Editor; index: number; ctx: Ctx }) {
  const c = editor.edl!.sfx[index]!;
  const set = (fn: (d: Edl["sfx"][number]) => void, key?: string) => editor.apply((d) => fn(d.sfx[index]!), key ? `sfx:${index}:${key}` : undefined);
  const audio = (editor.state?.assets ?? []).filter((a) => a.kind === "audio");
  return (
    <>
      <Head
        title="Sound effect"
        onDelete={() => {
          editor.apply((d) => void d.sfx.splice(index, 1));
          editor.setSelection(null);
        }}
      />
      <Field label="At">
        <TimeField value={c.at} fps={ctx.fps} beats={ctx.beats} onChange={(v) => set((d) => void (d.at = v))} />
      </Field>
      <Field label="Sound">
        <select class="input" value={c.sound} onChange={(e) => set((d) => void (d.sound = (e.target as HTMLSelectElement).value))}>
          <optgroup label="Built in">
            {BUILTIN_SFX.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </optgroup>
          {audio.length > 0 && (
            <optgroup label="Project audio">
              {audio.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label ?? a.id}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>
      <Field label="Level">
        <Slider value={c.gainDb} min={-40} max={12} step={0.5} suffix=" dB" onInput={(v) => set((d) => void (d.gainDb = v), "gain")} />
      </Field>
    </>
  );
}

function EditInspector({ editor }: { editor: Editor }) {
  const edl = editor.edl!;
  const set = (fn: (d: Edl) => void, key?: string) => editor.apply(fn, key ? `edit:${key}` : undefined);
  const sources = (editor.state?.assets ?? []).filter((a) => a.kind === "audio" || (a.kind === "video" && a.role === "reference"));
  return (
    <>
      <Head title="Edit" />
      <p class="hint" style={{ marginTop: 0 }}>
        {edl.canvas.width} × {edl.canvas.height} · {edl.canvas.fps} fps · {edl.shots.length} shots · {edl.text.length} text layers. Select anything on the timeline or in the viewer to change it.
      </p>
      <Section title="Beat grid">
        <p class="hint" style={{ margin: 0 }}>
          {edl.grid ? `Cut to a fixed ${edl.grid.bpm} BPM grid.` : `Following the tracked beats of the soundtrack (${editor.beats.length} beats).`} Beat times (b12) and snapping use this grid.
        </p>
        <Check
          checked={Boolean(edl.grid)}
          onChange={(v) =>
            set((d) => {
              if (!v) return void delete d.grid;
              const b = editor.beats;
              const period = b.length > 4 ? (b.at(-1)! - b[0]!) / (b.length - 1) : 0.5;
              d.grid = { bpm: +(60 / period).toFixed(2), phase: +(b[0] ?? 0).toFixed(4) };
            })
          }
        >
          Use a fixed grid
        </Check>
        {edl.grid && (
          <>
            <Field label="Tempo">
              <NumberBox value={edl.grid.bpm} min={40} max={240} step={0.01} onInput={(v) => set((d) => void (d.grid!.bpm = v ?? d.grid!.bpm))} />
            </Field>
            <Field label="First beat">
              <NumberBox value={edl.grid.phase} min={0} step={0.001} onInput={(v) => set((d) => void (d.grid!.phase = v ?? 0))} />
            </Field>
          </>
        )}
      </Section>
      <Section title="Finish">
        <Field label="Grade">
          <select class="input" value={edl.finish.look} onChange={(e) => set((d) => void (d.finish.look = (e.target as HTMLSelectElement).value as (typeof LOOKS)[number]))}>
            {LOOKS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Grain">
          <Slider value={edl.finish.grain} min={0} max={1} step={0.01} onInput={(v) => set((d) => void (d.finish.grain = +v.toFixed(2)), "grain")} />
        </Field>
        <Field label="Vignette">
          <Slider value={edl.finish.vignette} min={0} max={1} step={0.01} onInput={(v) => set((d) => void (d.finish.vignette = +v.toFixed(2)), "vignette")} />
        </Field>
        <Field label="Letterbox">
          <Slider value={edl.finish.letterbox} min={0} max={0.3} step={0.005} scale={100} suffix="%" onInput={(v) => set((d) => void (d.finish.letterbox = +v.toFixed(3)), "letterbox")} />
        </Field>
      </Section>
      <Section title="Soundtrack">
        {edl.audio ? (
          <>
            <Field label="Track">
              <select class="input" value={edl.audio.asset} onChange={(e) => set((d) => void (d.audio!.asset = (e.target as HTMLSelectElement).value))}>
                <option value="ref">Reference audio</option>
                {sources
                  .filter((a) => a.role !== "reference")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label ?? a.id}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Starts at">
              <NumberBox value={edl.audio.offset} min={0} onInput={(v) => set((d) => void (d.audio!.offset = v ?? 0))} />
            </Field>
            <Field label="Level">
              <Slider value={edl.audio.gainDb} min={-30} max={12} step={0.5} suffix=" dB" onInput={(v) => set((d) => void (d.audio!.gainDb = v), "gain")} />
            </Field>
            <Field label="Fade out">
              <Slider value={edl.audio.fadeOut} min={0} max={5} step={0.05} suffix=" s" onInput={(v) => set((d) => void (d.audio!.fadeOut = +v.toFixed(2)), "fade")} />
            </Field>
          </>
        ) : (
          <p class="hint">This edit is silent.</p>
        )}
      </Section>
    </>
  );
}
