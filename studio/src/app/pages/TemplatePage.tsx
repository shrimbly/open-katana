import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BriefValue, Estimate, FieldProblem, MusicChoice, RunDraft, TemplateDetail, Upload } from "../../../../src/app/types.js";
import { ApproveDialog } from "../ApproveDialog.js";
import { ApiError, app } from "../api.js";
import { fmtSeconds, fmtTime, indexAt, useMediaTime } from "../beat.js";
import { templateLength } from "../copy.js";
import { BriefForm, initialBrief, missingRequired, NoteField, PlanFirstField, PromptPreview, TrackField } from "../BriefForm.js";
import { CutMap } from "../CutMap.js";
import { useReducedMotion } from "../flash.js";
import { useFaceStyle } from "../fontsDisplay.js";
import { PhotoDrop, takeStashedPhoto } from "../PhotoDrop.js";
import { MakeButton, type MakeReason, minGpuCap, Receipt, unacknowledged } from "../Receipt.js";
import { Link, navigate, useRoute } from "../router.js";
import { refreshSetup, useApp } from "../Shell.js";
import { cutMapLabel, KIND_LABEL, TemplateTitle, TypeCard } from "../TemplateTile.js";
import { Icon, Step, toast, useAnnounce } from "../ui.js";

/**
 * The template page (spec §4.3): the example (or its typographic card) with a Cut Map scrubber and
 * what's in it on the left; on the right the make rail: 1 your photo, 2 make it yours, 3 budget, and
 * MAKE MY EDIT. The receipt re-estimates only when the job count or track changes, never on words.
 */

interface PhotoItem {
  key: string;
  name: string;
  pct: number;
  preview?: string;
  abort?: () => void;
  upload?: Upload;
}

interface MusicState {
  upload?: Upload;
  uploading?: { name: string; pct: number; abort(): void };
  error?: string;
}

const uid = () => Math.random().toString(36).slice(2);

/** A photo or track carried over from another project ("<projectId>:<assetId>"), shown like an upload. */
function refUpload(ref: string, kind: "image" | "audio"): Upload {
  const [project, asset] = ref.split(":") as [string, string];
  return {
    id: ref,
    purpose: kind === "image" ? "photo" : "music",
    name: kind === "image" ? asset : "Your track",
    kind,
    bytes: 0,
    url: kind === "image" ? app.thumbUrl(project, asset, 0, 320) : "",
    hash: "",
    checks: [],
    createdAt: new Date().toISOString(),
  };
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function TemplatePage({ slug }: { slug: string }) {
  const { query } = useRoute();
  const again = query.get("again");
  const { setup, info, settings } = useApp();
  const reduced = useReducedMotion();
  const [t, setT] = useState<TemplateDetail>();
  const [loadError, setLoadError] = useState<ApiError>();

  // draft
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [photoErrors, setPhotoErrors] = useState<{ name: string; message: string }[]>([]);
  const [consent, setConsent] = useState(false);
  const [music, setMusic] = useState<MusicState>({});
  const [musicChoice, setMusicChoice] = useState<MusicChoice>("mine");
  const [alignDrop, setAlignDrop] = useState(true);
  const [brief, setBrief] = useState<Record<string, BriefValue>>({});
  const [note, setNote] = useState("");
  const [planFirst, setPlanFirst] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [clipsModel, setClipsModel] = useState<"configured" | "wan22">("configured");
  const [capsEdited, setCapsEdited] = useState<{ gpuMinutes: number; claudeUsd: number }>();

  // estimate
  const [estimate, setEstimate] = useState<Estimate>();
  const [prompt, setPrompt] = useState<string>();
  const [estimating, setEstimating] = useState(false);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const estimatedFor = useRef<string>();
  const [previewOpen, setPreviewOpen] = useState(false);

  const [approve, setApprove] = useState(false);
  const [starting, setStarting] = useState(false);
  const [announcement, announce] = useAnnounce();

  // ---------- load ----------
  useEffect(() => {
    let live = true;
    setT(undefined);
    setLoadError(undefined);
    app.template(slug).then(
      (d) => {
        if (!live) return;
        setT(d);
        setBrief(initialBrief(d.brief));
        setMusicChoice(d.soundtrack ? "template" : "mine");
        document.title = `${d.title} · open-katana`;
      },
      (e: ApiError) => live && setLoadError(e),
    );
    return () => {
      live = false;
    };
  }, [slug]);

  // A photo dropped on Home comes along.
  useEffect(() => {
    const f = takeStashedPhoto();
    if (f) addPhotos([f]);
  }, []);

  // Make another: the same photos, track and words as an earlier edit.
  useEffect(() => {
    if (!again || !t) return;
    let live = true;
    app.page(again).then(
      async (page) => {
        const d = page.draft;
        if (!live || !d) return;
        if (Object.keys(d.brief).length) setBrief({ ...initialBrief(t.brief), ...d.brief });
        setNote(d.note ?? "");
        setPlanFirst(d.planFirst);
        setCommercial(d.commercial);
        setClipsModel(d.clipsModel);
        setAlignDrop(d.alignDrop);
        setMusicChoice(d.musicChoice === "template" && !t.soundtrack ? "mine" : d.musicChoice);
        const photos = await Promise.all(d.photos.map((p) => (p.includes(":") ? Promise.resolve(refUpload(p, "image")) : app.getUpload(p).catch(() => undefined))));
        if (!live) return;
        setItems(photos.filter((u): u is Upload => Boolean(u)).map((u) => ({ key: uid(), name: u.name, pct: 100, upload: u })));
        if (d.music) {
          const m = d.music.includes(":") ? refUpload(d.music, "audio") : await app.getUpload(d.music).catch(() => undefined);
          if (live && m) setMusic({ upload: m });
        }
      },
      () => toast("The earlier edit's photos couldn't be loaded. Add them again.", { error: true }),
    );
    return () => {
      live = false;
    };
  }, [again, t?.slug]);

  // ---------- uploads ----------
  const addPhotos = (files: File[]) => {
    setPhotoErrors([]);
    for (const f of files) {
      const key = uid();
      const preview = URL.createObjectURL(f);
      const task = app.upload(f, "photo", (frac) => setItems((list) => list.map((i) => (i.key === key ? { ...i, pct: frac * 100 } : i))));
      setItems((list) => [...list, { key, name: f.name, pct: 0, preview, abort: task.abort }]);
      task.promise.then(
        (u) => setItems((list) => list.map((i) => (i.key === key ? { ...i, pct: 100, upload: { ...u, url: preview } } : i))),
        (e: ApiError) => {
          URL.revokeObjectURL(preview);
          setItems((list) => list.filter((i) => i.key !== key));
          if (e.code !== "ABORTED") setPhotoErrors((errs) => [...errs, { name: f.name, message: e.message }]);
        },
      );
    }
  };
  const removePhoto = (id: string) => {
    const item = items.find((i) => i.upload?.id === id);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    setItems((list) => list.filter((i) => i.upload?.id !== id));
    if (!id.includes(":")) void app.deleteUpload(id).catch(() => undefined);
  };
  const reorder = (ids: string[]) => setItems((list) => [...ids.map((id) => list.find((i) => i.upload?.id === id)!).filter(Boolean), ...list.filter((i) => !i.upload)]);

  const addMusic = (f: File) => {
    music.uploading?.abort();
    const task = app.upload(f, "music", (frac) => setMusic((m) => (m.uploading ? { ...m, uploading: { ...m.uploading, pct: frac * 100 } } : m)));
    setMusic({ uploading: { name: f.name, pct: 0, abort: task.abort } });
    task.promise.then(
      (u) => setMusic({ upload: { ...u, url: u.url || URL.createObjectURL(f) } }),
      (e: ApiError) => setMusic(e.code === "ABORTED" ? {} : { error: e.message }),
    );
  };
  const addMusicLink = (url: string) => {
    music.uploading?.abort();
    // pct -1: fetching, no byte progress.
    // A fetch can't be cancelled mid-way; a later choice simply wins.
    let current = true;
    setMusic({ uploading: { name: "Instagram sound", pct: -1, abort: () => (current = false) } });
    app.importLink(url, "music").then(
      (u) => current && setMusic({ upload: { ...u, url: u.url || app.uploadMedia(u.id) } }),
      (e: ApiError) => current && setMusic({ error: e.message }),
    );
  };
  const removeMusic = () => {
    const id = music.upload?.id;
    setMusic({});
    if (id && !id.includes(":")) void app.deleteUpload(id).catch(() => undefined);
  };

  useEffect(
    () => () => {
      for (const i of items) i.abort?.();
    },
    [],
  );

  const photos = items.filter((i) => i.upload).map((i) => i.upload!);
  const uploading = items.filter((i) => !i.upload).map((i) => ({ name: i.name, pct: i.pct, preview: i.preview }));

  // ---------- draft & estimate ----------
  const draft: RunDraft = useMemo(
    () => ({
      kind: "template",
      template: slug,
      photos: photos.map((p) => p.id),
      ...(musicChoice === "mine" && music.upload ? { music: music.upload.id } : {}),
      musicChoice,
      alignDrop,
      mode: "remix",
      brief,
      ...(note.trim() ? { note: note.trim() } : {}),
      planFirst,
      commercial,
      clipsModel,
    }),
    [slug, photos.map((p) => p.id).join(","), musicChoice, music.upload?.id, alignDrop, brief, note, planFirst, commercial, clipsModel],
  );
  const draftKey = JSON.stringify(draft);
  // Only inputs that change the job count, the track or the models re-estimate (never words).
  const jobsKey = JSON.stringify([draft.photos, draft.music, musicChoice, alignDrop, commercial, clipsModel]);

  const runEstimate = async (d: RunDraft, quiet: boolean): Promise<Estimate | undefined> => {
    if (!d.photos.length) return undefined;
    if (!quiet) setEstimating(true);
    try {
      const r = await app.estimate(d);
      setEstimate(r.estimate);
      setPrompt(r.prompt);
      setProblems([]);
      estimatedFor.current = JSON.stringify(d);
      return r.estimate;
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && Array.isArray(e.body.problems)) {
        const ps = e.body.problems as FieldProblem[];
        // A missing track is shown by the button; keep the default numbers meanwhile.
        if (ps.some((p) => p.field !== "music")) setProblems(ps.filter((p) => p.field !== "music"));
      } else if (!quiet) toast(`The cost couldn't be worked out: ${errorMessage(e)}`, { error: true });
      return undefined;
    } finally {
      if (!quiet) setEstimating(false);
    }
  };

  useEffect(() => {
    if (!t || !draft.photos.length) return;
    const timer = setTimeout(() => void runEstimate(draft, false), 300);
    return () => clearTimeout(timer);
  }, [jobsKey, t?.slug]);

  // The prompt preview follows the words while it is open.
  useEffect(() => {
    if (!previewOpen || !t || !draft.photos.length || estimatedFor.current === draftKey) return;
    const timer = setTimeout(() => void runEstimate(draft, true), 450);
    return () => clearTimeout(timer);
  }, [previewOpen, draftKey]);

  const shown = estimate ?? t?.estimate;
  const caps = useMemo(() => {
    if (!shown) return { gpuMinutes: 50, claudeUsd: settings?.defaultClaudeCapUsd ?? 15 };
    const min = minGpuCap(shown);
    if (capsEdited) return { gpuMinutes: Math.max(min, capsEdited.gpuMinutes), claudeUsd: Math.max(5, capsEdited.claudeUsd) };
    return { gpuMinutes: Math.max(min, shown.gpu.suggestedCapMin), claudeUsd: shown.claude.suggestedCapUsd };
  }, [shown, capsEdited, settings?.defaultClaudeCapUsd]);

  // ---------- focus the brief once the first photo is in ----------
  const hadPhotos = useRef(false);
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (photos.length && !hadPhotos.current && t) {
      hadPhotos.current = true;
      requestAnimationFrame(() => {
        const first = rail.current?.querySelector<HTMLElement>("#step-brief [data-first]");
        first?.focus();
        const label = t.brief[0]?.label;
        announce(label ? `Photo added. Make it yours: ${label}` : "Photo added.");
      });
    }
    if (!photos.length) hadPhotos.current = false;
  }, [photos.length, t?.slug]);

  // ---------- why the button can't be pressed ----------
  const trackRequired = Boolean(t && t.inputs.music === "required" && !t.soundtrack);
  const needTrack = musicChoice === "mine" && (trackRequired || Boolean(t?.soundtrack));
  const missing = t ? missingRequired(t.brief, brief) : undefined;
  const reason: (MakeReason & { focus?: string }) | undefined = (() => {
    if (!t) return { text: "Loading the template…" };
    if (!items.length) return { text: "Add a photo to start", focus: "#step-photo button" };
    if (uploading.length) return { text: `Uploading photo… ${Math.round(uploading.reduce((s, u) => s + u.pct, 0) / uploading.length)}%` };
    if (photos.length < t.inputs.images.min)
      return { text: `Add ${t.inputs.images.min - photos.length} more photo${t.inputs.images.min - photos.length > 1 ? "s" : ""} to start`, focus: "#step-photo button" };
    if (!consent) return { text: "Tick the permission line to start", focus: "#step-photo .consent input" };
    if (needTrack && !music.upload)
      return music.uploading ? { text: `Uploading track… ${Math.round(music.uploading.pct)}%` } : { text: "Add your track to start", focus: ".kt-track button" };
    if (missing) return { text: `Fill in: ${missing.label}`, focus: `#brief-${missing.id}-0, [name="brief-${missing.id}"]` };
    if (setup) {
      if (setup.ffmpeg.state !== "ok") return { text: "Install ffmpeg to make edits", link: { href: "/setup#ffmpeg", label: "How" } };
      if (setup.gpu.state !== "ok") return { text: "Connect a GPU to make edits", link: { href: "/setup", label: "Set up" } };
      if (setup.claude.state === "missing") return { text: "Install Claude Code to make edits", link: { href: "/setup", label: "How" } };
      if (setup.claude.state === "too-old") return { text: "Update Claude Code to make edits", link: { href: "/setup", label: "How" } };
      if (setup.claude.state !== "ok") return { text: "Sign in to Claude Code", link: { href: "/setup", label: "How" } };
    }
    if (!estimate) return { text: estimating ? "Working out the cost…" : "Working out the cost" };
    return undefined;
  })();
  const blockers = estimate?.blockers.filter((b) => b.code === "MODELS_MISSING");
  // The phone bar has room for one line: the reason, or the models fix.
  const barReason = reason?.text ?? (blockers?.length ? "Missing models for this template" : undefined);

  const focusMissing = () => {
    if (!reason?.focus) return;
    const el = rail.current?.querySelector<HTMLElement>(reason.focus) ?? document.querySelector<HTMLElement>(reason.focus);
    el?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    el?.focus({ preventScroll: true });
  };

  // ---------- start ----------
  const sameNumbers = (a: Estimate, b: Estimate) =>
    a.gpu.lowMin === b.gpu.lowMin &&
    a.gpu.highMin === b.gpu.highMin &&
    a.claude.lowUsd === b.claude.lowUsd &&
    a.claude.highUsd === b.claude.highUsd &&
    a.licences.map((l) => l.profile).join() === b.licences.map((l) => l.profile).join();

  const start = async () => {
    if (!estimate || starting) return;
    setStarting(true);
    try {
      let est = estimate;
      if (estimatedFor.current !== draftKey) {
        // Words changed since the receipt was worked out: refresh its key without showing a reload.
        const fresh = await runEstimate(draft, true);
        if (!fresh) return;
        if (!sameNumbers(est, fresh)) {
          setApprove(false);
          toast("The cost changed. Check the new numbers, then press Make my edit again.");
          return;
        }
        est = fresh;
      }
      const licencesShown = est.licences.filter((l) => l.commercial !== "yes").map((l) => l.profile);
      const res = await app.startRun({ ...draft, approval: { estimateKey: est.key, gpuCapMinutes: caps.gpuMinutes, claudeCapUsd: caps.claudeUsd, licencesShown }, consent: true });
      setApprove(false);
      navigate(`/p/${encodeURIComponent(res.project)}`);
    } catch (e) {
      setApprove(false);
      if (!(e instanceof ApiError)) return toast(errorMessage(e), { error: true });
      if (e.code === "ESTIMATE_CHANGED" && e.body.estimate) {
        setEstimate(e.body.estimate as Estimate);
        estimatedFor.current = undefined;
        toast("The cost changed. Check the new numbers, then press Make my edit again.");
      } else if (e.code === "SETUP") {
        await refreshSetup(true);
        toast("Finish setup first. Your photos and words are kept.", { error: true });
      } else if (e.status === 422 && Array.isArray(e.body.problems)) {
        setProblems(e.body.problems as FieldProblem[]);
        toast("Some words need a fix.", { error: true });
      } else if (e.code === "NOT_OWNER") {
        toast(
          `This window isn't the open-katana app that makes edits${typeof e.body.port === "number" ? ` (that one is on port ${e.body.port})` : ""}. Open it with "open-katana app".`,
          { error: true },
        );
      } else toast(e.message, { error: true });
    } finally {
      setStarting(false);
    }
  };
  const make = () => {
    if (!estimate) return;
    if (unacknowledged(estimate).length) setApprove(true);
    else void start();
  };

  // ---------- render ----------
  if (loadError)
    return (
      <main id="content" class="kt-page kt-narrow">
        <h1 class="kt-title">{loadError.status === 404 ? "No such template" : "The template didn't load"}</h1>
        <p class="kt-ash">{loadError.status === 404 ? `There's no template called “${slug}”.` : loadError.message}</p>
        <Link class="btn" href="/">
          <Icon name="back" size={14} />
          Templates
        </Link>
      </main>
    );
  if (!t)
    return (
      <main id="content" class="kt-page kt-template" aria-busy="true">
        <div class="kt-tpl-left">
          <div class="kt-stage kt-grain" />
        </div>
        <div class="kt-rail" />
      </main>
    );

  const freestyle = t.kind === "freestyle";
  const stats = [
    t.format.aspect,
    fmtSeconds(templateLength(t)),
    t.stats.bpm ? `${Math.round(t.stats.bpm)} BPM` : undefined,
    t.stats.shots ? `${t.stats.shots} shots` : undefined,
    t.stats.texts ? `${t.stats.texts} words` : undefined,
  ].filter(Boolean);
  const usual = t.estimate;
  const step1Done = photos.length >= t.inputs.images.min && consent && !uploading.length;
  const open = photos.length > 0;

  return (
    <main id="content" class="kt-page kt-template">
      {/* The rail comes first in the DOM so the keyboard reaches the photo first; CSS puts it on the right. */}
      <div class="kt-rail" ref={rail}>
        <header class="kt-rail-head">
          <h1 class="kt-rail-title kt-slam">
            <TemplateTitle t={t} maxPx={72} maxLines={2} />
          </h1>
          <Description text={t.description} />
          <p class="kt-rail-stats mono">{stats.join(" · ")}</p>
          <div class="kt-rail-chips">
            <span class="kt-badge">{KIND_LABEL[t.kind]}</span>
            {t.flashing && (
              <span class="kt-flashing">
                <Icon name="bolt" size={12} />
                Contains flashing
              </span>
            )}
            {t.source === "user" && <span class="kt-badge yours">Yours</span>}
          </div>
          {freestyle && <p class="kt-help">Freestyle: the director writes the shot list from this recipe each time.</p>}
          {usual.warnings.some((w) => w.code === "ESTIMATE_UNAVAILABLE") ? (
            <p class="kt-rail-usual">{usual.warnings.find((w) => w.code === "ESTIMATE_UNAVAILABLE")!.message}</p>
          ) : (
            <p class="kt-rail-usual">
              Usually{" "}
              <span class="mono">
                {Math.round(usual.gpu.lowMin)}–{Math.round(usual.gpu.highMin)}
              </span>{" "}
              GPU min · Claude ≈{" "}
              <span class="mono">
                ${Math.round(usual.claude.lowUsd)}–{Math.round(usual.claude.highUsd)}
              </span>
            </p>
          )}
        </header>

        <Step n={1} title="Your photo" state={step1Done ? "done" : "open"} id="step-photo">
          <PhotoDrop
            min={t.inputs.images.min}
            max={t.inputs.images.max}
            title={t.inputs.images.title}
            photos={photos}
            uploading={uploading}
            heic={Boolean(info?.features.includes("heic"))}
            consent={consent}
            onAdd={addPhotos}
            onRemove={removePhoto}
            onReorder={reorder}
            onConsent={setConsent}
            errors={photoErrors}
          />
        </Step>

        <Step n={2} title="Make it yours" state={open ? "open" : "dim"} id="step-brief">
          <BriefForm fields={t.brief} words={t.words} values={brief} problems={problems} onChange={(id, v) => setBrief((b) => ({ ...b, [id]: v }))} display={t.titleStyle} />
          <TrackField
            soundtrack={t.soundtrack}
            choice={musicChoice}
            onChoice={setMusicChoice}
            music={music.upload}
            uploading={music.uploading}
            error={music.error}
            fit={estimate?.track}
            alignDrop={alignDrop}
            onAlignDrop={setAlignDrop}
            onFile={addMusic}
            onLink={addMusicLink}
            onRemove={removeMusic}
          />
          <NoteField value={note} max={t.inputs.instructionsMaxChars} onChange={setNote} />
          <PlanFirstField value={planFirst} onChange={setPlanFirst} />
          <PromptPreview prompt={prompt} onToggle={setPreviewOpen} />
        </Step>

        <Step n={3} title="Budget" state={open ? "open" : "dim"} id="step-budget">
          <Receipt
            estimate={estimate}
            loading={estimating}
            caps={caps}
            commercial={commercial}
            clipsModel={clipsModel}
            onCaps={setCapsEdited}
            onCommercial={setCommercial}
            onClipsModel={setClipsModel}
          />
        </Step>

        <div class="kt-rail-make">
          <MakeButton caps={caps} reason={reason} blockers={blockers} busy={starting} onMake={make} onBlocked={focusMissing} />
        </div>
      </div>

      <TemplateMedia t={t} />

      <div class="kt-sticky-make">
        {barReason ? (
          <p class="kt-sticky-why">
            {barReason}
            {!reason && (
              <>
                {" · "}
                <Link href="/setup">See what's missing</Link>
              </>
            )}
          </p>
        ) : (
          <button type="button" class="kt-sticky-sum" onClick={() => document.getElementById("step-budget")?.scrollIntoView({ block: "start" })}>
            <span class="mono">~{shown ? Math.round((shown.wall.lowMin + shown.wall.highMin) / 2) : "—"} min</span>
            <span aria-hidden="true"> · </span>
            <span class="mono">≤ {caps.gpuMinutes} GPU min</span>
            <Icon name="info" size={14} label="See the budget" />
          </button>
        )}
        <button
          type="button"
          class="btn cta"
          aria-disabled={Boolean(barReason) || starting || undefined}
          aria-describedby="make-why"
          onClick={() => (barReason ? focusMissing() : make())}
        >
          {starting ? "Starting…" : "Make my edit"}
        </button>
      </div>

      {estimate && <ApproveDialog open={approve} estimate={estimate} caps={caps} busy={starting} onClose={() => setApprove(false)} onConfirm={() => void start()} />}
      <span class="kt-sr" role="status" aria-live="polite">
        {announcement}
      </span>
    </main>
  );
}

function Description({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 160;
  return (
    <div class="kt-rail-desc">
      <p class={long && !more ? "clamped" : undefined}>{text}</p>
      {long && (
        <button type="button" class="kt-link" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

// ---------- the left column ----------

function TemplateMedia({ t }: { t: TemplateDetail }) {
  const reduced = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [scrub, setScrub] = useState<number>();
  const [hotSlot, setHotSlot] = useState<string>();
  const [hotWord, setHotWord] = useState<number>();
  const time = useMediaTime(video);
  const example = t.media.example;
  const dur = templateLength(t);

  useEffect(() => {
    const v = video.current;
    if (!v || reduced) return;
    void v.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  }, [example, reduced]);

  const seek = (s: number) => {
    const v = video.current;
    if (v) v.currentTime = s;
    else setScrub(s);
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().then(() => setPlaying(true));
    else {
      v.pause();
      setPlaying(false);
    }
  };

  // Without an example, scrubbing the map shows the word on screen at that moment on the card.
  const at = example ? time : scrub;
  const wordIndex = hotWord ?? (at !== undefined ? t.words.find((w) => at >= w.startSec && at < w.endSec)?.index : undefined);
  const word = wordIndex !== undefined ? t.words.find((w) => w.index === wordIndex) : undefined;
  const slots = t.slots.filter((s) => s.uses > 0 && !/[-_]matte$/.test(s.id));
  const hot = hotSlot ? t.slots.find((s) => s.id === hotSlot) : undefined;
  const shotIndex = at !== undefined ? indexAt(t.cutMap.shots, at) : -1;
  const part = at !== undefined && t.cutMap.sketch ? t.cutMap.sketch[indexAt(t.cutMap.sketch, at)] : undefined;

  return (
    <div class="kt-tpl-left">
      <section class="kt-stage kt-grain" aria-label={example ? "Example edit" : "Template card"}>
        <div class="kt-stage-box" style={{ "--ar": String(t.format.aspectValue) }}>
          {example ? (
            <div class="kt-media" style={{ aspectRatio: String(t.format.aspectValue) }}>
              {t.media.poster && <img class="kt-media-poster" src={t.media.poster} alt="" />}
              <video ref={video} src={example} poster={t.media.poster} muted={muted} loop playsInline preload="auto" aria-label={`${t.title} example`} />
            </div>
          ) : (
            <div class="kt-media" style={{ aspectRatio: String(t.format.aspectValue) }}>
              <TypeCard t={t} big />
              {word && <StageWord word={word} />}
            </div>
          )}
        </div>
      </section>

      {example && (
        <div class="kt-player">
          <button type="button" class="btn icon-btn" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
            <Icon name={playing ? "pause" : "play"} size={14} />
          </button>
          <span class="mono kt-player-time">
            {fmtTime(time ?? 0)} / {fmtTime(dur)}
          </span>
          <button type="button" class="btn ghost icon-btn" aria-label={muted ? "Sound on" : "Sound off"} aria-pressed={!muted} onClick={() => setMuted(!muted)}>
            <Icon name={muted ? "mute" : "sound"} size={15} />
          </button>
        </div>
      )}

      <div class="kt-tpl-map">
        <CutMap
          data={t.cutMap}
          height={36}
          label={`${t.title}: ${cutMapLabel(t)}`}
          currentTime={at}
          highlightSlot={hotSlot}
          onSeek={seek}
          onScrub={example ? undefined : setScrub}
        />
        <p class="kt-map-caption" aria-hidden="true">
          {hot ? (
            <span class="kt-map-hot">
              {hot.id} <span class="mono">×{hot.uses}</span>
            </span>
          ) : at !== undefined ? (
            <span class="mono">
              {fmtTime(at)}
              {shotIndex >= 0 && t.cutMap.shots.length ? ` · shot ${shotIndex + 1} of ${t.cutMap.shots.length}` : part ? ` · ${part.label}` : ""}
            </span>
          ) : (
            <span>{example ? "" : t.words.length ? "Hover the map to see the words land." : "Hover the map to walk through the recipe."}</span>
          )}
        </p>
      </div>

      {t.media.example && t.credit && <p class="kt-credit">{t.credit}</p>}

      {t.kind === "freestyle" ? (
        <section class="kt-list-block" aria-labelledby="shape-h">
          <h2 class="label" id="shape-h">
            The shape of it
          </h2>
          <ol class="kt-shape">
            {t.structure.map((s) => (
              <li key={s.at}>
                <span class="kt-shape-at mono">{s.at}</span>
                <span class="kt-shape-role">{s.role}</span>
                <span class="kt-shape-text">{s.guidance}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <div class="kt-lists">
          <section class="kt-list-block" aria-labelledby="slots-h">
            <h2 class="label" id="slots-h">
              Shots you star in <span class="mono">({slots.length})</span>
            </h2>
            <ul class="kt-slots">
              {slots.map((s) => (
                <li
                  key={s.id}
                  tabIndex={0}
                  class={hotSlot === s.id ? "hot" : undefined}
                  onMouseEnter={() => setHotSlot(s.id)}
                  onMouseLeave={() => setHotSlot(undefined)}
                  onFocus={() => setHotSlot(s.id)}
                  onBlur={() => setHotSlot(undefined)}
                >
                  <span class="kt-slot-id">{s.id}</span>
                  <span class="kt-slot-desc">{s.description}</span>
                  <span class="kt-slot-uses mono" aria-label={`used ${s.uses} times`}>
                    ×{s.uses}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section class="kt-list-block" aria-labelledby="words-h">
            <h2 class="label" id="words-h">
              Words on screen <span class="mono">({t.words.length})</span>
            </h2>
            <ul class="kt-words">
              {t.words.map((w) => (
                <WordRow
                  key={w.index}
                  w={w}
                  hot={wordIndex === w.index}
                  onHot={(on) => {
                    setHotWord(on ? w.index : undefined);
                    if (on && example) seek(w.startSec + 0.05);
                  }}
                />
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function WordRow({ w, hot, onHot }: { w: TemplateDetail["words"][number]; hot: boolean; onHot(on: boolean): void }) {
  const style = useFaceStyle({ font: w.font, weight: w.weight, italic: w.italic }, w.uppercase ? "upper" : "as-typed");
  return (
    <li tabIndex={0} class={hot ? "hot" : undefined} onMouseEnter={() => onHot(true)} onMouseLeave={() => onHot(false)} onFocus={() => onHot(true)} onBlur={() => onHot(false)}>
      <span class="mono kt-word-time">{fmtTime(w.startSec)}</span>
      <span class="kt-word-text" style={style}>
        {w.text}
      </span>
    </li>
  );
}

/** The word on screen at the scrub time, set over the typographic card in its card's face. */
function StageWord({ word }: { word: TemplateDetail["words"][number] }) {
  const style = useFaceStyle({ font: word.font, weight: word.weight, italic: word.italic }, word.uppercase ? "upper" : "as-typed");
  return (
    <div class="kt-stage-word" aria-hidden="true">
      <span style={style}>{word.text}</span>
    </div>
  );
}
