import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type Time, timecode, toSec } from "./time.js";

export function Field({ label, children, stack }: { label: string; children: ComponentChildren; stack?: boolean }) {
  return (
    <label class={`field${stack ? " stack" : ""}`}>
      <span class="label">{label}</span>
      {children}
    </label>
  );
}

export function Section({ title, children, open = true }: { title: string; children: ComponentChildren; open?: boolean }) {
  return (
    <details class="section" open={open}>
      <summary class="label">{title}</summary>
      <div class="section-body">{children}</div>
    </details>
  );
}

/** A slider with a numeric box; `scale` converts stored values to displayed ones (e.g. 100 for percent). */
export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  scale?: number;
  suffix?: string;
  onInput: (v: number) => void;
}) {
  const k = props.scale ?? 1;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = +(props.value * k).toFixed(3);
  return (
    <div class="row">
      <input
        type="range"
        min={props.min * k}
        max={props.max * k}
        step={props.step * k}
        value={shown}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value) / k)}
      />
      <input
        class="input num"
        inputMode="decimal"
        value={draft ?? `${shown}${props.suffix ?? ""}`}
        onFocus={() => setDraft(String(shown))}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={() => {
          const v = Number.parseFloat(draft ?? "");
          if (Number.isFinite(v)) props.onInput(Math.min(props.max, Math.max(props.min, v / k)));
          setDraft(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

export function NumberBox({ value, onInput, step = 0.01, min, max, placeholder }: { value: number | undefined; onInput: (v: number | undefined) => void; step?: number; min?: number; max?: number; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      class="input num"
      inputMode="decimal"
      placeholder={placeholder}
      value={draft ?? (value === undefined ? "" : String(+value.toFixed(4)))}
      onFocus={(e) => setDraft((e.target as HTMLInputElement).value)}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={() => {
        const raw = (draft ?? "").trim();
        if (raw === "") onInput(undefined);
        else {
          let v = Number.parseFloat(raw);
          if (Number.isFinite(v)) {
            if (min !== undefined) v = Math.max(min, v);
            if (max !== undefined) v = Math.min(max, v);
            onInput(Math.round(v / step) * step);
          }
        }
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function Chips<T extends string>({ value, options, onPick, labels }: { value: T; options: readonly T[]; onPick: (v: T) => void; labels?: Partial<Record<T, string>> }) {
  return (
    <div class="chips" role="group">
      {options.map((o) => (
        <button type="button" key={o} aria-pressed={o === value} onClick={() => onPick(o)}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ComponentChildren }) {
  return (
    <label class="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      {children}
    </label>
  );
}

/** Edits a timeline time. Accepts seconds, "b12" (beat 12) or "f30" (frame 30); shows where it lands. */
export function TimeField({ value, fps, beats, onChange }: { value: Time; fps: number; beats: number[]; onChange: (v: Time) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [value]);
  const s = toSec(value, fps, beats);
  return (
    <div class="row">
      <input
        class="input time"
        style={bad ? { borderColor: "var(--danger)" } : undefined}
        value={draft ?? String(value)}
        title="Seconds, b<beat> or f<frame>"
        onFocus={() => setDraft(String(value))}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={() => {
          const raw = (draft ?? "").trim();
          setDraft(null);
          if (/^[bf]\d+(\.\d+)?$/.test(raw)) onChange(raw);
          else if (raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) onChange(+Number(raw).toFixed(4));
          else if (raw !== String(value)) setBad(true);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span class="hint mono" style={{ flex: "none" }}>
        {timecode(s, fps).slice(3)}
      </span>
    </div>
  );
}

export function ColorField({ value, onInput }: { value: string; onInput: (v: string) => void }) {
  return (
    <div class="row">
      <input type="color" value={value} onInput={(e) => onInput((e.target as HTMLInputElement).value.toUpperCase())} />
      <span class="mono hint">{value.toUpperCase()}</span>
    </div>
  );
}
