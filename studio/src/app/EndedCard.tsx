import type { ComponentChildren } from "preact";
import type { ContinueRun, FailureCode, RunState } from "../../../src/app/types.js";
import { Link, navigate } from "./router.js";
import { Button } from "./ui.js";
import { sameWords } from "./PausedCard.js";
import { plural } from "./useRun.js";

/**
 * An ended run's card (spec §4.8 "Ended cards"): stopped by you, interrupted, or failed with a code.
 * Each says what happened, what is kept and what to do; Continue resumes the same run.
 */
export interface EndedCardProps {
  run: RunState;
  /** The project has a cut (`render/edl.json`), so the editor has something to open. */
  hasEdl: boolean;
  busy: boolean;
  onContinue(req: ContinueRun): void;
  /** Re-checks setup (Claude Code installed and new enough), then continues when it is fixed. */
  onCheckAgain(): void;
  onDetails(): void;
  onDelete(): void;
}

export const CLAUDE_INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";

const SAVED = "Everything made so far is saved.";
/** "<one line>. Everything made so far is saved." without doubling either part. */
const withSaved = (line: string) => (line.includes(SAVED) ? line : `${line.replace(/[.\s]+$/, "")}. ${SAVED}`);

interface Copy {
  headline: string;
  body: ComponentChildren;
  actions: ComponentChildren;
}

export function EndedCard({ run, hasEdl, busy, onContinue, onCheckAgain, onDetails, onDelete }: EndedCardProps) {
  const go = (label: string, req: ContinueRun = {}) => (
    <Button variant="primary" disabled={busy} onClick={() => onContinue(req)}>
      {label}
    </Button>
  );
  const details = (
    <Button variant="ghost" onClick={onDetails}>
      Details
    </Button>
  );
  const copy = ((): Copy | undefined => {
    if (run.status === "cancelled") {
      const kept = run.detail?.startsWith("Stopped by you") ? run.detail : `Stopped by you. ${plural(run.jobs.completed, "finished shot")} kept.`;
      return {
        headline: "STOPPED",
        body: kept,
        actions: (
          <>
            {go("Continue")}
            {hasEdl && (
              <Link class="btn ghost" href={`/edit/${encodeURIComponent(run.project)}`}>
                Open in editor
              </Link>
            )}
            <Button variant="ghost" class="danger" onClick={onDelete}>
              Delete
            </Button>
          </>
        ),
      };
    }
    if (run.status === "interrupted") {
      return {
        headline: "INTERRUPTED",
        body: `This edit stopped before it finished. The computer may have restarted or gone to sleep. ${SAVED}`,
        actions: go("Continue from here"),
      };
    }
    if (run.status !== "failed" || !run.failure) return undefined;
    const f = run.failure;
    const byCode: Record<FailureCode, Copy> = {
      CLAUDE_MISSING: {
        headline: "Claude Code isn't installed",
        body: (
          <>
            open-katana uses Claude Code as the director: it plans the shots, judges every take and cuts the edit. Install it, run <code>claude</code> once to sign in,
            then check again.
          </>
        ),
        actions: (
          <>
            <a class="btn ghost" href={CLAUDE_INSTALL_URL} target="_blank" rel="noreferrer">
              Install guide ↗
            </a>
            <Button variant="primary" disabled={busy} onClick={onCheckAgain}>
              Check again
            </Button>
          </>
        ),
      },
      CLAUDE_TOO_OLD: {
        headline: "Update Claude Code",
        body: "This version can't run edits headlessly. Update it, then check again.",
        actions: (
          <Button variant="primary" disabled={busy} onClick={onCheckAgain}>
            Check again
          </Button>
        ),
      },
      CLAUDE_LOGGED_OUT: {
        headline: "Claude Code isn't signed in",
        body: (
          <>
            Run <code>claude</code> in a terminal and sign in. {SAVED}
          </>
        ),
        actions: go("Continue"),
      },
      GPU_NOT_CONFIGURED: {
        headline: "Connect a GPU to make edits",
        body: "Use Comfy Cloud, this computer's ComfyUI, or another computer's.",
        actions: (
          <Button variant="primary" onClick={() => navigate("/setup")}>
            Set up GPU
          </Button>
        ),
      },
      BACKEND_DOWN: {
        headline: f.message.startsWith("Can't reach") ? f.message.replace(/\.$/, "") : "Can't reach your GPU",
        body: "Start ComfyUI and try again. Nothing was spent.",
        actions: go("Check and continue"),
      },
      MODELS_MISSING: {
        headline: "Your ComfyUI is missing models",
        body: f.message,
        actions: (
          <Link class="btn ghost" href="/setup">
            See what's missing
          </Link>
        ),
      },
      TOOLS_NOT_LOADED: {
        headline: "The open-katana tools didn't load",
        body: "Claude Code started without them, so nothing was spent.",
        actions: (
          <>
            {details}
            {go("Try again")}
          </>
        ),
      },
      SPAWN_FAILED: {
        headline: "The director couldn't start",
        body: f.message,
        actions: (
          <>
            {details}
            {go("Try again")}
          </>
        ),
      },
      AGENT_ERROR: {
        headline: "The director hit an error",
        body: withSaved(f.message),
        actions: (
          <>
            {go("Continue")}
            {details}
          </>
        ),
      },
      CRASHED: {
        headline: "The director stopped unexpectedly",
        body: withSaved(f.message),
        actions: (
          <>
            {go("Continue")}
            {details}
          </>
        ),
      },
      BLOCKED: {
        headline: "The director stopped",
        body: f.message,
        actions: (
          <>
            {go("Continue")}
            {details}
          </>
        ),
      },
    };
    return byCode[f.code];
  })();
  if (!copy) return null;
  return (
    <section class={`run-card ended${run.status === "failed" ? " failed" : ""}`} aria-labelledby="run-card-title">
      <h3 id="run-card-title" class={sameWords(copy.headline, run.headline) ? "kt-sr" : `run-card-title${/[a-z]/.test(copy.headline) ? " sentence" : ""}`}>
        {copy.headline}
      </h3>
      <p class="run-card-body">{copy.body}</p>
      <div class="run-card-actions">{copy.actions}</div>
    </section>
  );
}
