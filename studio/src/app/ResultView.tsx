import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CutMapData, LicenceNote, ProjectPageData, RunState, SetupStatus } from "../../../src/app/types.js";
import { app } from "./api.js";
import { reportBlocks, takeForShot } from "./copy.js";
import { CutMap } from "./CutMap.js";
import { cutMapLabel, TakeGrid } from "./ProgressView.js";
import { Link } from "./router.js";
import { Button, Chip, Icon, MediaBox, Popover, toast } from "./ui.js";
import { fmtUsd, useMediaTime } from "./beat.js";
import { arrivalFlash, useReducedMotion } from "./flash.js";
import { type ExportState, revealLabel } from "./useRun.js";

/**
 * The finished edit (spec §4.9): the video on the night stage with its Cut Map as the scrubber, READY.
 * once, the file facts, Download and Open in editor, the follow-ups, what it cost, the models' licences
 * and the director's report. Under it, the takes (collapsed): any of them opens the take lightbox, where
 * **Use this take** swaps it into the cut (D28, §4.10). Enter on a Cut Map cell opens that shot's take.
 */
export interface ResultViewProps {
  page: ProjectPageData;
  run: RunState & { result: NonNullable<RunState["result"]> };
  exporting?: ExportState;
  onWords(): void;
  onChanges(): void;
  onMakeAnother(): void;
  onSaveTemplate(): void;
  /** Opens the take lightbox on this take. */
  onTake(asset: string): void;
}

/** "Qwen-Image 2.1 (identity keyframes, 25 steps)" → "Qwen-Image 2.1". */
const shortTitle = (title: string) => title.replace(/\s*\(.*\)\s*$/, "");
const licenceWord = (l: LicenceNote) => (l.commercial === "no" ? "non-commercial licence" : l.commercial === "restricted" ? "restricted licence" : l.name);

export function ResultView({ page, run, exporting, onWords, onChanges, onMakeAnother, onSaveTemplate, onTake }: ResultViewProps) {
  const r = run.result;
  const versions = page.versions.length ? page.versions : [{ version: r.version, url: r.url, silentUrl: r.silentUrl, sizeMB: r.sizeMB, createdAt: run.endedAt ?? run.updatedAt }];
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  const [chosen, setChosen] = useState(latest.version);
  const version = versions.find((v) => v.version === chosen) ?? latest;
  const [muted, setMuted] = useState(true);
  const [setup, setSetup] = useState<SetupStatus>();
  const video = useRef<HTMLVideoElement>(null);
  const still = useReducedMotion();
  const decoded = run.kind === "decode";
  const aspect = r.width / r.height;

  useEffect(() => {
    arrivalFlash(`ready:${run.id}:${latest.version}`);
  }, [run.id, latest.version]);
  // A new version (Update video, Ask the director) becomes the one shown.
  useEffect(() => setChosen(latest.version), [latest.version]);
  useEffect(() => {
    app.setup().then(setSetup, () => undefined);
  }, []);

  const gpuWhere = setup?.gpu.where === "local" ? " on this computer's GPU" : setup?.gpu.where === "remote" ? ` on ${hostOf(setup.gpu.target)}` : setup?.gpu.where === "cloud" ? " on Comfy Cloud" : "";
  const claudeWhere = setup?.claude.auth === "subscription" ? ` · counted toward ${setup.claude.plan ?? "your Claude plan"}` : setup?.claude.auth === "api-key" ? " · billed to your API key" : "";
  const restricted = r.licences.filter((l) => l.commercial !== "yes");
  const exportLine = exporting?.state === "rendering" ? `Rendering ${exporting.done ?? 0} / ${exporting.total || "…"}` : undefined;

  return (
    <div class="result">
      <section class="result-stage" aria-label="Your edit">
        <div class="result-player" style={{ "--ar": String(aspect) }}>
          <MediaBox aspect={aspect} grain>
            <video
              ref={video}
              key={version.url}
              src={version.url}
              muted={muted}
              autoPlay={!still}
              loop
              playsInline
              controls={still}
              preload="metadata"
              aria-label={`${run.title}, version ${version.version}`}
            />
          </MediaBox>
          {!still && <SoundToggle muted={muted} onToggle={() => setMuted((m) => !m)} />}
        </div>
        {/* Keyed on the version: a new video element needs its clock re-attached. */}
        {run.cutMap && (
          <SyncedCutMap
            key={version.url}
            data={run.cutMap}
            video={video}
            onShot={(i) => {
              const take = takeForShot(run.takes, run.cutMap?.shots[i]);
              if (take) onTake(take.asset);
            }}
          />
        )}
        {versions.length > 1 && (
          <div class="version-chips" role="group" aria-label="Versions">
            {[...versions]
              .sort((a, b) => a.version - b.version)
              .map((v) => (
                <Chip key={v.version} selected={v.version === chosen} onClick={() => setChosen(v.version)}>
                  <span class="mono">v{v.version}</span>
                </Chip>
              ))}
          </div>
        )}
      </section>

      <section class="result-side" aria-labelledby="result-title">
        <h2 id="result-title" class="kt-display-l kt-slam">
          READY.
        </h2>
        <p class="type-heading result-title">{run.title}</p>
        <p class="mono result-facts">
          {r.durationSec.toFixed(1)} s · {r.width}×{r.height} · {r.fps} fps · {(version.sizeMB ?? r.sizeMB).toFixed(1)} MB · v{version.version}
        </p>
        <div class="result-actions">
          <a class="btn cta" href={version.url} download>
            Download MP4
          </a>
          <Link class="btn ghost" href={`/edit/${encodeURIComponent(run.project)}`}>
            Open in editor
          </Link>
        </div>
        {version.silentUrl && (
          <p class="result-also">
            Also:{" "}
            <a href={version.silentUrl} download>
              silent copy
            </a>
          </p>
        )}
        <ul class="result-links">
          {(page.words?.length ?? 0) > 0 && (
            <li>
              <button type="button" class="kt-link" onClick={onWords}>
                Change the words
              </button>
            </li>
          )}
          <li>
            <button type="button" class="kt-link" onClick={onChanges}>
              Ask the director for changes
            </button>
          </li>
          <li>
            <button type="button" class="kt-link" onClick={onMakeAnother}>
              Make another
            </button>
          </li>
          {decoded && (
            <li>
              <button type="button" class="kt-link" onClick={onSaveTemplate}>
                Save as template
              </button>
            </li>
          )}
          <li>
            <button type="button" class="kt-link" onClick={() => void app.reveal(run.project, "latest").catch((e: Error) => toast(e.message, { error: true }))}>
              {revealLabel()}
            </button>
          </li>
        </ul>
        {exportLine && (
          <p class="mono export-line" role="status">
            {exportLine}
          </p>
        )}

        <div class="result-made">
          <h3 class="type-heading-caps">MADE IN {Math.max(1, Math.round(r.wallMin))} MIN</h3>
          <p class="mono">
            ~{Math.round(r.gpuMinutes)} GPU min{gpuWhere}
          </p>
          <p class="mono">
            Claude {r.costEstimated ? "about " : ""}{fmtUsd(+r.costUsd.toFixed(2))}
            {claudeWhere}
          </p>
          <p class="result-models">
            {restricted.length ? (
              <>
                Models: {restricted.map((l) => `${shortTitle(l.title)} (${licenceWord(l)})`).join(", ")}{" "}
                <Popover
                  label={
                    <>
                      <Icon name="info" size={14} />
                      <span class="kt-sr">Licence details</span>
                    </>
                  }
                  title="Model licences"
                >
                  <ul class="licence-details">
                    {restricted.map((l) => (
                      <li key={l.profile}>
                        <strong>{shortTitle(l.title)}</strong> · {l.role} · {l.name}
                        {l.note && <span class="kt-fine"> {l.note}</span>}
                        {l.url && (
                          <>
                            {" "}
                            <a href={l.url} target="_blank" rel="noreferrer">
                              Licence ↗
                            </a>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p class="kt-fine">Not legal advice.</p>
                </Popover>
              </>
            ) : (
              "Models: all permissive licences."
            )}
          </p>
        </div>

        {r.report && <Report report={r.report} issues={r.issues} />}
        {r.issues.length > 0 && (
          <div class="result-issues">
            <h3 class="label">Known issues</h3>
            <ul>
              {r.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <ResultTakes run={run} aspect={aspect} onTake={onTake} />
    </div>
  );
}

/**
 * The director's closing words as plain text: short paragraphs and a labelled list ("Length 16.4 s …"),
 * no Markdown marks, and no "Known flaws" part when Known issues below lists them.
 */
function Report({ report, issues }: { report: string; issues: string[] }) {
  const blocks = reportBlocks(report, issues);
  if (!blocks.length) return null;
  return (
    <div class="result-report">
      <h3 class="label">Director's report</h3>
      <div class="director-voice">
        {blocks.map((b, i) =>
          b.kind === "p" ? (
            <p key={i}>{b.text}</p>
          ) : (
            <ul key={i} class="report-list">
              {b.items.map((it, j) => (
                <li key={j}>
                  {it.label && <span class="report-label">{it.label}</span>}
                  {it.text}
                </li>
              ))}
            </ul>
          ),
        )}
      </div>
    </div>
  );
}

/** Every take the director made, behind one button: open one to use it in the edit instead. */
function ResultTakes({ run, aspect, onTake }: { run: RunState; aspect: number; onTake(asset: string): void }) {
  const [open, setOpen] = useState(false);
  const takes = run.takes.filter((t) => t.state === "ready");
  if (!takes.length) return null;
  const picks = takes.filter((t) => t.verdict?.by === "you" && t.verdict.verdict === "accept").length;
  return (
    <section class="result-takes" aria-labelledby="result-takes-title">
      <div class="section-head">
        <h3 id="result-takes-title" class="label">
          Takes
        </h3>
        <span class="mono kt-fine">
          {takes.length}
          {picks ? ` · ${picks} your pick${picks > 1 ? "s" : ""}` : ""}
        </span>
        <span class="spacer" />
        <Button variant="ghost" size="small" aria-expanded={open} aria-controls={open ? "result-take-grid" : undefined} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide takes" : `Show all ${takes.length}`}
        </Button>
      </div>
      {open && (
        <>
          <p class="kt-fine result-takes-hint">Open any take to put it in the edit instead of the director's choice.</p>
          <TakeGrid id="result-take-grid" takes={takes} aspect={aspect} onTake={onTake} />
        </>
      )}
    </section>
  );
}

/** The muted-autoplay player's one control: sound on, sound off. */
export function SoundToggle({ muted, onToggle }: { muted: boolean; onToggle(): void }) {
  return (
    <Button variant="ghost" size="small" class="sound-toggle" aria-pressed={!muted} onClick={onToggle}>
      <Icon name={muted ? "mute" : "sound"} size={14} />
      {muted ? "Sound on" : "Sound off"}
    </Button>
  );
}

/** The 36 px Cut Map as the result's scrubber: its playhead follows the video, hover scrubs, click seeks. */
function SyncedCutMap({ data, video, onShot }: { data: CutMapData; video: RefObject<HTMLVideoElement>; onShot(index: number): void }) {
  const time = useMediaTime(video);
  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
  };
  return (
    <div class="result-map">
      <CutMap data={data} height={36} label={cutMapLabel(data)} currentTime={time} onSeek={seek} onScrub={(t) => t !== undefined && seek(t)} onShot={onShot} />
    </div>
  );
}

function hostOf(target?: string): string {
  if (!target) return "your GPU";
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}
