import { useRef, useState } from "preact/hooks";
import type { BriefField, BriefValue, FieldProblem, MusicChoice, TemplateDetail, TitleStyle, TrackFit, Upload } from "../../../src/app/types.js";
import { fmtSeconds, fmtTime } from "./beat.js";
import { useFaceStyle } from "./fontsDisplay.js";
import { Chip, Icon, toast } from "./ui.js";

/**
 * Step 2 of the make rail (spec §4.3): the template's own words and choices, prefilled, so nothing
 * has to be typed. Word fields are set in their card's real font at 18 px with the card's time beside
 * them; collapsed fields sit under "More words". Also the rail's other "Make it yours" rows: the track,
 * the director's note, plan-first and the prompt preview.
 */
export interface BriefFormProps {
  fields: BriefField[];
  words: TemplateDetail["words"];
  values: Record<string, BriefValue>;
  problems: FieldProblem[];
  onChange(id: string, v: BriefValue): void;
  /** The template's title style: unbound word fields that end up on screen (freestyle) use it. */
  display?: TitleStyle;
}

/** The form's starting values: each field's default, else empty (placeholders stay placeholders). */
export function initialBrief(fields: BriefField[]): Record<string, BriefValue> {
  const out: Record<string, BriefValue> = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.id] = Array.isArray(f.default) ? [...f.default] : f.default;
    else out[f.id] = f.kind === "toggle" ? false : f.kind === "words" ? (f.binds.length ? f.binds.map(() => "") : []) : "";
  }
  return out;
}

const isEmpty = (v: BriefValue | undefined) => v === undefined || (typeof v === "string" ? !v.trim() : Array.isArray(v) ? v.every((x) => !x.trim()) : false);

/** The first required field left empty (for "Fill in: <label>"). */
export function missingRequired(fields: BriefField[], values: Record<string, BriefValue>): BriefField | undefined {
  return fields.find((f) => f.required && isEmpty(values[f.id]));
}

const problemFor = (problems: FieldProblem[], id: string) =>
  problems.filter((p) => p.field === id || p.field.endsWith(`.${id}`) || p.field.startsWith(`${id}.`) || p.field.startsWith(`${id}[`));

const sameValue = (a: BriefValue | undefined, b: string | string[]) => JSON.stringify(a) === JSON.stringify(b);

export function BriefForm({ fields, words, values, problems, onChange, display }: BriefFormProps) {
  const open = fields.filter((f) => !f.collapsed);
  const collapsed = fields.filter((f) => f.collapsed);
  const field = (f: BriefField, first: boolean) => (
    <Field key={f.id} f={f} words={words} value={values[f.id]} problems={problemFor(problems, f.id)} onChange={(v) => onChange(f.id, v)} display={display} first={first} />
  );
  // A collapsed field with a problem opens its group so the problem is seen.
  const collapsedProblem = collapsed.some((f) => problemFor(problems, f.id).length);
  return (
    <div class="kt-brief">
      {open.map((f, i) => field(f, i === 0))}
      {collapsed.length > 0 && (
        <details class="kt-more" open={collapsedProblem || undefined}>
          <summary>
            <Icon name="chevron" size={12} class="kt-caret" />
            More words
            <span class="kt-more-count mono">{collapsed.length}</span>
          </summary>
          <div class="kt-more-body">{collapsed.map((f) => field(f, false))}</div>
        </details>
      )}
    </div>
  );
}

interface FieldProps {
  f: BriefField;
  words: TemplateDetail["words"];
  value: BriefValue | undefined;
  problems: FieldProblem[];
  onChange(v: BriefValue): void;
  display?: TitleStyle;
  first: boolean;
}

function Field({ f, words, value, problems, onChange, display, first }: FieldProps) {
  const id = `brief-${f.id}`;
  const helpId = f.help ? `${id}-help` : undefined;
  const errId = problems.length ? `${id}-err` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(" ") || undefined;
  const errors = problems.length > 0 && (
    <p class="kt-error" id={errId}>
      {problems.map((p) => p.message).join(" ")}
    </p>
  );
  const help = f.help && (
    <p class="kt-help" id={helpId}>
      {f.help}
    </p>
  );

  if (f.kind === "toggle") {
    return (
      <div class="kt-field">
        <label class="kt-switch">
          <input
            type="checkbox"
            role="switch"
            checked={value === true}
            onChange={(e) => onChange(e.currentTarget.checked)}
            aria-describedby={describedBy}
            data-first={first || undefined}
          />
          <span class="kt-switch-track" aria-hidden="true" />
          <span>{f.label}</span>
        </label>
        {help}
        {errors}
      </div>
    );
  }

  if (f.kind === "choice") return <ChoiceField f={f} value={typeof value === "string" ? value : ""} onChange={onChange} help={help} errors={errors} first={first} />;

  if (f.kind === "color") {
    const v = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : typeof f.default === "string" ? f.default : "#000000";
    return (
      <div class="kt-field">
        <label class="kt-field-label" for={id}>
          {f.label}
        </label>
        {help}
        <div class="kt-color">
          <input id={id} type="color" value={v} onInput={(e) => onChange(e.currentTarget.value.toUpperCase())} aria-describedby={describedBy} data-first={first || undefined} />
          <input
            class="kt-input mono"
            aria-label={`${f.label}, hex`}
            value={typeof value === "string" ? value : ""}
            maxLength={7}
            spellcheck={false}
            onInput={(e) => onChange(e.currentTarget.value)}
          />
        </div>
        {errors}
      </div>
    );
  }

  // text and words
  const bound = f.binds.map((b) => ({ bind: b, card: words.find((w) => w.index === b.index) }));
  const onScreen = bound.length > 0 || f.verbatim;
  const entries: string[] = f.kind === "words" ? (Array.isArray(value) ? value : []) : [typeof value === "string" ? value : ""];
  const max = f.maxChars;
  const suggestions = f.suggestions;
  const setEntry = (i: number, v: string) => {
    if (f.kind !== "words") return onChange(v);
    const next = [...entries];
    next[i] = v;
    onChange(next);
  };
  const surprise = () => {
    if (!suggestions.length) return;
    const at = suggestions.findIndex((s) => sameValue(f.kind === "words" ? entries : entries[0], s));
    const next = suggestions[(at + 1) % suggestions.length]!;
    onChange(f.kind === "words" ? (Array.isArray(next) ? [...next] : [next]) : Array.isArray(next) ? next.join(" ") : next);
  };
  const slots = f.kind === "words" ? (bound.length ? bound.length : Math.max(entries.length, 0)) : 1;
  const canAdd = f.kind === "words" && !bound.length && entries.length < (f.count ?? 6);
  const placeholderAt = (i: number) => (Array.isArray(f.placeholder) ? f.placeholder[i] : f.placeholder);
  const total = entries.reduce((s, e) => s + e.length, 0);

  return (
    <div class={`kt-field${onScreen ? " words" : ""}`}>
      <div class="kt-field-top">
        <label class="kt-field-label" for={`${id}-0`}>
          {f.label}
          {!f.required && f.kind === "words" && !bound.length && !/optional/i.test(f.label) && <span class="kt-optional"> (optional)</span>}
        </label>
        {max && slots === 1 && (
          <span class={`kt-counter mono${entries[0]!.length >= max ? " full" : ""}`} aria-hidden="true">
            {entries[0]!.length} / {max}
          </span>
        )}
      </div>
      {help}
      <div class="kt-word-list">
        {Array.from({ length: slots }, (_, i) => (
          <WordInput
            key={i}
            id={`${id}-${i}`}
            value={entries[i] ?? ""}
            onInput={(v) => setEntry(i, v)}
            card={bound[i]?.card}
            face={
              onScreen
                ? (bound[i]?.card ?? (display ? { font: display.font, weight: display.weight, italic: display.italic, uppercase: display.case === "upper" } : undefined))
                : undefined
            }
            textCase={bound[i]?.card ? (bound[i]!.card!.uppercase ? "upper" : "as-typed") : onScreen ? display?.case : undefined}
            max={max}
            showCount={slots > 1 && max !== undefined}
            placeholder={placeholderAt(i) ?? (f.kind === "words" && !bound.length && i === 0 ? "Leave empty and the director writes new words in the same style" : undefined)}
            label={slots > 1 ? `${f.label}, word ${i + 1}` : undefined}
            describedBy={describedBy}
            first={first && i === 0}
            onRemove={canAdd || (f.kind === "words" && !bound.length) ? () => onChange(entries.filter((_, j) => j !== i)) : undefined}
          />
        ))}
        {canAdd && (
          <button type="button" class="btn ghost small kt-add-word" onClick={() => onChange([...entries, ""])}>
            <Icon name="plus" size={12} />
            {entries.length ? "Add a word" : "Add words"}
          </button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div class="kt-suggest" role="group" aria-label={`Suggestions for ${f.label}`}>
          {suggestions.map((s) => {
            const text = Array.isArray(s) ? s.join(" · ") : s;
            return (
              <Chip
                key={text}
                selected={sameValue(f.kind === "words" ? entries : entries[0], s)}
                onClick={() => onChange(f.kind === "words" ? (Array.isArray(s) ? [...s] : [s]) : Array.isArray(s) ? s.join(" ") : s)}
              >
                {text}
              </Chip>
            );
          })}
          {suggestions.length > 1 && (
            <button type="button" class="kt-surprise" onClick={surprise}>
              <Icon name="surprise" size={13} />
              Surprise me
            </button>
          )}
        </div>
      )}
      {errors}
      <span class="kt-sr" aria-live="polite">
        {max && total > 0 && entries.some((e) => e.length >= max) ? `${max} characters is the most for this field.` : ""}
      </span>
    </div>
  );
}

interface WordInputProps {
  id: string;
  value: string;
  onInput(v: string): void;
  card?: TemplateDetail["words"][number];
  face?: { font: string; weight: number; italic: boolean; uppercase: boolean };
  textCase?: TitleStyle["case"];
  max?: number;
  showCount: boolean;
  placeholder?: string;
  label?: string;
  describedBy?: string;
  first: boolean;
  onRemove?: () => void;
}

/** One input; on-screen words are typed in the card's own face at 18 px, with the card's time beside it. */
function WordInput({ id, value, onInput, card, face, textCase, max, showCount, placeholder, label, describedBy, first, onRemove }: WordInputProps) {
  const style = useFaceStyle(face ? { font: face.font, weight: face.weight, italic: face.italic } : undefined, textCase);
  return (
    <div class={`kt-word${face ? " face" : ""}`}>
      {card && (
        <span class="kt-cardtime mono" title="When this card appears">
          {fmtTime(card.startSec)}
        </span>
      )}
      <input
        id={id}
        class="kt-input kt-word-input"
        style={face ? style : undefined}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        spellcheck={false}
        autocomplete="off"
        data-first={first || undefined}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      {showCount && max !== undefined && (
        <span class={`kt-counter mono${value.length >= max ? " full" : ""}`} aria-hidden="true">
          {value.length}/{max}
        </span>
      )}
      {onRemove && (
        <button type="button" class="kt-word-x" aria-label={`Remove "${value || "empty word"}"`} onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

function ChoiceField({ f, value, onChange, help, errors, first }: { f: BriefField; value: string; onChange(v: string): void; help: unknown; errors: unknown; first: boolean }) {
  const options = f.options ?? [];
  const isOther = value !== "" && !options.includes(value);
  const [other, setOther] = useState(isOther);
  const otherInput = useRef<HTMLInputElement>(null);
  const name = `brief-${f.id}`;
  return (
    <div class="kt-field">
      <p class="kt-field-label" id={`${name}-label`}>
        {f.label}
      </p>
      {help as never}
      <div class="kt-segments" role="radiogroup" aria-labelledby={`${name}-label`}>
        {options.map((o, i) => (
          <label key={o} class={`kt-segment${!other && value === o ? " on" : ""}`}>
            <input
              type="radio"
              name={name}
              class="kt-sr"
              checked={!other && value === o}
              data-first={(first && i === 0) || undefined}
              onChange={() => {
                setOther(false);
                onChange(o);
              }}
            />
            {o}
          </label>
        ))}
        {f.allowOther && (
          <label class={`kt-segment${other ? " on" : ""}`}>
            <input
              type="radio"
              name={name}
              class="kt-sr"
              checked={other}
              onChange={() => {
                setOther(true);
                onChange(isOther ? value : "");
                requestAnimationFrame(() => otherInput.current?.focus());
              }}
            />
            Other…
          </label>
        )}
      </div>
      {other && (
        <input
          ref={otherInput}
          class="kt-input"
          aria-label={`${f.label}, your own`}
          value={isOther ? value : ""}
          maxLength={f.maxChars ?? 40}
          onInput={(e) => onChange(e.currentTarget.value)}
        />
      )}
      {errors as never}
    </div>
  );
}

// ---------- the rest of "Make it yours" ----------

export interface TrackFieldProps {
  /** The template's own track, when it ships one. */
  soundtrack?: TemplateDetail["soundtrack"];
  choice: MusicChoice;
  onChoice(c: MusicChoice): void;
  music?: Upload;
  uploading?: { name: string; pct: number };
  error?: string;
  /** From the estimate: tempo, drop and how the track lines up. */
  fit?: TrackFit;
  alignDrop: boolean;
  onAlignDrop(v: boolean): void;
  onFile(f: File): void;
  /** Use the sound of an Instagram reel or post. */
  onLink?(url: string): void;
  onRemove(): void;
}

export const AUDIO_ACCEPT = "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/flac,audio/ogg,.mp3,.wav,.m4a,.aac,.flac,.ogg";

/** "Your track" (required while the template has none), or Template track / My own track. */
export function TrackField(p: TrackFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState<string>();
  const [over, setOver] = useState(false);
  const [link, setLink] = useState("");
  const toggle = (url: string) => {
    const a = audio.current;
    if (!a) return;
    if (playing === url) {
      a.pause();
      setPlaying(undefined);
      return;
    }
    a.src = url;
    void a.play().then(
      () => setPlaying(url),
      () => toast("That track can't play in this browser.", { error: true }),
    );
  };
  const pickFile = () => input.current?.click();
  const fileInput = (
    <input
      ref={input}
      type="file"
      class="kt-sr"
      tabIndex={-1}
      aria-hidden="true"
      accept={AUDIO_ACCEPT}
      onChange={(e) => {
        const f = e.currentTarget.files?.[0];
        if (f) p.onFile(f);
        e.currentTarget.value = "";
      }}
    />
  );
  const mine = p.choice === "mine";
  const own = (
    <>
      {p.music ? (
        <div class="kt-track-file">
          {p.music.url ? (
            <button type="button" class="btn icon-btn" aria-label={playing === p.music.url ? "Pause your track" : "Play your track"} onClick={() => toggle(p.music!.url)}>
              <Icon name={playing === p.music.url ? "pause" : "play"} size={14} />
            </button>
          ) : (
            <Icon name="audio" size={16} class="kt-track-icon" />
          )}
          <span class="kt-track-name">{p.music.name}</span>
          {p.music.durationSec !== undefined && <span class="mono kt-dim-text">{fmtTime(p.music.durationSec, 0)}</span>}
          <button type="button" class="btn ghost small" onClick={p.onRemove}>
            Remove
          </button>
        </div>
      ) : p.uploading ? (
        <div class="kt-upload-line">
          {p.uploading.pct < 0 ? (
            <p>Fetching the sound from Instagram…</p>
          ) : (
            <p>
              Uploading {p.uploading.name}… <span class="mono">{Math.round(p.uploading.pct)}%</span>
            </p>
          )}
          <span class={`kt-line-track${p.uploading.pct < 0 ? " waiting" : ""}`} aria-hidden="true">
            <span class="kt-line-bar" style={{ transform: `scaleX(${p.uploading.pct < 0 ? 0.35 : Math.max(0.04, p.uploading.pct / 100)})` }} />
          </span>
        </div>
      ) : (
        <div
          class={`kt-track-drop${over ? " over" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            const f = e.dataTransfer?.files[0];
            if (f) p.onFile(f);
          }}
        >
          {!p.soundtrack && <p class="kt-help">This template doesn't ship a track yet. Add yours and the cut lines up with its beat.</p>}
          <div class="kt-track-pick">
            <button type="button" class="btn" onClick={pickFile}>
              <Icon name="audio" size={14} />
              Choose audio
            </button>
            <span class="kt-fine">MP3, WAV, M4A, AAC, FLAC or OGG · 10 s – 10 min</span>
          </div>
          {p.onLink && (
            <form
              class="kt-link-form"
              onSubmit={(e) => {
                e.preventDefault();
                const url = link.trim();
                if (!url) return;
                p.onLink!(url);
                setLink("");
              }}
            >
              <label class="kt-fine" for="track-link">
                Or use the sound of an Instagram reel
              </label>
              <div class="kt-link-row">
                <input
                  id="track-link"
                  class="kt-input"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellcheck={false}
                  placeholder="https://www.instagram.com/reel/…"
                  value={link}
                  onInput={(e) => setLink(e.currentTarget.value)}
                />
                <button type="submit" class="btn" disabled={!link.trim()}>
                  Use its sound
                </button>
              </div>
              <p class="kt-fine">Use only audio you have the rights to.</p>
            </form>
          )}
        </div>
      )}
      {p.error && (
        <p class="kt-error" role="alert">
          {p.error}
        </p>
      )}
      {p.music && (p.fit || p.music.track) && <TrackNote fit={p.fit} upload={p.music} alignDrop={p.alignDrop} onAlignDrop={p.onAlignDrop} />}
    </>
  );

  return (
    <div class="kt-field kt-track">
      {fileInput}
      <audio ref={audio} onEnded={() => setPlaying(undefined)} preload="none" />
      {p.soundtrack ? (
        <>
          <p class="kt-field-label" id="track-label">
            Music
          </p>
          <div class="kt-radios" role="radiogroup" aria-labelledby="track-label">
            <label class="kt-radio">
              <input type="radio" name="music" checked={p.choice === "template"} onChange={() => p.onChoice("template")} />
              <span>
                Template track: ‘{p.soundtrack.title}’{p.soundtrack.bpm ? <span class="mono"> · {Math.round(p.soundtrack.bpm)} BPM</span> : null}
              </span>
              <button
                type="button"
                class="btn ghost icon-btn"
                aria-label={playing === p.soundtrack.url ? "Pause the template track" : "Play the template track"}
                onClick={() => toggle(p.soundtrack!.url)}
              >
                <Icon name={playing === p.soundtrack.url ? "pause" : "play"} size={14} />
              </button>
            </label>
            <label class="kt-radio">
              <input type="radio" name="music" checked={mine} onChange={() => p.onChoice("mine")} />
              <span>My own track</span>
            </label>
          </div>
          {mine && own}
        </>
      ) : (
        <>
          <p class="kt-field-label">Your track</p>
          {own}
        </>
      )}
    </div>
  );
}

const SHORT_TRACK = "Your track ends before the edit does.";

function TrackNote({ fit, upload, alignDrop, onAlignDrop }: { fit?: TrackFit; upload: Upload; alignDrop: boolean; onAlignDrop(v: boolean): void }) {
  const fallback = upload.track ? `Your track: ${Math.round(upload.track.bpm)} BPM.` : "";
  const note = fit?.note ?? fallback;
  const canAlign = fit ? fit.ok && fit.dropSec !== undefined : upload.track?.dropSec !== undefined;
  return (
    <div class="kt-track-note">
      <p>{note}</p>
      {canAlign && (fit?.aligned || !alignDrop) && (
        <label class="kt-check">
          <input type="checkbox" checked={!alignDrop} onChange={(e) => onAlignDrop(!e.currentTarget.checked)} />
          <span>Start from the beginning instead</span>
        </label>
      )}
      {fit && !note.includes(SHORT_TRACK) && upload.durationSec !== undefined && fit.offsetSec + fit.durationSec > upload.durationSec + 0.05 && <p class="kt-warn-text">{SHORT_TRACK}</p>}
      {fit && fit.ok && <span class="kt-sr">{`Edit length with your track: ${fmtSeconds(fit.durationSec)}.`}</span>}
    </div>
  );
}

/** Director's note (optional), up to the template's limit. */
export function NoteField({ value, max, onChange }: { value: string; max: number; onChange(v: string): void }) {
  return (
    <div class="kt-field">
      <div class="kt-field-top">
        <label class="kt-field-label" for="director-note">
          Director's note <span class="kt-optional">(optional)</span>
        </label>
        {value.length > max * 0.8 && (
          <span class="kt-counter mono" aria-hidden="true">
            {value.length} / {max}
          </span>
        )}
      </div>
      <textarea
        id="director-note"
        class="kt-input kt-textarea"
        rows={2}
        maxLength={max}
        value={value}
        placeholder="Anything the director should know: 'make the spin really clean'"
        onInput={(e) => onChange(e.currentTarget.value)}
      />
    </div>
  );
}

/** "Show me the plan first": the director stops after planning (off by default). */
export function PlanFirstField({ value, onChange }: { value: boolean; onChange(v: boolean): void }) {
  return (
    <div class="kt-field">
      <label class="kt-switch">
        <input type="checkbox" role="switch" checked={value} onChange={(e) => onChange(e.currentTarget.checked)} aria-describedby="plan-first-help" />
        <span class="kt-switch-track" aria-hidden="true" />
        <span>Show me the plan first</span>
      </label>
      <p class="kt-help" id="plan-first-help">
        The director stops after planning so you can check the shots and cost. Adds a pause.
      </p>
    </div>
  );
}

/** "What the director will be told": the exact first prompt, read-only, with Copy. */
export function PromptPreview({ prompt, onOpen, onToggle }: { prompt?: string; onOpen?: () => void; onToggle?: (open: boolean) => void }) {
  const copy = async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Copied.");
    } catch {
      toast("Copying isn't allowed here. Select the text instead.", { error: true });
    }
  };
  return (
    <details
      class="kt-more kt-prompt"
      onToggle={(e) => {
        const open = (e.currentTarget as HTMLDetailsElement).open;
        onToggle?.(open);
        if (open) onOpen?.();
      }}
    >
      <summary>
        <Icon name="chevron" size={12} class="kt-caret" />
        What the director will be told
      </summary>
      <div class="kt-more-body">
        <pre class="kt-prompt-text" tabIndex={0} aria-label="The first message to the director">
          {prompt ?? "Add a photo to see the message."}
        </pre>
        <button type="button" class="btn small" disabled={!prompt} onClick={copy}>
          Copy
        </button>
      </div>
    </details>
  );
}
