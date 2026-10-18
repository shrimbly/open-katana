import { useEffect, useRef, useState } from "preact/hooks";
import type { RunState, RunSummary, TemplateCard, Upload } from "../../../../src/app/types.js";
import { ApiError, app } from "../api.js";
import { fmtRange } from "../beat.js";
import { splitHeadline } from "../copy.js";
import { CutMap } from "../CutMap.js";
import { Gallery } from "../Gallery.js";
import { stashPhoto } from "../PhotoDrop.js";
import { navigate, Link } from "../router.js";
import { ACTIVE, useApp } from "../Shell.js";
import { Icon, toast } from "../ui.js";

/**
 * Home (spec §4.2): the hero and the decode drop box, edits being made now, then the gallery. The
 * whole page takes a dropped video (it decodes) or a photo (kept for the next template page).
 */

const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv";
const isVideo = (f: File) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
const isImage = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);

/** "12 Oct" from a project id that starts with its creation date (yyyymmdd-…). */
function dayOf(projectId: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})-/.exec(projectId);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

interface DecodeUpload {
  name: string;
  pct: number;
  error?: string;
  abort?: () => void;
  /** Fetching an Instagram link: no byte progress, just the wait. */
  link?: boolean;
}

export function Home() {
  const { runs, templatesRev, setup } = useApp();
  const [templates, setTemplates] = useState<TemplateCard[]>();
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [up, setUp] = useState<DecodeUpload>();
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  useEffect(() => {
    let live = true;
    app.templates().then(
      (r) => live && (setTemplates(r.templates), setError(undefined)),
      (e: Error) => live && setError(`Templates didn't load: ${e.message}`),
    );
    return () => {
      live = false;
    };
  }, [templatesRev]);

  // Leaving Home cancels an edit still uploading (nothing is decoded yet).
  const abortRef = useRef<() => void>();
  abortRef.current = up && !up.error && up.pct < 100 ? up.abort : undefined;
  useEffect(() => () => abortRef.current?.(), []);

  const decodeOff = setup !== undefined && !setup.ready.decode;
  // The hero carries one edit's barcode, faint, as a signature (the densest built-in cut).
  const heroMap = templates
    ?.filter((t) => t.cutMap.shots.length)
    .sort((a, b) => b.cutMap.shots.length / b.cutMap.durationSec - a.cutMap.shots.length / a.cutMap.durationSec)[0]?.cutMap;

  const decode = (f: File) => {
    if (decodeOff) {
      setUp({ name: f.name, pct: 0, error: "Install ffmpeg to decode and render edits." });
      return;
    }
    const task = app.upload(f, "edit", (frac) => setUp((u) => (u && !u.error ? { ...u, pct: frac * 100 } : u)));
    setUp({ name: f.name, pct: 0, abort: task.abort });
    task.promise.then((u) => startDecode(u, f.name)).catch((e: ApiError) => {
      if (e.code === "ABORTED") return setUp(undefined);
      setUp({ name: f.name, pct: 0, error: e.message });
    });
  };

  /** An uploaded edit, from a file or an Instagram link, goes to the decode. */
  const startDecode = async (u: Upload, name: string) => {
    setUp({ name, pct: 100 });
    const r = await app.decode({ upload: u.id });
    if (r.reused) toast(`You decoded this edit on ${dayOf(r.project) ?? "an earlier day"}. Opening it.`);
    navigate(`/decode/${encodeURIComponent(r.project)}`);
  };

  const [link, setLink] = useState("");
  const copyLink = (e: Event) => {
    e.preventDefault();
    const url = link.trim();
    if (!url || busy) return;
    if (decodeOff) {
      setUp({ name: "Instagram link", pct: 0, error: "Install ffmpeg to decode and render edits." });
      return;
    }
    setUp({ name: "Instagram link", pct: 0, link: true });
    app
      .importLink(url, "edit")
      .then((u) => startDecode(u, u.name))
      .then(() => setLink(""))
      .catch((err: ApiError) => setUp({ name: "Instagram link", pct: 0, error: err.message }));
  };

  const take = (files: File[]) => {
    const video = files.find(isVideo);
    if (video) return decode(video);
    const photo = files.find(isImage);
    if (photo) {
      stashPhoto(photo);
      toast("Pick a template for this photo.");
      const head = document.getElementById("templates");
      head?.scrollIntoView({ behavior: "smooth", block: "start" });
      head?.focus({ preventScroll: true });
      return;
    }
    if (files.length) toast("That's not a video we can read. Use MP4, MOV, WEBM or MKV.", { error: true });
  };

  // The whole page is a drop target.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      take([...(e.dataTransfer?.files ?? [])]);
    };
    addEventListener("dragenter", enter);
    addEventListener("dragleave", leave);
    addEventListener("dragover", over);
    addEventListener("drop", drop);
    return () => {
      removeEventListener("dragenter", enter);
      removeEventListener("dragleave", leave);
      removeEventListener("dragover", over);
      removeEventListener("drop", drop);
    };
  });

  const busy = up && !up.error;
  return (
    <main id="content" class={`kt-page kt-home${dragging ? " dragging" : ""}`}>
      <section class="kt-hero kt-grain" aria-labelledby="hero-title">
        {heroMap && (
          <div class="kt-hero-map" aria-hidden="true">
            <CutMap data={heroMap} height={20} label="" tint="#ece7dc" />
          </div>
        )}
        <div class="kt-hero-copy">
          <h1 id="hero-title" class="kt-display-xl kt-slam">
            <span>Make an edit</span> <span>of yourself.</span>
          </h1>
          <p class="kt-hero-sub">
            Pick a template and drop a photo of you.
            <br />
            Or drop an edit you love and put yourself in it.
          </p>
        </div>
        <div class="kt-hero-drop">
          <div class={`kt-dropbox${dragging ? " hot" : ""}${up?.error ? " error" : ""}`}>
            <input
              ref={input}
              type="file"
              class="kt-sr"
              tabIndex={-1}
              aria-hidden="true"
              accept={VIDEO_ACCEPT}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) take([f]);
                e.currentTarget.value = "";
              }}
            />
            <p class="kt-dropbox-title">{dragging ? "Drop to decode" : "Drop any edit"}</p>
            {busy ? (
              <div class="kt-dropbox-progress" role="status">
                <p>
                  {up.link ? "Fetching the edit from Instagram…" : up.pct >= 100 ? "Starting the decode…" : "Uploading"}
                  {!up.link && <span class="kt-dropbox-name"> {up.name}</span>}
                  {!up.link && up.pct < 100 && <span class="mono"> {Math.round(up.pct)}%</span>}
                </p>
                <span class={`kt-line-track${up.link ? " waiting" : ""}`}>
                  <span class="kt-line-bar" style={{ transform: `scaleX(${up.link ? 0.35 : Math.max(0.03, up.pct / 100)})` }} />
                </span>
                {!up.link && up.pct < 100 && (
                  <button type="button" class="btn ghost small" onClick={() => up.abort?.()}>
                    Cancel
                  </button>
                )}
              </div>
            ) : (
              <>
                <p class="kt-dropbox-text">We'll find every cut, flash and beat in seconds.</p>
                {up?.error && (
                  <p class="kt-error" role="alert">
                    {up.error}
                  </p>
                )}
                <button type="button" class="btn primary" disabled={decodeOff} onClick={() => input.current?.click()}>
                  <Icon name="film" size={14} />
                  Choose a video
                </button>
                <p class="kt-fine">MP4, MOV, WEBM or MKV · up to 60 s · 300 MB</p>
              </>
            )}
          </div>
          <form class="kt-link-form" onSubmit={copyLink}>
            <label class="kt-fine" for="edit-link">
              Or paste an Instagram reel link
            </label>
            <div class="kt-link-row">
              <input
                id="edit-link"
                class="kt-input"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellcheck={false}
                placeholder="https://www.instagram.com/reel/…"
                value={link}
                onInput={(e) => setLink(e.currentTarget.value)}
                disabled={busy}
              />
              <button type="submit" class="btn" disabled={!link.trim() || busy || decodeOff}>
                Copy this edit
              </button>
            </div>
            <p class="kt-fine kt-dropbox-hint">Fetched on this computer with instaloader. Copy only edits you have the rights to use. From TikTok? Save the video, then drop it here.</p>
          </form>
        </div>
      </section>

      <MakingNow runs={runs.filter((r) => ACTIVE.includes(r.status))} />

      <Gallery templates={templates} error={error} />

      <p class="kt-footer-note">Runs on your computer. Your photos go only to your GPU provider (to make shots) and to Claude (to judge them).</p>
      {dragging && <div class="kt-drop-dim" aria-hidden="true" />}
    </main>
  );
}

// ---------- making now ----------

const ATTENTION_LINE: Record<string, (s?: RunState) => string> = {
  NEEDS_APPROVAL: () => "YOUR CALL · the plan is ready",
  BUDGET_CAP: (s) => (s?.attention?.needsMinutes ? `NEEDS YOUR OK · approve ${Math.ceil((s.attention.needsMinutes * 1.1) / 5) * 5} GPU min` : "NEEDS YOUR OK"),
  OUT_OF_CREDITS: () => "OUT OF CREDITS · top up, then continue",
  BACKEND_DOWN: () => "GPU OFFLINE · start ComfyUI, then continue",
  USAGE_LIMIT: (s) => {
    const at = s?.attention?.resetsAt ? new Date(s.attention.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : undefined;
    return at ? `PLAN LIMIT · resets at ${at}` : "PLAN LIMIT";
  },
  USD_CAP: () => "BUDGET USED · raise the director budget",
  QUESTION: () => "THE DIRECTOR ASKS · reply to continue",
};

function MakingNow({ runs }: { runs: RunSummary[] }) {
  const [details, setDetails] = useState<Record<string, RunState>>({});
  const ids = runs.map((r) => `${r.id}:${r.status}:${Math.floor(r.pct / 5)}:${r.attention ?? ""}`).join(",");
  useEffect(() => {
    let live = true;
    for (const r of runs)
      app.run(r.id).then(
        (s) => live && setDetails((d) => ({ ...d, [r.id]: s })),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [ids]);
  if (!runs.length) return null;
  return (
    <section class="kt-now" aria-labelledby="now-title">
      <div class="kt-section-head">
        <h2 id="now-title" class="kt-section-title">
          Making now
        </h2>
        <span class="kt-section-rule" aria-hidden="true" />
      </div>
      <ul class="kt-now-list">
        {runs.map((r) => {
          const s = details[r.id];
          const needs = r.status === "paused";
          const queued = r.status === "queued";
          // Running rows arrive as "SHOOTING STILLS · 0 of 4 stills": caps for the stage, the detail as written.
          const head = splitHeadline(r.headline);
          const line = needs ? (ATTENTION_LINE[r.attention ?? ""]?.(s) ?? r.headline) : queued ? "UP NEXT" : head.stage;
          const detail = needs ? undefined : queued ? (r.queuePosition && r.queuePosition > 1 ? `${r.queuePosition} in line` : (s?.detail ?? head.detail ?? "Starting…")) :(head.detail ?? s?.detail);
          return (
            <li key={r.id}>
              <Link class={`kt-now-row${needs ? " needs" : ""}${queued ? " queued" : ""}`} href={`/p/${encodeURIComponent(r.project)}`}>
                <span class="kt-now-poster" aria-hidden="true">
                  <img src={r.poster ?? app.posterUrl(r.project, 120)} alt="" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                </span>
                <span class="kt-now-title">{r.title}</span>
                <span class="kt-now-line">
                  {line}
                  {detail && <span class="kt-now-detail"> · {detail}</span>}
                </span>
                {!needs && !queued && (
                  <>
                    <span class="kt-now-bar" aria-hidden="true">
                      <span style={{ transform: `scaleX(${Math.max(0.01, r.pct / 100)})` }} />
                    </span>
                    <span class="kt-now-pct mono">{Math.round(r.pct)}%</span>
                    <span class="kt-now-eta">{s?.etaMin ? `${fmtRange(s.etaMin[0], s.etaMin[1])} min left` : ""}</span>
                  </>
                )}
                {(needs || queued) && <span class="kt-now-go">{needs ? "Open" : ""}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
