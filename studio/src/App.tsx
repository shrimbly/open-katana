import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { Clock } from "./clock.js";
import { addFlash, addText, type Ctx, cutTimes, shotAt, splitShot } from "./edits.js";
import { loadTextFaces } from "./fonts.js";
import { Inspector } from "./Inspector.js";
import { MediaBin } from "./MediaBin.js";
import { useEditor } from "./store.js";
import { clamp, type Snap } from "./time.js";
import { Timeline } from "./Timeline.js";
import { type ViewMode, Viewer } from "./Viewer.js";

interface Toast {
  id: number;
  text: string;
  href?: string;
  error?: boolean;
}

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["← →", "One frame back / forward"],
  ["⇧ ← →", "One beat back / forward"],
  ["↑ ↓", "Previous / next cut"],
  ["T", "Add text at the playhead"],
  ["F", "Add a flash at the playhead"],
  ["S", "Split the shot under the playhead"],
  ["⌫", "Delete the selection"],
  ["⌘Z  ⇧⌘Z", "Undo / redo"],
  ["+ −", "Zoom the timeline"],
  ["Esc", "Clear the selection"],
  ["Alt-drag", "Slip a shot's content"],
];

export function App({ projectId }: { projectId: string }) {
  const editor = useEditor(projectId);
  const { edl, state, selection, setSelection, apply, undo, redo, saving, warnings, error, render, requestRender, history } = editor;
  const clock = useMemo(() => new Clock(), []);
  // Exposed for automation and debugging from the browser console.
  (window as unknown as { studio: unknown }).studio = { clock, editor };
  const [mode, setMode] = useState<ViewMode>("live");
  const [snap, setSnap] = useState<Snap>("beats");
  const [pps, setPps] = useState(90);
  const [tlHeight, setTlHeight] = useState(() => Math.round(Math.min(420, Math.max(280, window.innerHeight * 0.38))));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showWarnings, setShowWarnings] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [lastEditAt, setLastEditAt] = useState(0);
  const exporting = useRef(false);
  const askedPicture = useRef(false);

  const toast = (t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.href ? 12000 : 5000);
  };

  // Fonts used by the edit, so live text and timeline chips draw in the real faces.
  const faces = edl ? [...new Set(edl.text.map((t) => `${t.font}|${t.weight ?? 400}|${t.italic ? 1 : 0}`))].join(",") : "";
  const [, setFontsLoaded] = useState(0);
  useEffect(() => {
    const list = faces
      .split(",")
      .filter(Boolean)
      .map((f) => {
        const [font, weight, italic] = f.split("|");
        return { font: font!, weight: Number(weight), italic: italic === "1" };
      });
    void loadTextFaces(list).then(() => setFontsLoaded((n) => n + 1));
  }, [faces]);

  // The picture-only render powers live text; build it once if the project has none.
  useEffect(() => {
    if (state && edl && !state.renders.notext && !askedPicture.current) {
      askedPicture.current = true;
      void requestRender("notext");
    }
  }, [state, edl, requestRender]);

  // Changes to the edit mark renders as stale.
  const firstEdl = useRef(true);
  useEffect(() => {
    if (!edl) return;
    if (firstEdl.current) {
      firstEdl.current = false;
      return;
    }
    setLastEditAt(Date.now());
  }, [edl]);

  useEffect(() => {
    editor.onRendered.current = (m) => {
      if (m === "master" && exporting.current) {
        exporting.current = false;
        api
          .deliver(projectId)
          .then((d) => toast({ text: `Exported version ${d.version} · ${d.sizeMB.toFixed(1)} MB`, href: d.url }))
          .catch((e: Error) => toast({ text: `Export failed: ${e.message}`, error: true }));
      } else if (m === "preview") {
        setMode("preview");
        toast({ text: "Preview render ready." });
      } else if (m === "master") {
        setMode("master");
        toast({ text: "Final render ready." });
      }
    };
  });

  useEffect(() => {
    if (render.error) toast({ text: `Render failed: ${render.error}`, error: true });
  }, [render.error]);

  const fps = edl?.canvas.fps ?? 24;
  const beats = editor.beats;
  const ctx: Ctx = { fps, beats };
  const headValue = () => {
    const t = clock.time;
    if (snap === "beats" && beats.length) {
      let best = 0;
      beats.forEach((b, i) => Math.abs(b - t) < Math.abs(beats[best]! - t) && (best = i));
      if (Math.abs(beats[best]! - t) < 1.5 / fps) return `b${best}`;
    }
    return +(clock.frame / fps).toFixed(4);
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) {
        if (e.key === "Escape") el.blur();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key;
      if (mod && k.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod) return;
      if (k === " ") {
        e.preventDefault();
        clock.toggle();
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        const dir = k === "ArrowLeft" ? -1 : 1;
        if (e.shiftKey && beats.length) {
          const t = clock.time;
          const next = dir > 0 ? beats.find((b) => b > t + 0.5 / fps) : [...beats].reverse().find((b) => b < t - 0.5 / fps);
          if (next !== undefined) clock.seek(next);
        } else clock.seekFrame(clock.frame + dir);
      } else if (k === "ArrowUp" || k === "ArrowDown") {
        if (!edl) return;
        e.preventDefault();
        const cuts = cutTimes(edl, ctx);
        const t = clock.time;
        clock.seek(k === "ArrowUp" ? ([...cuts].reverse().find((c) => c < t - 0.5 / fps) ?? 0) : (cuts.find((c) => c > t + 0.5 / fps) ?? clock.duration));
      } else if (k === "Home") clock.seek(0);
      else if (k === "End") clock.seek(clock.duration);
      else if (k === "Escape") setSelection(null);
      else if (k === "Delete" || k === "Backspace") {
        if (!selection) return;
        e.preventDefault();
        apply((d) => {
          const list = selection.kind === "shot" ? d.shots : selection.kind === "text" ? d.text : selection.kind === "flash" ? d.flashes : d.sfx;
          if (selection.kind === "shot" && d.shots.length <= 1) return;
          list.splice(selection.index, 1);
        });
        setSelection(null);
      } else if (k === "t" || k === "T") {
        let idx = 0;
        apply((d) => void (idx = addText(d, headValue(), ctx)));
        setTimeout(() => setSelection({ kind: "text", index: idx }));
      } else if (k === "f" || k === "F") {
        let idx = 0;
        apply((d) => void (idx = addFlash(d, headValue(), ctx)));
        setTimeout(() => setSelection({ kind: "flash", index: idx }));
      } else if (k === "s" || k === "S") {
        apply((d) => {
          const idx = shotAt(d, clock.time, ctx);
          if (idx >= 0) splitShot(d, idx, +(clock.frame / fps).toFixed(4), ctx);
        });
      } else if (k === "+" || k === "=") setPps((p) => clamp(p * 1.25, 8, 640));
      else if (k === "-" || k === "_") setPps((p) => clamp(p / 1.25, 8, 640));
      else if (k === "?") setShowKeys((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const startSplitter = (e: PointerEvent) => {
    const y0 = e.clientY;
    const h0 = tlHeight;
    const move = (ev: PointerEvent) => setTlHeight(clamp(h0 - (ev.clientY - y0), 180, window.innerHeight - 260));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  };

  const saveLabel = saving === "error" ? `Not saved: ${error ?? "error"}` : saving === "saved" ? (error ? error : "All changes saved") : "Saving…";
  const busy = render.running && render.mode !== "notext";

  return (
    <div class="app" style={{ "--timeline-h": `${tlHeight}px` }}>
      <header class="topbar">
        <div class="brand">
          <a href="./">open-katana</a>
          <span class="title">{state?.project.title ?? "Loading…"}</span>
        </div>
        <span class={`save-state${saving === "error" ? " error" : ""}`} role="status">
          {saveLabel}
        </span>
        <span class="spacer" />
        <button class="btn ghost icon-btn" type="button" onClick={undo} disabled={!history.undo} title="Undo (⌘Z)" aria-label="Undo">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5.5 3.5 2.5 6.5l3 3" />
            <path d="M2.5 6.5h7a4 4 0 0 1 0 8H7" />
          </svg>
        </button>
        <button class="btn ghost icon-btn" type="button" onClick={redo} disabled={!history.redo} title="Redo (⇧⌘Z)" aria-label="Redo">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m10.5 3.5 3 3-3 3" />
            <path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9" />
          </svg>
        </button>
        {warnings.length > 0 && (
          <span class="warn-chip">
            <button class="btn ghost" type="button" onClick={() => setShowWarnings((v) => !v)} aria-expanded={showWarnings}>
              <span class="count">{warnings.length}</span> {warnings.length === 1 ? "note" : "notes"}
            </button>
            {showWarnings && (
              <div class="popover">
                <span class="label">Timing notes</span>
                <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </span>
        )}
        <button class="btn" type="button" disabled={!edl || busy} onClick={() => requestRender("preview")} title="Half resolution, text included">
          {busy && render.mode === "preview" ? `Rendering ${render.done}/${render.total || "…"}` : "Render preview"}
        </button>
        <button
          class="btn primary"
          type="button"
          disabled={!edl || busy}
          onClick={() => {
            exporting.current = true;
            void requestRender("master");
          }}
          title="Render at full quality and save a new version"
        >
          {busy && render.mode === "master" ? `Rendering ${render.done}/${render.total || "…"}` : "Export"}
        </button>
      </header>

      <div class="workspace">
        <MediaBin editor={editor} />
        <Viewer editor={editor} clock={clock} mode={mode} setMode={setMode} lastEditAt={lastEditAt} />
        <Inspector editor={editor} clock={clock} />
      </div>
      <div class="splitter" onPointerDown={startSplitter} role="separator" aria-orientation="horizontal" aria-label="Resize timeline" />
      <Timeline editor={editor} clock={clock} snap={snap} setSnap={setSnap} pps={pps} setPps={setPps} showShortcuts={() => setShowKeys((v) => !v)} />

      {showKeys && (
        <div class="popover" style={{ position: "fixed", top: "auto", bottom: `${tlHeight + 16}px`, right: "16px" }} role="dialog" aria-label="Keyboard shortcuts">
          <div class="row" style={{ justifyContent: "space-between" }}>
            <span class="label">Keyboard</span>
            <button class="btn small ghost" type="button" onClick={() => setShowKeys(false)}>
              Close
            </button>
          </div>
          <div class="shortcuts">
            {SHORTCUTS.map(([k, v]) => (
              <Fragment key={k}>
                <span>
                  <span class="kbd">{k}</span>
                </span>
                <span>{v}</span>
              </Fragment>
            ))}
          </div>
        </div>
      )}

      <div class="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class={`toast${t.error ? " error" : ""}`}>
            {t.text}
            {t.href && (
              <>
                {" "}
                <a href={t.href} target="_blank" rel="noreferrer">
                  Open file
                </a>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProjectPicker() {
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.projects>>>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => setErr(e.message));
  }, []);
  return (
    <main class="picker">
      <h1>Your edits</h1>
      <p>Open an edit to see its shots, text and sound on a timeline.</p>
      {err && <p style={{ color: "var(--danger)" }}>{err}</p>}
      {projects?.length === 0 && <p>No projects yet. Start one by asking the agent to make an edit with open-katana.</p>}
      {projects?.map((p) => (
        <a key={p.id} class="project-row" href={`?project=${encodeURIComponent(p.id)}`}>
          <span class="project-title">{p.title}</span>
          <span class="hint">{p.versions ? `${p.versions} version${p.versions === 1 ? "" : "s"}` : p.stage}</span>
          <span class="hint mono">{new Date(p.updatedAt).toLocaleDateString()}</span>
        </a>
      ))}
    </main>
  );
}
