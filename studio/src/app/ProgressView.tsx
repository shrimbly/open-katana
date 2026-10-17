import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { CutMapData, PhaseId, RunState, Take } from "../../../src/app/types.js";
import { CutMap } from "./CutMap.js";
import { notifySupported, notifyWanted, setNotify } from "./notify.js";
import { Button } from "./ui.js";
import { fmtRange, fmtUsd } from "./beat.js";
import { elapsedOf, fmtClock, fmtMin, plural, useNow } from "./useRun.js";

/**
 * A run being made (spec §4.8): the stage headline, a ticking clock, the Cut Map filling with the
 * person's shots, the phase rail and the takes; on the right the director's notes and the budget
 * meters. Paused and ended cards are passed in as `card` and sit above the takes.
 */
export interface ProgressViewProps {
  run: RunState;
  receivedAt: number;
  /** The edit's width / height, for take tiles and the first-look player. */
  aspect: number;
  card?: ComponentChildren;
  onStartNow(): void;
  onStop(): void;
  onTake(asset: string): void;
}

const PHASE_LABEL: Record<PhaseId, string> = {
  setup: "Ready",
  study: "Study",
  plan: "Plan",
  stills: "Stills",
  clips: "Clips",
  mattes: "Cut-outs",
  cut: "Cut",
  render: "Render",
  check: "Check",
  deliver: "Deliver",
};

const LIVE = new Set(["starting", "running", "stopping"]);

export function cutMapLabel(map: CutMapData): string {
  const parts = [map.shots.length ? plural(map.shots.length, "shot") : undefined, map.flashes.length ? plural(map.flashes.length, "flash", "flashes") : undefined];
  return `${parts.filter(Boolean).join(", ")}${parts.some(Boolean) ? ", " : ""}${map.durationSec.toFixed(1)} seconds`;
}

export function ProgressView({ run, receivedAt, aspect, card, onStartNow, onStop, onTake }: ProgressViewProps) {
  const live = LIVE.has(run.status);
  const now = useNow(live || run.stalled);
  const elapsed = elapsedOf(run, receivedAt, now);
  const [stallDismissed, setStallDismissed] = useState<string>();
  const queued = run.status === "queued";
  const headline = run.headline;
  const detail = run.status === "paused" || card ? undefined : run.detail;

  // Phases: skipped ones (study in template runs) leave the rail; cut-outs only when the plan has any.
  const hasMattes = run.takes.some((t) => t.kind === "matte") || run.phase === "mattes";
  const phases = run.phases.filter((p) => p.id !== "deliver" && p.state !== "skipped" && (p.id !== "mattes" || hasMattes));
  const stalledFor = Math.max(10, Math.round((now - Date.parse(run.updatedAt)) / 60_000));

  return (
    <div class="progress">
      <section class="progress-main" aria-label="Progress">
        <div class="progress-head">
          <h2 class="kt-display-l kt-slam" key={headline}>
            {headline}
          </h2>
          {!queued && run.status !== "done" && (
            <span class={`type-num-xl progress-pct${live ? "" : " held"}`} aria-label={`${Math.round(run.pct)} percent`}>
              {Math.round(run.pct)}
              <small>%</small>
            </span>
          )}
        </div>
        {detail && <p class="progress-detail">{queued ? <QueuedDetail text={detail} /> : detail}</p>}
        {!queued && (
          <p class="progress-time mono">
            {fmtClock(elapsed)} elapsed
            {run.etaMin && live ? ` · about ${fmtRange(run.etaMin[0], run.etaMin[1])} min left` : ""}
          </p>
        )}
        {queued && (
          <div class="progress-queued">
            <Button variant="ghost" onClick={onStartNow}>
              Start now anyway
            </Button>
          </div>
        )}
        {run.stalled && stallDismissed !== run.updatedAt && (
          <div class="stall-note" role="status">
            <p>No sign of progress for {stalledFor} minutes. Your GPU may be stuck.</p>
            <Button variant="ghost" size="small" onClick={() => setStallDismissed(run.updatedAt)}>
              Keep waiting
            </Button>
            <Button variant="ghost" size="small" class="danger" onClick={onStop}>
              Stop
            </Button>
          </div>
        )}
        {run.cutMap && (
          <div class="progress-map">
            <CutMap data={run.cutMap} height={64} label={cutMapLabel(run.cutMap)} />
          </div>
        )}
        <ol class={`phase-rail${live || queued ? "" : " held"}`} aria-label="Stages">
          {phases.map((p) => (
            <li key={p.id} class={`phase ${p.state}`} aria-current={p.state === "now" ? "step" : undefined}>
              <span class="phase-mark" aria-hidden="true" />
              {PHASE_LABEL[p.id]}
              {p.id === "study" && run.study && p.state === "now" ? <span class="mono phase-count">{` ${run.study.page}/${run.study.pages}`}</span> : null}
            </li>
          ))}
        </ol>
        {card}
        {run.preview && run.status !== "done" && (
          <figure class="first-look">
            <figcaption class="label">First look · preview render</figcaption>
            <div class="first-look-media" style={{ aspectRatio: String(aspect) }}>
              <video src={`${run.preview.url}?v=${run.preview.mtime}`} controls muted playsInline preload="metadata" />
            </div>
          </figure>
        )}
        <Takes takes={run.takes} aspect={aspect} onTake={onTake} />
      </section>
      <aside class="progress-side" aria-label="The director and the budget">
        <Notes notes={run.notes} />
        <Budget run={run} />
        <NotifyToggle run={run} />
      </aside>
    </div>
  );
}

/** "Starts when Night Stare · stairs finishes." with the other edit's title in italics. */
function QueuedDetail({ text }: { text: string }) {
  const m = text.match(/^Starts when (.+) finishes\.$/);
  return m ? (
    <>
      Starts when <em>{m[1]}</em> finishes.
    </>
  ) : (
    <>{text}</>
  );
}

function Takes({ takes, aspect, onTake }: { takes: Take[]; aspect: number; onTake(asset: string): void }) {
  if (!takes.length) return null;
  const ready = takes.filter((t) => t.state === "ready").length;
  return (
    <section class="takes" aria-labelledby="takes-title">
      <div class="section-head">
        <h3 id="takes-title" class="label">
          Takes
        </h3>
        <span class="mono kt-fine">
          {ready} of {takes.length} made
        </span>
      </div>
      <TakeGrid takes={takes} aspect={aspect} onTake={onTake} />
    </section>
  );
}

/** The take tiles (progress and result): KEPT, YOUR PICK and PASSED chips; a click opens the lightbox. */
export function TakeGrid({ takes, aspect, onTake, id }: { takes: Take[]; aspect: number; onTake(asset: string): void; id?: string }) {
  return (
    <ul class="take-grid" id={id} style={{ "--take-ar": String(aspect) }}>
      {takes.map((t) => (
        <li key={t.asset}>
          <TakeTile take={t} onOpen={() => onTake(t.asset)} />
        </li>
      ))}
    </ul>
  );
}

function TakeTile({ take, onOpen }: { take: Take; onOpen(): void }) {
  const v = take.verdict;
  const chip = v?.by === "you" && v.verdict === "accept" ? "pick" : v?.verdict === "accept" ? "kept" : v?.verdict === "reject" ? "passed" : undefined;
  const chipText = { pick: "YOUR PICK", kept: "KEPT", passed: "PASSED" };
  const name = take.asset.replace(/_t(\d+)$/, " · t$1");
  if (take.state !== "ready")
    return (
      <div class={`take ${take.state}`} aria-label={take.state === "making" ? `Making ${take.asset}` : `${take.asset} failed`}>
        <span class="take-media hatch" />
        <span class="take-name mono">{name}</span>
      </div>
    );
  return (
    <button type="button" class={`take${chip ? ` ${chip}` : ""}`} onClick={onOpen} aria-label={`${take.asset}${chip ? `, ${chipText[chip]}` : ""}${v?.reason ? `: ${v.reason}` : ""}`}>
      <span class="take-media">
        {take.thumb ? <img src={take.thumb} alt="" loading="lazy" onError={(e) => (e.currentTarget.hidden = true)} /> : null}
        {take.kind !== "still" && <span class="take-kind" aria-hidden="true">{take.kind === "clip" ? "▶" : "◐"}</span>}
      </span>
      {chip && <span class={`take-chip ${chip}`}>{chipText[chip]}</span>}
      <span class="take-name mono" title={take.asset}>
        {name}
      </span>
      {v?.reason && (
        <span class="take-reason" role="tooltip">
          {v.reason}
        </span>
      )}
    </button>
  );
}

function Notes({ notes }: { notes: RunState["notes"] }) {
  const [all, setAll] = useState(false);
  const newest = [...notes].reverse();
  const shown = all ? newest : newest.slice(0, 6);
  return (
    <section class="notes" aria-labelledby="notes-title">
      <h3 id="notes-title" class="label">
        Director's notes
      </h3>
      {notes.length === 0 ? (
        <p class="kt-fine">The director writes a line here as each stage starts.</p>
      ) : (
        <ol class={`note-list${all ? " all" : ""}`} aria-live="polite">
          {shown.map((n) => (
            <li key={`${n.at}${n.text}`} class="note">
              <time class="mono" dateTime={n.at}>
                {new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              <span>{n.text}</span>
            </li>
          ))}
        </ol>
      )}
      {/* More than 6 notes on a wide screen; on a phone the list starts collapsed to the newest. */}
      {notes.length > 1 && (
        <Button variant="ghost" size="small" class={`show-all${notes.length > 6 ? "" : " few"}`} onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${notes.length}`}
        </Button>
      )}
    </section>
  );
}

function Budget({ run }: { run: RunState }) {
  const cap = run.caps.gpuMinutes;
  const used = run.jobs.gpuMinCommitted;
  const planned = run.jobs.gpuMinPlanned;
  // Spent comes from finished attempts only; before the first one ends there is nothing to show.
  const firstAttempt = run.usage.claudeUsd === 0;
  const fiveHour = run.usage.plan?.fiveHour;
  return (
    <section class="budget" aria-labelledby="budget-title">
      <h3 id="budget-title" class="label">
        Budget
      </h3>
      <div class="meter-row">
        <span class="meter-name">GPU</span>
        <div class="meter" role="meter" aria-label="GPU minutes used" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}>
          {planned !== undefined && <span class="meter-plan" style={{ width: `${Math.min(100, (planned / cap) * 100)}%` }} />}
          <span class="meter-fill" style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} />
        </div>
        <span class="mono meter-value">
          {fmtMin(used)} / {fmtMin(cap)} min (est.)
        </span>
      </div>
      <div class="meter-row">
        <span class="meter-name">Claude</span>
        <div class="meter" role="meter" aria-label="Claude usage spent" aria-valuemin={0} aria-valuemax={run.caps.claudeUsd} aria-valuenow={run.usage.claudeUsd}>
          <span class="meter-fill steel" style={{ width: `${Math.min(100, (run.usage.claudeUsd / run.caps.claudeUsd) * 100)}%` }} />
        </div>
        <span class="mono meter-value">
          spent {firstAttempt ? "—" : `${run.usage.claudeUsdEstimated ? "about " : ""}${fmtUsd(+run.usage.claudeUsd.toFixed(2))}`} · cap {fmtUsd(run.caps.claudeUsd)}
        </span>
      </div>
      {fiveHour !== undefined && <p class="kt-fine mono">Claude plan · 5-hour {Math.round(fiveHour * 100)}%</p>}
    </section>
  );
}

function NotifyToggle({ run }: { run: RunState }) {
  const [on, setOn] = useState(() => notifyWanted(run.project));
  useEffect(() => setOn(notifyWanted(run.project)), [run.project]);
  if (!notifySupported() || run.status === "done") return null;
  return (
    <label class="kt-check notify">
      <input type="checkbox" checked={on} onChange={(e) => void setNotify(run.project, e.currentTarget.checked).then(setOn)} />
      Notify me when it's ready
    </label>
  );
}
