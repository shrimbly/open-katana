import type { ButtonHTMLAttributes, ComponentChildren, JSX, Ref } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { reducedMotion } from "./flash.js";

/**
 * The app's small building blocks (spec §5): buttons in the studio's metrics, sheets and dialogs that
 * trap focus, chips, toasts, labels, stats, media boxes and the rail's numbered steps.
 */

// ---------- buttons ----------

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  variant: "primary" | "ghost" | "danger" | "cta";
  size?: "small";
}

export function Button({ variant, size, class: cls, type = "button", ...rest }: ButtonProps) {
  return <button {...rest} type={type} class={["btn", variant, size, cls].filter(Boolean).join(" ")} />;
}

// ---------- icons ----------

const ICONS: Record<string, JSX.Element> = {
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  play: <path d="M7 4.5v15l12-7.5z" />,
  pause: <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />,
  sound: <path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />,
  mute: <path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  surprise: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  back: <path d="M15 6 9 12l6 6" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
  grip: <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </>
  ),
  warn: <path d="M12 3 2 21h20zM12 10v5M12 18h.01" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  audio: <path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />,
  film: <path d="M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4" />,
};

export type IconName = keyof typeof ICONS;

/** A 16 px stroke icon; decorative unless given a `label`. */
export function Icon({ name, label, size = 16, class: cls }: { name: IconName; label?: string; size?: number; class?: string }) {
  const filled = name === "play" || name === "pause" || name === "bolt";
  return (
    <svg
      class={["kt-icon", filled && "filled", cls].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {ICONS[name]}
    </svg>
  );
}

// ---------- focus management ----------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

/**
 * Everything Esc can close (sheets, dialogs, popovers, menus), newest last. One capture-phase listener
 * serves them all, so Esc closes only the newest layer: a licence popover inside the approve dialog
 * closes on its own, and a dialog over a sheet leaves the sheet open. Tab stays inside the newest layer
 * that traps focus.
 */
interface Layer {
  close: () => void;
  /** The element focus is kept inside; none for a layer that doesn't trap (a popover, a menu). */
  trap?: () => HTMLElement | null;
}
const layers: Layer[] = [];

function onLayerKey(e: KeyboardEvent) {
  const top = layers.at(-1);
  if (!top || e.isComposing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    top.close();
    return;
  }
  if (e.key !== "Tab") return;
  const el = [...layers].reverse().find((l) => l.trap)?.trap?.();
  if (!el) return;
  const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
  if (!items.length) return e.preventDefault();
  const head = items[0]!;
  const tail = items[items.length - 1]!;
  const inside = el.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === head || !inside)) {
    e.preventDefault();
    tail.focus();
  } else if (!e.shiftKey && (document.activeElement === tail || !inside)) {
    e.preventDefault();
    head.focus();
  }
}

/**
 * Registers an Esc-closable layer while `active`. With `trap`, Tab also stays inside that element.
 * It joins the stack as soon as it is drawn (a layout effect, so an Esc pressed right after it opens
 * already reaches it) and leaves when it closes, so one Esc never closes two.
 */
export function useLayer(active: boolean, onClose: () => void, trap?: { current: HTMLElement | null }) {
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!active) return;
    const layer: Layer = { close: () => close.current(), ...(trap ? { trap: () => trap.current } : {}) };
    layers.push(layer);
    if (layers.length === 1) document.addEventListener("keydown", onLayerKey, true);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      if (!layers.length) document.removeEventListener("keydown", onLayerKey, true);
    };
  }, [active]);
}

/** Keeps Tab inside `ref` while `active`, closes on Esc, and puts focus back where it was afterwards. */
function useFocusTrap(ref: { current: HTMLElement | null }, active: boolean, onClose: () => void) {
  useLayer(active, onClose, ref);
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (before?.isConnected) before.focus();
    };
  }, [active, ref]);
}

// ---------- sheet & dialog ----------

export interface SheetProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ComponentChildren;
}

/** A panel that slides in from the right (full screen on phones). Esc and the backdrop close it. */
export function Sheet({ open, title, onClose, children }: SheetProps) {
  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel, open, onClose);
  if (!open) return null;
  return (
    <div class="kt-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={panel} class="kt-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header class="kt-sheet-head">
          <h2 class="kt-sheet-title">{title}</h2>
          <button type="button" class="btn ghost icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div class="kt-sheet-body">{children}</div>
      </aside>
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ComponentChildren;
  actions?: ComponentChildren;
}

/** A modal dialog; Esc and the backdrop close it, and focus stays inside while it is open. */
export function Dialog({ open, title, onClose, children, actions }: DialogProps) {
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, open, onClose);
  if (!open) return null;
  return (
    <div class="kt-layer center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} class="kt-dialog" role="dialog" aria-modal="true" aria-labelledby="kt-dialog-title" tabIndex={-1}>
        <h2 id="kt-dialog-title" class="kt-dialog-title">
          {title}
        </h2>
        <div class="kt-dialog-body">{children}</div>
        {actions && <div class="kt-dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** A small panel under a trigger button (e.g. licence Details); Esc or a click outside closes it. */
export function Popover({ label, title, children, class: cls }: { label: ComponentChildren; title: string; children: ComponentChildren; class?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  // Esc closes the popover alone, even inside a dialog, and focus goes back to its button.
  useLayer(open, () => {
    setOpen(false);
    wrap.current?.querySelector<HTMLElement>("button")?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <span ref={wrap} class={["kt-pop", cls].filter(Boolean).join(" ")}>
      <button type="button" class="kt-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div class="kt-popover" role="dialog" aria-label={title}>
          {children}
        </div>
      )}
    </span>
  );
}

// ---------- chips ----------

export interface ChipProps {
  selected?: boolean;
  onClick(): void;
  children: ComponentChildren;
}

/** A filter or suggestion chip; `selected` makes it a pressed toggle. */
export function Chip({ selected, onClick, children }: ChipProps) {
  return (
    <button type="button" class={`kt-chip${selected ? " selected" : ""}`} aria-pressed={selected === undefined ? undefined : selected} onClick={onClick}>
      {children}
    </button>
  );
}

// ---------- toasts ----------

export interface ToastOptions {
  /** One action button, e.g. Update video. */
  action?: { label: string; onClick(): void };
  error?: boolean;
  timeoutMs?: number;
}

export interface Toast extends ToastOptions {
  id: number;
  message: string;
}

const toastListeners = new Set<(t: Toast) => void>();
let toastId = 0;

/** Shows a short message at the bottom of the screen. */
export function toast(message: string, opts: ToastOptions = {}): void {
  const t: Toast = { ...opts, id: ++toastId, message };
  for (const l of toastListeners) l(t);
}

/** For the component that draws toasts. Returns the unsubscribe function. */
export function onToast(listener: (t: Toast) => void): () => void {
  toastListeners.add(listener);
  return () => void toastListeners.delete(listener);
}

/** Draws the toasts (the Shell mounts one). Polite live region; errors stay longer. */
export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(
    () =>
      onToast((t) => {
        setList((l) => [...l.slice(-3), t]);
        const ms = t.timeoutMs ?? (t.action ? 10_000 : t.error ? 8000 : 5000);
        setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), ms);
      }),
    [],
  );
  const dismiss = (id: number) => setList((l) => l.filter((x) => x.id !== id));
  return (
    <div class="kt-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`kt-toast${t.error ? " error" : ""}`}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              class="btn small primary"
              onClick={() => {
                t.action!.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" class="kt-toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- type ----------

/** Small tracked uppercase label (the studio's `.label`). */
export function Label({ children }: { children: ComponentChildren }) {
  return <span class="label">{children}</span>;
}

export interface StatProps {
  value: string | number;
  unit?: string;
}

/** A big number with its unit, e.g. "23 CUTS". */
export function Stat({ value, unit }: StatProps) {
  return (
    <span class="kt-stat">
      <span class="kt-stat-value">{typeof value === "number" ? <Num value={value} ms={300} countUp /> : value}</span>
      {unit && <span class="kt-stat-unit">{unit}</span>}
    </span>
  );
}

/**
 * A tabular number that rolls to its new value over `ms` (120 ms, the receipt's roll; instant under
 * reduced motion). `countUp` starts it from 0 when it first appears (the decode stat row, 300 ms).
 */
export function Num({
  value,
  digits = 0,
  prefix = "",
  suffix = "",
  ms = 120,
  countUp = false,
}: {
  value: number;
  digits?: number;
  prefix?: string;
  suffix?: string;
  ms?: number;
  countUp?: boolean;
}) {
  const [shown, setShown] = useState(() => (countUp && !reducedMotion() ? 0 : value));
  const from = useRef(countUp ? 0 : value);
  useEffect(() => {
    if (from.current === value || reducedMotion()) {
      from.current = value;
      return setShown(value);
    }
    const a = from.current;
    const start = performance.now();
    let frame = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / ms);
      setShown(a + (value - a) * (1 - (1 - k) ** 2));
      if (k < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      from.current = value;
    };
  }, [value, ms]);
  return (
    <span class="mono">
      {prefix}
      {shown.toFixed(digits)}
      {suffix}
    </span>
  );
}

// ---------- layout ----------

export interface MediaBoxProps {
  /** Width / height; the box reserves this shape before anything loads. */
  aspect: number;
  poster?: string;
  video?: string;
  grain?: boolean;
  children?: ComponentChildren;
  videoRef?: Ref<HTMLVideoElement>;
  autoPlay?: boolean;
  loop?: boolean;
  class?: string;
}

/** A box at the media's true aspect: poster first, then the (muted) video over it, optional grain. */
export function MediaBox({ aspect, poster, video, grain, children, videoRef, autoPlay, loop = true, class: cls }: MediaBoxProps) {
  return (
    <div class={["kt-media", grain && "kt-grain", cls].filter(Boolean).join(" ")} style={{ aspectRatio: String(aspect) }}>
      {poster && <img class="kt-media-poster" src={poster} alt="" decoding="async" />}
      {video && <video ref={videoRef} src={video} poster={poster} muted playsInline loop={loop} autoPlay={autoPlay} preload="metadata" />}
      {children}
    </div>
  );
}

export interface StepProps {
  n: number;
  title: string;
  /** open: in use · dim: not yet · done: finished, still open. */
  state: "open" | "dim" | "done";
  aside?: ComponentChildren;
  children?: ComponentChildren;
  id?: string;
}

/** One numbered step of a make rail (1 YOUR PHOTO, 2 MAKE IT YOURS, 3 BUDGET). Dimmed steps hide their body. */
export function Step({ n, title, state, aside, children, id }: StepProps) {
  return (
    <section class={`kt-step ${state}`} aria-labelledby={id ? `${id}-h` : undefined} id={id}>
      <div class="kt-step-head">
        <h2 class="kt-step-title" id={id ? `${id}-h` : undefined}>
          <span class="kt-step-n" aria-hidden="true">
            {state === "done" ? <Icon name="check" size={12} /> : n}
          </span>
          <span class="label">{title}</span>
          {state === "done" && <span class="kt-sr">, done</span>}
        </h2>
        {aside}
      </div>
      {state !== "dim" && children}
    </section>
  );
}

/** Screen-reader announcements (one polite region for the whole app). */
export function useAnnounce(): [string, (msg: string) => void] {
  const [msg, setMsg] = useState("");
  const say = (m: string) => {
    setMsg("");
    // A fresh node each time so the same sentence is announced twice.
    requestAnimationFrame(() => setMsg(m));
  };
  return [msg, say];
}

/** Keeps a value for `ms` after it changes (a debounce for effects). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useLayoutEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
