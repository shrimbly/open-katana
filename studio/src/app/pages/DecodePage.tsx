import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CutMapData, DecodePhase, DecodeState } from "../../../../src/app/types.js";
import { fmtSeconds, fmtTime, useMediaTime } from "../beat.js";
import { CutMap, type CutMapProps } from "../CutMap.js";
import { arrivalFlash, useReducedMotion } from "../flash.js";
import { MakeSheet, makeAnother } from "../MakeSheet.js";
import { SoundToggle } from "../ResultView.js";
import { Link, useRoute } from "../router.js";
import { Button, MediaBox, Stat } from "../ui.js";
import { useDecode } from "../useDecode.js";
import { fmtAspect, plural } from "../useRun.js";
import "../run.css";

/**
 * `/decode/:id` (spec §4.6): a dropped edit decoding live (phases, lanes drawing as data arrives), then
 * DECODED IN n S with the stat row, the plain read, the lanes and the shots, and **Put me in this edit**,
 * which opens the make sheet. `?make=1` opens the sheet at once (Make another).
 */

/** The phase list while decoding; flashes come with the cuts, so that row completes with them. */
const ROWS: { label: string; phase: DecodePhase; after?: boolean }[] = [
  { label: "Reading frames", phase: "frames" },
  { label: "Finding cuts", phase: "cuts" },
  { label: "Catching flashes", phase: "cuts", after: true },
  { label: "Tracking the beat", phase: "audio" },
  { label: "Reading camera moves", phase: "motion" },
  { label: "Measuring energy", phase: "energy" },
];

const SHOTS_SHOWN = 14;

export function DecodePage({ id }: { id: string }) {
  const { query } = useRoute();
  const { state, page, run, error, notFound } = useDecode(id);
  const [sheet, setSheet] = useState(query.get("make") === "1");
  const [muted, setMuted] = useState(true);
  const [allShots, setAllShots] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const reduced = useReducedMotion();
  const seenRunning = useRef(false);

  const decoded = state?.status === "ready" || state?.status === "done";
  // DECODED IN n S flashes once, on arrival: after watching it decode, or when it has only just got there.
  useEffect(() => {
    if (!state) return;
    if (state.status === "running") seenRunning.current = true;
    else if (decoded && (seenRunning.current || state.status === "ready")) arrivalFlash(`decoded:${id}`);
  }, [state?.status]);

  if (notFound || (error && !state))
    return (
      <main id="content" class="kt-page decode-page">
        <Link class="back-link" href="/">
          ← Home
        </Link>
        <p class="kt-fine">{notFound ? "This decode isn't here. It may have been deleted." : error}</p>
      </main>
    );
  if (!state) return <main id="content" class="kt-page decode-page" aria-busy="true" />;

  const f = state.format;
  const aspect = f ? f.width / f.height : (state.cutMap?.aspect ?? 9 / 16);
  const duration = f?.durationSec ?? state.cutMap?.durationSec ?? 0;
  const hasAudio = f?.hasAudio ?? true;
  const phase = (p: DecodePhase) => state.phases.find((x) => x.id === p);
  const done = (p: DecodePhase) => phase(p)?.state === "done";
  const map: CutMapData = state.cutMap ?? { durationSec: duration || 1, aspect, shots: [], flashes: [], beats: [], downbeats: [], text: [] };
  const reveal = decoded ? undefined : { cuts: done("cuts"), flashes: done("cuts"), beats: done("audio"), camera: done("motion"), energy: done("energy") };
  const stats = state.stats;
  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
  };
  const mapLabel = stats
    ? `${plural(stats.shots, "shot")}, ${plural(stats.flashes, "flash", "flashes")}, ${stats.bpm && hasAudio ? `${Math.round(stats.bpm)} beats per minute, ` : ""}${fmtSeconds(duration).replace(" s", " seconds")}`
    : `Decoding, ${fmtSeconds(duration).replace(" s", " seconds")}`;
  const shots = state.shots ?? [];
  const busy = Boolean(run && ["queued", "starting", "running", "stopping", "paused"].includes(run.status));
  const madeOne = Boolean(run);

  return (
    <main id="content" class="kt-page decode-page">
      <Link class="back-link" href="/">
        ← Home
      </Link>
      <div class={`decode-grid${state.status === "error" ? " failed" : ""}`}>
        {state.status !== "error" && (
          <section class="decode-media" aria-label="Your video">
            <div class="decode-player" style={{ "--ar": String(aspect) }}>
              <MediaBox aspect={aspect} grain>
                <video ref={video} src={state.videoUrl} muted={muted} autoPlay={!reduced} loop playsInline controls={reduced} preload="metadata" aria-label={state.name} />
              </MediaBox>
              {hasAudio && !reduced && decoded && <SoundToggle muted={muted} onToggle={() => setMuted((m) => !m)} />}
            </div>
          </section>
        )}

        <section class="decode-info" aria-labelledby="decode-title">
          {state.status === "error" ? (
            <>
              <h1 id="decode-title" class="kt-title">
                We couldn't decode that
              </h1>
              <p class="type-body-l">{state.error?.message}</p>
              <Link class="btn primary" href="/">
                Decode another edit
              </Link>
            </>
          ) : !decoded ? (
            <>
              <h1 id="decode-title" class="kt-display-l">
                DECODING
              </h1>
              <p class="mono decode-file">{[state.name, f && `${f.width}×${f.height}`, f && `${Math.round(f.fps)} fps`, f && fmtSeconds(f.durationSec)].filter(Boolean).join(" · ")}</p>
              <ol class="decode-phases" aria-live="polite">
                {ROWS.map((r) => {
                  const p = phase(r.phase);
                  const st = r.after ? (p?.state === "done" ? "done" : "todo") : (p?.state ?? "todo");
                  return (
                    <li key={r.label} class={`phase ${st}`}>
                      <span class="phase-mark" aria-hidden="true" />
                      <span>{r.label}</span>
                      {!r.after && p?.total ? (
                        <span class="mono phase-count">
                          {p.done ?? 0} / {p.total}
                        </span>
                      ) : null}
                      <span class="kt-sr">{st === "done" ? ", done" : st === "now" ? ", in progress" : ""}</span>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <>
              <h1 id="decode-title" class="kt-display-l kt-slam">
                DECODED IN {((state.tookMs ?? 0) / 1000).toFixed(1)} S
              </h1>
              {stats && <StatRow state={state} hasAudio={hasAudio} />}
              {f && (
                <p class="mono decode-file">
                  {fmtSeconds(f.durationSec)} · {fmtAspect(f.width, f.height)} · {Math.round(f.fps)} fps
                </p>
              )}
              {state.read && <p class="type-body-l decode-read">{state.read.join(" ")}</p>}
              <div class="decode-actions">
                {madeOne ? (
                  <>
                    <Link class="btn cta" href={`/p/${encodeURIComponent(id)}`}>
                      {busy ? "See progress →" : "See your edit →"}
                    </Link>
                    <Button variant="ghost" onClick={() => void makeAnother(id)}>
                      Make another
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="cta" onClick={() => setSheet(true)}>
                      Put me in this edit
                    </Button>
                    <span class="disabled-link" aria-disabled="true" tabIndex={0} title="Make your edit first. Saving it as a template is instant and free.">
                      Save as template (after you make it)
                      <span class="tip" role="tooltip">
                        Make your edit first. Saving it as a template is instant and free.
                      </span>
                    </span>
                  </>
                )}
              </div>
              {duration > 30 && <p class="kt-fine">Longer edits cost more for the director to study.</p>}
            </>
          )}
        </section>
      </div>

      {state.status !== "error" && (
        <section class="decode-lanes" aria-label="The edit, decoded">
          <Lanes video={video} data={map} reveal={reveal} label={mapLabel} />
          {!hasAudio && <p class="kt-fine lane-note">No sound in this clip. You'll add a track.</p>}
        </section>
      )}

      {decoded && shots.length > 0 && (
        <section class="decode-shots" aria-labelledby="shots-title">
          <h2 id="shots-title" class="label">
            Shots
          </h2>
          <ul class="shot-strip" style={{ "--ar": String(aspect) }}>
            {(allShots ? shots : shots.slice(0, SHOTS_SHOWN)).map((s) => (
              <li key={s.index}>
                <button type="button" class="shot-thumb" style={{ background: s.color }} aria-label={`Shot ${s.index + 1} at ${fmtTime(s.start)}`} onClick={() => seek(s.start + 0.01)}>
                  <img src={s.thumb} alt="" loading="lazy" onError={(e) => (e.currentTarget.hidden = true)} />
                </button>
              </li>
            ))}
          </ul>
          {shots.length > SHOTS_SHOWN && (
            <Button variant="ghost" size="small" aria-expanded={allShots} onClick={() => setAllShots((v) => !v)}>
              {allShots ? "Show fewer" : `See all ${shots.length} shots`}
            </Button>
          )}
        </section>
      )}
      {decoded && (
        <p class="decode-status kt-fine" role="status">
          {state.status === "done" ? "Ready for the director" : "Preparing frames for the director…"}
        </p>
      )}

      {decoded && !madeOne && <MakeSheet open={sheet} project={id} decode={state} fields={page?.brief ?? []} onClose={() => setSheet(false)} />}
    </main>
  );
}

/**
 * The decode lanes, following the video (its own component, so the page doesn't re-render every frame).
 * Hover scrubs, click seeks; ←/→ step shot to shot when the map has focus.
 */
function Lanes({ video, data, reveal, label }: { video: RefObject<HTMLVideoElement>; data: CutMapData; reveal: CutMapProps["reveal"]; label: string }) {
  const time = useMediaTime(video);
  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
  };
  return <CutMap data={data} height={72} lanes reveal={reveal} label={label} currentTime={time} onSeek={seek} onScrub={(t) => t !== undefined && seek(t)} />;
}

/** 23 CUTS · 7 FLASHES · 144 BPM · 89% ON THE BEAT, counting up once (300 ms) when they arrive. */
function StatRow({ state, hasAudio }: { state: DecodeState; hasAudio: boolean }) {
  const s = state.stats!;
  const k = useCountUp(state.project);
  const n = (v: number) => Math.round(v * k);
  return (
    <div class="stat-row kt-display-m">
      <Stat value={n(s.cuts)} unit={s.cuts === 1 ? "CUT" : "CUTS"} />
      <Stat value={n(s.flashes)} unit={s.flashes === 1 ? "FLASH" : "FLASHES"} />
      <Stat value={hasAudio && s.bpm ? n(s.bpm) : "—"} unit="BPM" />
      <Stat value={hasAudio && s.bpm ? `${n(s.cutsOnBeat * 100)}%` : "—"} unit="ON THE BEAT" />
    </div>
  );
}

/** 0 → 1 over 300 ms (instant under reduced motion), restarted when `key` changes. */
function useCountUp(key: string): number {
  const reduced = useReducedMotion();
  const [k, setK] = useState(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) return setK(1);
    const t0 = performance.now();
    let frame = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / 300);
      setK(1 - (1 - p) ** 3);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [key, reduced]);
  return k;
}
