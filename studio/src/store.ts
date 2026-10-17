import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type Edl, HttpError, type ProjectState } from "./api.js";
import { gridBeats } from "./time.js";

export interface Selection {
  kind: "shot" | "text" | "flash" | "sfx";
  index: number;
}

export interface RenderStatus {
  running: boolean;
  mode?: string;
  done: number;
  total: number;
  error?: string;
}

export type SaveState = "saved" | "pending" | "saving" | "error";

/** Run statuses that hold the project lock: the director owns the edit and the editor is read-only (D26). */
const HOLDS_LOCK = new Set(["queued", "starting", "running", "stopping", "paused"]);

/** Overlay text is drawn live in the viewer; everything else (including text behind the subject) is in the picture. */
const pictureKey = (edl: Edl) => JSON.stringify({ ...edl, text: edl.text.filter((t) => t.behind), flashes: edl.flashes.filter((f) => !f.overText) });

export function useEditor(projectId: string) {
  const [state, setState] = useState<ProjectState>();
  const [edl, setEdl] = useState<Edl>();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [saving, setSavingState] = useState<SaveState>("saved");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [render, setRender] = useState<RenderStatus>({ running: false, done: 0, total: 0 });
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const past = useRef<Edl[]>([]);
  const future = useRef<Edl[]>([]);
  const coalesce = useRef<{ key: string; at: number } | null>(null);
  const saveTimer = useRef<number>();
  const savingRef = useRef<SaveState>("saved");
  const lastSent = useRef("");
  const lastServer = useRef("");
  const lastPicture = useRef("");
  const onRendered = useRef<((mode: string) => void) | null>(null);
  // While an app run holds the project nothing here writes: no edits, autosave or renders.
  const [locked, setLockedState] = useState(false);
  const lockedRef = useRef(false);
  const [fromApp, setFromApp] = useState(false);
  const setLocked = (v: boolean) => {
    lockedRef.current = v;
    setLockedState(v);
  };

  const setSaving = (s: SaveState) => {
    savingRef.current = s;
    setSavingState(s);
  };
  const syncHistory = () => setHistory({ undo: past.current.length, redo: future.current.length });

  const reload = useCallback(
    async (takeEdl: boolean) => {
      const s = await api.project(projectId);
      setState(s);
      setWarnings(s.check);
      if (s.render?.running) setRender({ running: true, mode: s.render.mode, done: s.render.done, total: s.render.total });
      if (takeEdl && s.edl) {
        const text = JSON.stringify(s.edl);
        if (text !== lastServer.current) {
          lastServer.current = text;
          lastSent.current = text;
          lastPicture.current = pictureKey(s.edl);
          setEdl(s.edl);
        }
      }
      return s;
    },
    [projectId],
  );

  useEffect(() => {
    reload(true).catch((e: Error) => setError(e.message));
    // Projects the app made know their run; an older server or a chat project answers without one.
    api.appInfo(projectId).then(
      (info) => {
        setLocked(info.locked);
        setFromApp(info.card.origin !== "chat");
      },
      () => undefined,
    );
    return api.events(projectId, (e) => {
      if (e.type === "run") {
        const status = String((e.state as { status?: unknown } | undefined)?.status ?? "");
        const was = lockedRef.current;
        setLocked(HOLDS_LOCK.has(status));
        setFromApp(true);
        // The director has finished with the edit: pick up its last cut.
        if (was && !HOLDS_LOCK.has(status)) reload(true).catch(() => undefined);
      } else if (e.type === "edl") {
        // Saves from elsewhere (the agent) replace the working copy unless an edit here is still unsaved.
        if (savingRef.current === "saved") reload(true).catch(() => undefined);
      } else if (e.type === "render") {
        setRender({ running: Boolean(e.running), mode: String(e.mode), done: Number(e.done), total: Number(e.total) });
      } else if (e.type === "rendered") {
        setRender({ running: false, mode: String(e.mode), done: 0, total: 0 });
        reload(false)
          .then(() => onRendered.current?.(String(e.mode)))
          .catch(() => undefined);
      } else if (e.type === "render-error") {
        setRender({ running: false, done: 0, total: 0, error: String(e.error) });
      }
    });
  }, [projectId, reload]);

  const persist = useCallback(
    (next: Edl) => {
      window.clearTimeout(saveTimer.current);
      if (lockedRef.current) return;
      setSaving("pending");
      saveTimer.current = window.setTimeout(async () => {
        const text = JSON.stringify(next);
        if (text === lastSent.current) return setSaving("saved");
        setSaving("saving");
        try {
          const r = await api.saveEdl(projectId, next);
          lastSent.current = text;
          lastServer.current = JSON.stringify(r.edl);
          setWarnings(r.warnings);
          setError(undefined);
          // A newer edit made while this save was in flight keeps the state pending.
          if (savingRef.current === "saving") setSaving("saved");
          const picture = pictureKey(next);
          if (picture !== lastPicture.current) {
            lastPicture.current = picture;
            await api.render(projectId, "notext");
          }
        } catch (e) {
          if (e instanceof HttpError && e.code === "RUN_ACTIVE") {
            // A run took the project after this page loaded: drop the change and follow the director.
            setLocked(true);
            setSaving("saved");
            setError(undefined);
            reload(true).catch(() => undefined);
            return;
          }
          setSaving("error");
          setError((e as Error).message);
        }
      }, 400);
    },
    [projectId],
  );

  /**
   * Applies an edit. Successive edits with the same `key` (one drag, or typing in one field) become a
   * single undo step; drag keys ("drag:…") merge for the whole gesture.
   */
  const apply = useCallback(
    (fn: (draft: Edl) => void, key?: string) => {
      if (lockedRef.current) return;
      setEdl((current) => {
        if (!current) return current;
        const draft = structuredClone(current);
        fn(draft);
        const now = Date.now();
        const merge = key !== undefined && coalesce.current?.key === key && (key.startsWith("drag:") || now - coalesce.current.at < 800);
        if (!merge) {
          past.current.push(current);
          if (past.current.length > 300) past.current.shift();
        }
        future.current = [];
        coalesce.current = key ? { key, at: now } : null;
        persist(draft);
        syncHistory();
        return draft;
      });
    },
    [persist],
  );

  const undo = useCallback(() => {
    if (lockedRef.current) return;
    setEdl((current) => {
      const prev = past.current.pop();
      if (!prev || !current) return current;
      future.current.push(current);
      coalesce.current = null;
      persist(prev);
      syncHistory();
      return prev;
    });
  }, [persist]);

  const redo = useCallback(() => {
    if (lockedRef.current) return;
    setEdl((current) => {
      const next = future.current.pop();
      if (!next || !current) return current;
      past.current.push(current);
      coalesce.current = null;
      persist(next);
      syncHistory();
      return next;
    });
  }, [persist]);

  // The edit's beats: its grid override (recomputed live while it is edited), else the tracked beats.
  const grid = edl?.grid;
  const serverBeats = state?.beats;
  const beats = useMemo(() => (grid ? gridBeats(grid, edl?.canvas.durationSec ?? 300) : (serverBeats ?? [])), [grid?.bpm, grid?.phase, serverBeats, edl?.canvas.durationSec]);

  const requestRender = useCallback(
    (mode: "notext" | "preview" | "master") => {
      if (lockedRef.current) return Promise.resolve();
      setRender((r) => ({ ...r, running: true, mode, error: undefined }));
      return api.render(projectId, mode).catch((e: Error) => setError(e.message));
    },
    [projectId],
  );

  return { projectId, state, edl, beats, selection, setSelection, apply, undo, redo, saving, warnings, error, setError, render, requestRender, reload, history, onRendered, locked, fromApp };
}

export type Editor = ReturnType<typeof useEditor>;
