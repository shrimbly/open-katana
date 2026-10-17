import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ContinueRun, RunState } from "../../../src/app/types.js";
import { Button } from "./ui.js";
import { fmtUsd } from "./beat.js";
import { fmtMin, fmtWallClock, useNow } from "./useRun.js";

/**
 * A paused run's card (spec §4.8 "Paused cards"): what the director needs and the one way to carry on.
 * It sits above the takes, in the page, never as a modal. Every action is a `POST /continue` with the new
 * totals; Stop goes through the page's stop dialog.
 */
export interface PausedCardProps {
  run: RunState;
  /** A continue or stop request is in flight. */
  busy: boolean;
  onContinue(req: ContinueRun): void;
  onStop(): void;
}

const HEADLINES: Record<NonNullable<RunState["attention"]>["code"], string> = {
  NEEDS_APPROVAL: "YOUR CALL",
  BUDGET_CAP: "NEEDS YOUR OK",
  OUT_OF_CREDITS: "OUT OF CREDITS",
  BACKEND_DOWN: "GPU OFFLINE",
  USAGE_LIMIT: "PLAN LIMIT",
  USD_CAP: "BUDGET USED",
  QUESTION: "THE DIRECTOR ASKS",
};

/** The stage headline above already says it (YOUR CALL twice reads as a stutter). */
export const sameWords = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Totals are rounded up to the next 5 (spec §9.13). */
const up5 = (n: number) => Math.ceil(n / 5) * 5;

export function pausedHeadline(run: RunState): string {
  return run.attention ? HEADLINES[run.attention.code] : run.headline;
}

export function PausedCard({ run, busy, onContinue, onStop }: PausedCardProps) {
  const a = run.attention;
  const [reply, setReply] = useState("");
  const resetsAt = a?.resetsAt ?? run.usage.plan?.resetsAt;
  const now = useNow(a?.code === "USAGE_LIMIT", 15_000);
  if (!a) return null;

  const stop = (label = "Stop") => (
    <Button variant="ghost" class="card-stop" disabled={busy} onClick={onStop}>
      {label}
    </Button>
  );
  let body: ComponentChildren;
  let actions: ComponentChildren;
  let under: string | undefined;

  switch (a.code) {
    case "NEEDS_APPROVAL": {
      const plan = a.plan;
      const total = plan?.totalMinutes ?? run.jobs.gpuMinPlanned ?? 0;
      const approve = up5(total * 1.15);
      body = (
        <>
          <p>{plan ? `The director's plan is ready: ${plan.jobs.length} jobs, about ${Math.round(total)} GPU min.` : a.message}</p>
          {plan && <PlanTable plan={plan} />}
        </>
      );
      actions = (
        <>
          <Button variant="primary" disabled={busy} onClick={() => onContinue({ approval: { gpuCapMinutes: approve } })}>
            Approve up to {approve} min
          </Button>
          {stop()}
        </>
      );
      break;
    }
    case "BUDGET_CAP": {
      const needs = a.needsMinutes ?? run.jobs.gpuMinPlanned ?? run.caps.gpuMinutes;
      const cap = a.capMinutes ?? run.caps.gpuMinutes;
      const approve = up5(needs * 1.1);
      body = <p>{`The plan needs about ${Math.round(needs)} GPU min in total. You approved ${fmtMin(cap)}.`}</p>;
      actions = (
        <>
          <Button variant="primary" disabled={busy} onClick={() => onContinue({ approval: { gpuCapMinutes: approve } })}>
            Approve {approve} min
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => onContinue({ fit: true })}>
            Make it fit {fmtMin(cap)} min
          </Button>
          {stop("Stop here")}
        </>
      );
      under = "'Make it fit' asks the director for fewer takes or shorter clips. It keeps the best models.";
      break;
    }
    case "OUT_OF_CREDITS":
      body = <p>Comfy Cloud is out of credits. Credits are shared across your Comfy workspace. Top up, then continue. Everything made so far is saved.</p>;
      actions = (
        <>
          <Button variant="primary" disabled={busy} onClick={() => onContinue({})}>
            Continue
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => onContinue({ finishPartial: true })}>
            Finish with what's made
          </Button>
          {stop()}
        </>
      );
      break;
    case "BACKEND_DOWN":
      body = <p>{a.message || "Lost your GPU. Start ComfyUI, then continue. Everything made so far is saved."}</p>;
      actions = (
        <>
          <Button variant="primary" disabled={busy} onClick={() => onContinue({})}>
            Check and continue
          </Button>
          {stop()}
        </>
      );
      break;
    case "USAGE_LIMIT": {
      const at = resetsAt ? fmtWallClock(resetsAt) : undefined;
      const ready = !resetsAt || now >= Date.parse(resetsAt);
      body = <p>{at ? `Your Claude plan's limit was reached. It resets at ${at}. Everything made so far is saved.` : a.message}</p>;
      actions = (
        <>
          <Button variant="primary" disabled={busy || !ready} onClick={() => onContinue({})}>
            {at ? `Continue at ${at}` : "Continue"}
          </Button>
          {stop()}
        </>
      );
      break;
    }
    case "USD_CAP": {
      const raise = run.caps.claudeUsd + 5;
      body = <p>{`The director used the ${fmtUsd(run.caps.claudeUsd)} you approved before finishing.`}</p>;
      actions = (
        <>
          <Button variant="primary" disabled={busy} onClick={() => onContinue({ approval: { claudeCapUsd: raise } })}>
            Raise to {fmtUsd(raise)} and continue
          </Button>
          {stop("Stop here")}
        </>
      );
      break;
    }
    case "QUESTION": {
      const text = reply.trim();
      body = (
        <>
          <blockquote class="director-quote">{a.question ?? a.message}</blockquote>
          <label class="reply">
            <span class="label">Your reply</span>
            <textarea class="kt-input kt-textarea" rows={3} maxLength={2000} value={reply} onInput={(e) => setReply(e.currentTarget.value)} />
            <span class="counter mono">{reply.length} / 2000</span>
          </label>
        </>
      );
      actions = (
        <>
          <Button variant="primary" disabled={busy || !text} onClick={() => onContinue({ reply: text })}>
            Send and continue
          </Button>
          {stop()}
        </>
      );
      break;
    }
  }

  return (
    <section class={`run-card paused${a.code === "QUESTION" ? " director" : ""}`} aria-labelledby="run-card-title">
      <h3 id="run-card-title" class={sameWords(HEADLINES[a.code], run.headline) ? "kt-sr" : "run-card-title"}>
        {HEADLINES[a.code]}
      </h3>
      <div class="run-card-body">{body}</div>
      <div class="run-card-actions">{actions}</div>
      {under && <p class="run-card-under">{under}</p>}
    </section>
  );
}

/** The director's plan, read-only: concept, then one row per generation line. */
function PlanTable({ plan }: { plan: NonNullable<NonNullable<RunState["attention"]>["plan"]> }) {
  return (
    <div class="plan">
      {plan.concept && <p class="plan-concept">{plan.concept}</p>}
      <div class="kt-scroll-x table-scroll">
        <table class="kt-table">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Operation</th>
              <th scope="col">Model</th>
              <th scope="col" class="num">
                Takes
              </th>
              <th scope="col" class="num">
                Video
              </th>
              <th scope="col" class="num">
                GPU min
              </th>
            </tr>
          </thead>
          <tbody>
            {plan.jobs.map((j) => (
              <tr key={j.line}>
                <td class="mono">{j.line}</td>
                <td>{j.operation}</td>
                <td>{j.profile}</td>
                <td class="num mono">{j.takes}</td>
                <td class="num mono">{j.video || "—"}</td>
                <td class="num mono">{fmtMin(j.minutes)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={5}>
                Total
              </th>
              <td class="num mono">{fmtMin(plan.totalMinutes)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
