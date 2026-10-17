import type { ComponentChildren, VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ContinueRun, ProjectPageData, RunState } from "../../../../src/app/types.js";
import { ApiError, app } from "../api.js";
import { ChangesSheet } from "../ChangesSheet.js";
import { startNowCopy } from "../copy.js";
import { DiagnosticsSheet } from "../DiagnosticsSheet.js";
import { EndedCard } from "../EndedCard.js";
import { makeAnother } from "../MakeSheet.js";
import { notifyRunChange } from "../notify.js";
import { PausedCard } from "../PausedCard.js";
import { ProgressView } from "../ProgressView.js";
import { ResultView } from "../ResultView.js";
import { Link, navigate } from "../router.js";
import { SaveTemplateSheet } from "../SaveTemplateSheet.js";
import { useApp } from "../Shell.js";
import { TakeLightbox } from "../TakeLightbox.js";
import { Button, Dialog, MediaBox, toast } from "../ui.js";
import { fmtDay, HOLDS_LOCK, pillText, plural, stateOfRun, useProject } from "../useRun.js";
import { WordsSheet } from "../WordsSheet.js";
import "../run.css";

/**
 * `/p/:id` (spec §4.8–4.10): one URL for an edit being made, paused, ended or done. The run arrives as
 * full snapshots on the project channel; every action (Stop, Continue, Start now, picks, changes) is a
 * request to the run manager, and the next snapshot shows its effect.
 */
export function ProjectPage({ id }: { id: string }) {
  const { page, run, receivedAt, exporting, error, reload } = useProject(id);
  const { setup } = useApp();
  const [busy, setBusy] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [startNowOpen, setStartNowOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [sheet, setSheet] = useState<"words" | "changes" | "template">();
  const [take, setTake] = useState<string>();
  const prev = useRef<RunState>();
  const stopAsked = useRef(false);
  const pickExport = useRef(false);

  // Update video after a pick (the lightbox's toast): say when the new version is in.
  useEffect(() => {
    if (!pickExport.current || !exporting) return;
    if (exporting.state === "done") {
      pickExport.current = false;
      toast(`Saved as v${exporting.version ?? ""}`.trim());
    } else if (exporting.state === "error") {
      pickExport.current = false;
      toast(exporting.error ?? "The render failed. Your pick is saved; try Update video again.", { error: true });
    }
  }, [exporting]);

  // Notifications, and the toast that confirms a Stop once the run has really stopped.
  useEffect(() => {
    if (!run) return;
    notifyRunChange(prev.current, run);
    if (stopAsked.current && run.status === "cancelled") {
      stopAsked.current = false;
      const stuck = run.warnings.find((w) => /couldn't be cancelled/i.test(w));
      toast(stuck ? `Stopped. ${stuck}` : `Stopped. ${plural(run.jobs.cancelled, "GPU job")} cancelled.`);
    }
    prev.current = run;
  }, [run]);

  // "(62%) Hype Energy · open-katana" while it is being made.
  useEffect(() => {
    if (!run) return;
    const making = run.status === "starting" || run.status === "running" || run.status === "stopping";
    document.title = `${making ? `(${Math.round(run.pct)}%) ` : ""}${run.title} · open-katana`;
  }, [run?.pct, run?.status, run?.title]);
  useEffect(() => () => void (document.title = "open-katana"), []);

  // A decoded edit with no run yet lives on its decode page.
  useEffect(() => {
    if (page && !page.run && page.card.origin === "decode") navigate(`/decode/${encodeURIComponent(id)}`, { replace: true });
  }, [page]);

  if (error && !page)
    return (
      <main id="content" class="kt-page run-page">
        <PageHead title="This edit isn't here" />
        <p class="kt-fine">{error}</p>
        <Link class="btn ghost" href="/edits">
          Your edits
        </Link>
      </main>
    );
  if (!page) return <main id="content" class="kt-page run-page" aria-busy="true" />;
  if (!run) return <ChatView page={page} />;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      const err = e as ApiError;
      toast(err.message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  const cont = (req: ContinueRun) => void act(() => app.continueRun(run.id, req));
  const stop = () =>
    void act(async () => {
      stopAsked.current = true;
      setStopOpen(false);
      await app.cancelRun(run.id);
    });
  const checkAgain = () =>
    void act(async () => {
      const s = await app.setup(true);
      if (s.claude.state === "ok") await app.continueRun(run.id, {});
      else toast(s.blockers.find((b) => b.code.startsWith("CLAUDE"))?.message ?? "Claude Code still isn't ready.", { error: true });
    });
  const remove = () =>
    void act(async () => {
      try {
        await app.deleteProject(id);
        setDeleteOpen(false);
        navigate("/edits");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) throw new Error("Stop the edit first.");
        throw e;
      }
    });
  const another = () => {
    if (run.kind === "decode") void makeAnother(id);
    else if (run.template) navigate(`/t/${encodeURIComponent(run.template)}?again=${encodeURIComponent(id)}`);
  };

  const state = stateOfRun(run.status);
  const canStop = run.canCancel && ["queued", "starting", "running", "paused"].includes(run.status);
  const aspect = run.result ? run.result.width / run.result.height : (run.cutMap?.aspect ?? page.card.aspect ?? 9 / 16);
  const hasEdl = ["assembling", "rendered", "delivered"].includes(page.card.stage);
  const done = run.status === "done" && run.result;

  let card: VNode | undefined;
  if (run.status === "paused") card = <PausedCard run={run} busy={busy} onContinue={cont} onStop={() => setStopOpen(true)} />;
  else if (["cancelled", "interrupted", "failed"].includes(run.status))
    card = <EndedCard run={run} hasEdl={hasEdl} busy={busy} onContinue={cont} onCheckAgain={checkAgain} onDetails={() => setDetails(true)} onDelete={() => setDeleteOpen(true)} />;

  return (
    <main id="content" class="kt-page run-page">
      <PageHead title={run.title} pill={pillText(state, { pct: run.pct, versions: page.versions.length || run.result?.version })} state={state}>
        {canStop && (
          <Button variant="danger" onClick={() => setStopOpen(true)} disabled={busy}>
            Stop
          </Button>
        )}
      </PageHead>

      {done ? (
        <ResultView
          page={page}
          run={run as RunState & { result: NonNullable<RunState["result"]> }}
          exporting={exporting}
          onWords={() => setSheet("words")}
          onChanges={() => setSheet("changes")}
          onMakeAnother={another}
          onSaveTemplate={() => setSheet("template")}
          onTake={setTake}
        />
      ) : (
        <ProgressView run={run} receivedAt={receivedAt} aspect={aspect} card={card} onStartNow={() => setStartNowOpen(true)} onStop={() => setStopOpen(true)} onTake={setTake} />
      )}

      <TakeLightbox
        project={id}
        takes={run.takes}
        asset={take}
        running={HOLDS_LOCK.includes(run.status)}
        onAsset={setTake}
        onPicked={() => void reload()}
        onUpdateVideo={() =>
          void act(async () => {
            pickExport.current = true;
            await app.exportProject(id).catch((e) => {
              pickExport.current = false;
              throw e;
            });
          })
        }
      />
      <DiagnosticsSheet runId={run.id} open={details} onClose={() => setDetails(false)} />
      {page.words && <WordsSheet open={sheet === "words"} project={id} words={page.words} exporting={exporting} onClose={() => setSheet(undefined)} />}
      <ChangesSheet
        open={sheet === "changes"}
        issues={run.result?.issues ?? []}
        busy={busy}
        onClose={() => setSheet(undefined)}
        onSend={(reply) =>
          void act(async () => {
            await app.continueRun(run.id, { reply });
            setSheet(undefined);
            await reload();
          })
        }
      />
      <SaveTemplateSheet
        open={sheet === "template"}
        project={id}
        defaultTitle={run.title}
        can={page.canSaveTemplate}
        originalSound={page.versions.some((v) => v.silentUrl)}
        onClose={() => setSheet(undefined)}
      />

      <Dialog
        open={stopOpen}
        title="Stop making this edit?"
        onClose={() => setStopOpen(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setStopOpen(false)}>
              Keep going
            </Button>
            <Button variant="danger" disabled={busy} onClick={stop}>
              Stop
            </Button>
          </>
        }
      >
        <p>Shots already made are kept. GPU jobs still in the queue are cancelled. You can continue later.</p>
      </Dialog>
      <Dialog
        open={startNowOpen}
        title="Start now anyway?"
        onClose={() => setStartNowOpen(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setStartNowOpen(false)}>
              Keep waiting
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setStartNowOpen(false);
                  await app.startNow(run.id);
                })
              }
            >
              Start now
            </Button>
          </>
        }
      >
        <p>{startNowCopy(setup)}</p>
      </Dialog>
      <Dialog
        open={deleteOpen}
        title={`Delete '${run.title}'?`}
        onClose={() => setDeleteOpen(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        <p>Its photos, shots and renders move to ~/.open-katana/trash.</p>
      </Dialog>
    </main>
  );
}

/** "← Your edits", the title, the status pill and the page's one action. */
function PageHead({ title, pill, state, children }: { title: string; pill?: string; state?: string; children?: ComponentChildren }) {
  return (
    <div class="page-head">
      <Link class="back-link" href="/edits">
        ← Your edits
      </Link>
      <h1 class="kt-title page-title">{title}</h1>
      {pill && <span class={`pill ${state ?? ""}`}>{pill}</span>}
      <span class="spacer" />
      {children}
    </div>
  );
}

/** A project made in a Claude Code chat (D41): read-only, its stage and versions. */
function ChatView({ page }: { page: ProjectPageData }) {
  const latest = page.versions.at(-1);
  const aspect = page.card.aspect ?? 9 / 16;
  return (
    <main id="content" class="kt-page run-page">
      <PageHead title={page.card.title} pill={pillText(page.card.state, { versions: page.card.versions })} state={page.card.state} />
      <div class="chat-view">
        <div class="chat-media" style={{ "--ar": String(aspect) }}>
          <MediaBox aspect={aspect} grain>
            {latest ? <video src={latest.url} controls playsInline preload="metadata" /> : <img src={app.posterUrl(page.card.id)} alt="" onError={(e) => (e.currentTarget.hidden = true)} />}
          </MediaBox>
        </div>
        <div class="chat-side">
          {page.card.state !== "chat" && <p class="kt-fine">Made in a Claude Code chat</p>}
          <dl class="facts">
            <dt>Stage</dt>
            <dd>{page.card.stage}</dd>
            <dt>Started</dt>
            <dd>{fmtDay(page.card.createdAt)}</dd>
          </dl>
          {page.versions.length > 0 && (
            <ul class="version-list">
              {[...page.versions].reverse().map((v) => (
                <li key={v.version}>
                  <span class="mono">v{v.version}</span>
                  <span class="kt-fine mono">
                    {v.sizeMB !== undefined ? `${v.sizeMB.toFixed(1)} MB · ` : ""}
                    {fmtDay(v.createdAt)}
                  </span>
                  <a href={v.url} download>
                    Download
                  </a>
                </li>
              ))}
            </ul>
          )}
          <Link class="btn primary" href={`/edit/${encodeURIComponent(page.card.id)}`}>
            Open in editor
          </Link>
        </div>
      </div>
    </main>
  );
}
