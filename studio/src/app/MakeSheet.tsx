import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BriefField, BriefValue, DecodeState, Estimate, FieldProblem, RunDraft, StartRun, Upload } from "../../../src/app/types.js";
import { ApiError, app, type UploadTask } from "./api.js";
import { ApproveDialog } from "./ApproveDialog.js";
import { BriefForm } from "./BriefForm.js";
import { fmtUsd } from "./beat.js";
import { PhotoDrop } from "./PhotoDrop.js";
import { Receipt } from "./Receipt.js";
import { Link, navigate } from "./router.js";
import { Button, Sheet, Step, toast } from "./ui.js";

/**
 * Put me in this edit (spec §4.7): the make sheet over a decoded edit. The same three steps as the
 * template rail (photo and consent, make it yours, budget) plus Remix / Shot for shot and the sound
 * choice. The receipt's numbers come from `POST /api/runs/estimate`; **Make my edit** is the approval.
 */
export interface MakeSheetProps {
  open: boolean;
  project: string;
  decode: DecodeState;
  /** The decoded-edit brief (your words, the place) from the project page. */
  fields: BriefField[];
  onClose(): void;
}

interface Pending {
  key: number;
  name: string;
  pct: number;
  task: UploadTask;
}

const MAX_PHOTOS = 5;
const NOTE_MAX = 2000;
let uploadKey = 0;

/** Starting values: each field's default only (a decoded edit's placeholders are hints, not words). */
const startValues = (fields: BriefField[]): Record<string, BriefValue> =>
  Object.fromEntries(fields.flatMap((f) => (f.default !== undefined ? [[f.id, f.default]] : f.kind === "words" ? [[f.id, []]] : f.kind === "toggle" ? [[f.id, false]] : [])));

const filled = (v: BriefValue | undefined) => (Array.isArray(v) ? v.some((x) => x.trim()) : typeof v === "string" ? v.trim().length > 0 : v !== undefined);

export function MakeSheet({ open, project, decode, fields, onClose }: MakeSheetProps) {
  const hasAudio = decode.format?.hasAudio ?? false;
  const durationSec = decode.format?.durationSec ?? decode.cutMap?.durationSec ?? 0;
  const [photos, setPhotos] = useState<Upload[]>([]);
  const [uploading, setUploading] = useState<Pending[]>([]);
  const [consent, setConsent] = useState(false);
  const [values, setValues] = useState<Record<string, BriefValue>>(() => startValues(fields));
  const [mode, setMode] = useState<RunDraft["mode"]>("remix");
  const [sound, setSound] = useState<"original" | "mine">(hasAudio ? "original" : "mine");
  const [music, setMusic] = useState<Upload>();
  const [musicUpload, setMusicUpload] = useState<Pending>();
  const [alignDrop, setAlignDrop] = useState(true);
  const [note, setNote] = useState("");
  const [planFirst, setPlanFirst] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [clipsModel, setClipsModel] = useState<RunDraft["clipsModel"]>("configured");
  const [caps, setCaps] = useState<{ gpuMinutes: number; claudeUsd: number }>();
  const [estimate, setEstimate] = useState<Estimate>();
  const [prompt, setPrompt] = useState("");
  const [estimating, setEstimating] = useState(false);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [heic, setHeic] = useState(false);
  const [approve, setApprove] = useState(false);
  const [starting, setStarting] = useState(false);
  const capsTouched = useRef(false);
  const estimatedFor = useRef("");
  const trackInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    app.info().then((i) => setHeic(i.features.includes("heic")), () => undefined);
  }, []);
  // Fields arrive with the project page; reset the values only when the set of fields changes.
  const fieldsKey = fields.map((f) => f.id).join(",");
  useEffect(() => setValues(startValues(fields)), [fieldsKey]);
  useEffect(() => {
    if (!hasAudio) setSound("mine");
  }, [hasAudio]);

  const draft: RunDraft = {
    kind: "decode",
    project,
    photos: photos.map((p) => p.id),
    music: sound === "mine" ? music?.id : undefined,
    musicChoice: sound,
    alignDrop,
    mode,
    brief: values,
    note: note.trim() || undefined,
    planFirst,
    commercial,
    clipsModel,
  };
  // Only inputs that change the job count or the track re-estimate (words never do, spec §3.2 T5).
  const jobsKey = JSON.stringify([draft.photos, draft.music, sound, alignDrop, mode, planFirst, commercial, clipsModel]);
  const wordsKey = JSON.stringify([values, draft.note]);

  const runEstimate = async (d: RunDraft) => {
    const r = await app.estimate(d);
    estimatedFor.current = JSON.stringify([d.brief, d.note]);
    setEstimate(r.estimate);
    setPrompt(r.prompt);
    setProblems([]);
    if (!capsTouched.current) setCaps({ gpuMinutes: r.estimate.gpu.suggestedCapMin, claudeUsd: r.estimate.claude.suggestedCapUsd });
    return r.estimate;
  };

  useEffect(() => {
    if (!photos.length) return;
    setEstimating(true);
    const t = setTimeout(() => {
      runEstimate(draft)
        .catch((e: ApiError) => {
          const p = e.body?.problems;
          if (Array.isArray(p)) setProblems(p as FieldProblem[]);
          else toast(e.message, { error: true });
        })
        .finally(() => setEstimating(false));
    }, 300);
    return () => clearTimeout(t);
  }, [jobsKey, photos.length > 0]);

  // ---------- uploads ----------

  const addPhotos = (files: File[]) => {
    const room = MAX_PHOTOS - photos.length - uploading.length;
    if (files.length > room) toast(`Up to ${MAX_PHOTOS} photos. The first ${Math.max(0, room)} were added.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = ++uploadKey;
      const task = app.upload(file, "photo", (f) => setUploading((u) => u.map((x) => (x.key === key ? { ...x, pct: Math.round(f * 100) } : x))));
      setUploading((u) => [...u, { key, name: file.name, pct: 0, task }]);
      task.promise
        .then((up) => setPhotos((p) => [...p, up]))
        .catch((e: ApiError) => e.code !== "ABORTED" && toast(e.message, { error: true }))
        .finally(() => setUploading((u) => u.filter((x) => x.key !== key)));
    }
  };
  const removePhoto = (id: string) => {
    setPhotos((p) => p.filter((x) => x.id !== id));
    void app.deleteUpload(id).catch(() => undefined);
  };
  const reorder = (ids: string[]) => setPhotos((p) => ids.map((id) => p.find((x) => x.id === id)).filter((x): x is Upload => Boolean(x)));

  const addTrack = (file: File) => {
    musicUpload?.task.abort();
    const key = ++uploadKey;
    const task = app.upload(file, "music", (f) => setMusicUpload((m) => (m && m.key === key ? { ...m, pct: Math.round(f * 100) } : m)));
    setMusicUpload({ key, name: file.name, pct: 0, task });
    task.promise
      .then((up) => {
        if (music) void app.deleteUpload(music.id).catch(() => undefined);
        setMusic(up);
      })
      .catch((e: ApiError) => e.code !== "ABORTED" && toast(e.message, { error: true }))
      .finally(() => setMusicUpload((m) => (m?.key === key ? undefined : m)));
  };

  // ---------- the button ----------

  const blocker = estimate?.blockers[0];
  const required = fields.find((f) => f.required && !filled(values[f.id]));
  const reason = useMemo((): ComponentChildren | undefined => {
    if (!photos.length && !uploading.length) return "Add a photo to start";
    if (uploading.length) return `Uploading photo… ${Math.round(uploading.reduce((s, u) => s + u.pct, 0) / uploading.length)}%`;
    if (!consent) return "Tick the permission line to start";
    if (sound === "mine" && musicUpload) return `Uploading track… ${musicUpload.pct}%`;
    if (sound === "mine" && !music) return "Add your track to start";
    if (required) return `Fill in: ${required.label}`;
    if (blocker) {
      if (blocker.code.startsWith("GPU")) return <>Connect a GPU to make edits · <Link href="/setup">Set up</Link></>;
      if (blocker.code.startsWith("CLAUDE")) return <>Sign in to Claude Code · <Link href="/setup">How</Link></>;
      if (blocker.code === "MODELS_MISSING") return <>Missing models for this edit · <Link href="/setup">See what's missing</Link></>;
      return blocker.message;
    }
    return undefined;
  }, [photos.length, uploading, consent, sound, music, musicUpload, required, blocker]);
  const ready = !reason && Boolean(estimate) && Boolean(caps) && !starting;
  const unacknowledged = (estimate?.licences ?? []).filter((l) => !l.acknowledged && l.commercial !== "yes");

  const start = async (afterApprove = false) => {
    if (!estimate || !caps) return;
    if (unacknowledged.length && !afterApprove) {
      setApprove(true);
      return;
    }
    setStarting(true);
    try {
      // Words and the note don't re-estimate as they're typed; the key covers them, so refresh it once here.
      const current = estimatedFor.current === wordsKey ? estimate : await runEstimate(draft);
      const req: StartRun = {
        ...draft,
        approval: { estimateKey: current.key, gpuCapMinutes: caps.gpuMinutes, claudeCapUsd: caps.claudeUsd, licencesShown: current.licences.filter((l) => l.commercial !== "yes").map((l) => l.profile) },
        consent: true,
      };
      const r = await app.startRun(req);
      setApprove(false);
      onClose();
      navigate(`/p/${encodeURIComponent(r.project)}`);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "ESTIMATE_CHANGED" && err.body.estimate) {
        const fresh = err.body.estimate as Estimate;
        setEstimate(fresh);
        if (!capsTouched.current) setCaps({ gpuMinutes: fresh.gpu.suggestedCapMin, claudeUsd: fresh.claude.suggestedCapUsd });
        toast("The budget changed. Check it, then press Make my edit again.");
      } else if (err.code === "BUSY") {
        toast(err.message, { action: { label: "Make another", onClick: () => void makeAnother(project) } });
      } else if (err.code === "SETUP") {
        const setup = err.body.setup as { blockers?: { message: string }[] } | undefined;
        toast(setup?.blockers?.[0]?.message ?? err.message, { error: true });
      } else if (Array.isArray(err.body?.problems)) {
        setProblems(err.body.problems as FieldProblem[]);
        toast((err.body.problems as FieldProblem[])[0]?.message ?? err.message, { error: true });
      } else toast(err.message, { error: true });
    } finally {
      setStarting(false);
    }
  };

  const capsNow = caps ?? { gpuMinutes: estimate?.gpu.suggestedCapMin ?? 0, claudeUsd: estimate?.claude.suggestedCapUsd ?? 0 };
  const wall = estimate ? `~${Math.round((estimate.wall.lowMin + estimate.wall.highMin) / 2)} min · ≤ ${capsNow.gpuMinutes} GPU min` : undefined;

  return (
    <>
      <Sheet open={open} title="Put me in this edit" onClose={onClose}>
        <div class="make-sheet">
          <Step n={1} title="Your photo" id="make-photo" state={photos.length && consent ? "done" : "open"}>
            <PhotoDrop
              min={1}
              max={MAX_PHOTOS}
              title="Your character: face and full outfit"
              photos={photos}
              uploading={uploading.map(({ name, pct }) => ({ name, pct }))}
              heic={heic}
              consent={consent}
              onAdd={addPhotos}
              onRemove={removePhoto}
              onReorder={reorder}
              onConsent={setConsent}
            />
          </Step>

          <Step n={2} title="Make it yours" id="make-yours" state={photos.length ? "open" : "dim"}>
            <BriefForm fields={fields} words={[]} values={values} problems={problems} onChange={(id, v) => setValues((x) => ({ ...x, [id]: v }))} />

            <div class="field-block" role="radiogroup" aria-labelledby="make-mode">
              <span id="make-mode" class="kt-field-label">
                How close to the original?
              </span>
              <div class="kt-segments">
                <button type="button" role="radio" class={`kt-segment${mode === "remix" ? " on" : ""}`} aria-checked={mode === "remix"} onClick={() => setMode("remix")}>
                  Remix
                </button>
                <button type="button" role="radio" class={`kt-segment${mode === "recreate" ? " on" : ""}`} aria-checked={mode === "recreate"} onClick={() => setMode("recreate")}>
                  Shot for shot
                </button>
              </div>
              <p class="kt-fine">{mode === "remix" ? "Your story, its rhythm." : "Copy every shot with you in it."}</p>
            </div>

            <fieldset class="field-block sound">
              <legend class="kt-field-label">Sound</legend>
              {hasAudio && (
                <label class="kt-radio">
                  <input type="radio" name="make-sound" checked={sound === "original"} onChange={() => setSound("original")} />
                  Original sound
                </label>
              )}
              <label class="kt-radio">
                <input type="radio" name="make-sound" checked={sound === "mine"} onChange={() => setSound("mine")} />
                My track
              </label>
              {sound === "original" && <p class="kt-fine">Posting it? Use the platform's own copy of the song if you don't own it. You also get a silent copy.</p>}
              {!hasAudio && <p class="kt-fine">No sound in this clip. You'll add a track.</p>}
              {sound === "mine" && (
                <div class="track-row">
                  {music ? (
                    <>
                      <p class="track-note">{estimate?.track?.note ?? `${music.name}${music.track ? ` · ${Math.round(music.track.bpm)} BPM` : ""}`}</p>
                      {estimate?.track?.aligned && (
                        <label class="kt-check">
                          <input type="checkbox" checked={!alignDrop} onChange={(e) => setAlignDrop(!e.currentTarget.checked)} />
                          Start from the beginning instead
                        </label>
                      )}
                      <Button variant="ghost" size="small" onClick={() => trackInput.current?.click()}>
                        Replace track
                      </Button>
                    </>
                  ) : (
                    <>
                      <span class="kt-field-label">Your track</span>
                      <Button variant="ghost" onClick={() => trackInput.current?.click()} disabled={Boolean(musicUpload)}>
                        {musicUpload ? `Uploading… ${musicUpload.pct}%` : "Choose audio"}
                      </Button>
                      <span class="kt-fine">MP3, WAV, M4A, AAC, FLAC or OGG · 10 s – 10 min</span>
                    </>
                  )}
                  <input
                    ref={trackInput}
                    type="file"
                    class="kt-sr"
                    tabIndex={-1}
                    aria-label="Choose audio"
                    accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"
                    onChange={(e) => {
                      const f = e.currentTarget.files?.[0];
                      if (f) addTrack(f);
                      e.currentTarget.value = "";
                    }}
                  />
                </div>
              )}
            </fieldset>

            <label class="field-block">
              <span class="kt-field-label">Director's note (optional)</span>
              <textarea
                class="kt-input kt-textarea"
                rows={2}
                maxLength={NOTE_MAX}
                value={note}
                placeholder="Anything the director should know: 'make the spin really clean'"
                onInput={(e) => setNote(e.currentTarget.value)}
              />
            </label>
            <label class="kt-check plan-first">
              <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.currentTarget.checked)} />
              <span>
                Show me the plan first
                <span class="kt-fine"> The director stops after planning so you can check the shots and cost. Adds a pause.</span>
              </span>
            </label>
            {prompt && (
              <details class="prompt-preview">
                <summary>What the director will be told</summary>
                <pre class="mono">{prompt}</pre>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() =>
                    void navigator.clipboard.writeText(prompt).then(
                      () => toast("Copied."),
                      () => toast("Couldn't copy. Select the text and copy it by hand.", { error: true }),
                    )
                  }
                >
                  Copy
                </Button>
              </details>
            )}
          </Step>

          <Step n={3} title="Budget" id="make-budget" state={photos.length ? "open" : "dim"}>
            <p class="kt-fine study-line">{`The director studies all ${Math.round(durationSec)} seconds frame by frame first.`}</p>
            <Receipt
              estimate={estimate}
              loading={estimating}
              caps={capsNow}
              commercial={commercial}
              clipsModel={clipsModel}
              onCaps={(c) => {
                capsTouched.current = true;
                setCaps(c);
              }}
              onCommercial={setCommercial}
              onClipsModel={setClipsModel}
            />
          </Step>

          <div class="kt-make make-bar">
            {wall && <span class="mono make-bar-sum">{wall}</span>}
            <Button variant="cta" class="kt-make-btn" aria-disabled={!ready} onClick={() => ready && void start()}>
              Make my edit
            </Button>
            {reason ? (
              <p class="kt-make-why blocked" role="status">
                {reason}
              </p>
            ) : (
              caps && <p class="kt-make-why">{`Approves up to ${caps.gpuMinutes} GPU min · ${fmtUsd(caps.claudeUsd)} of Claude usage`}</p>
            )}
          </div>
          <p class="kt-privacy make-privacy">Your photos go only to your GPU provider (to make shots) and to Claude (to judge them).</p>
        </div>
      </Sheet>

      {estimate && caps && <ApproveDialog open={approve} estimate={estimate} caps={caps} busy={starting} onClose={() => setApprove(false)} onConfirm={() => void start(true)} />}
    </>
  );
}

/** Make another from a decoded edit: copies the reference into a new project, decodes it, opens its sheet (§3.3 R9). */
export async function makeAnother(project: string): Promise<void> {
  try {
    const r = await app.decode({ fromProject: project });
    navigate(`/decode/${encodeURIComponent(r.project)}?make=1`);
  } catch (e) {
    toast((e as Error).message, { error: true });
  }
}
