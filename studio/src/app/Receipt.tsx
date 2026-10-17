import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Estimate, LicenceNote } from "../../../src/app/types.js";
import { Link } from "./router.js";
import { Icon, Num, Popover } from "./ui.js";

/** Step 3 of the make rail: time, GPU minutes, Claude usage, caps and licences (spec §4.4). */
export interface ReceiptProps {
  estimate?: Estimate;
  loading: boolean;
  caps: { gpuMinutes: number; claudeUsd: number };
  commercial: boolean;
  clipsModel: "configured" | "wan22";
  compact?: boolean;
  onCaps(c: { gpuMinutes: number; claudeUsd: number }): void;
  onCommercial(v: boolean): void;
  onClipsModel(v: "configured" | "wan22"): void;
}

// ---------- licence copy ----------

/** "Qwen-Image 2.1" from "Qwen-Image 2.1 (identity keyframes, 25 steps)"; "MiniMax H3" from "MiniMax H3 image-to-video + 8-step turbo". */
export function shortModel(title: string): string {
  const head = title.split(/ \(| \+ /)[0]!.trim();
  const versioned = /^(.+?\b[A-Za-z]*\d+(?:\.\d+)?)\b/.exec(head);
  return versioned ? versioned[1]! : head;
}

/** One sentence per restricted licence, in the receipt's words (D9: never "personal use"). */
export function licenceCopy(l: LicenceNote): string {
  if (l.commercial === "no") return "non-commercial licence, not for paid or commercial work";
  if (/minimax h3/i.test(l.name) || l.profile.startsWith("minimax-h3"))
    return "not licensed for use in the US, EU, UK or South Korea, on your own GPU or on Comfy Cloud; attribution required";
  if (!l.note || l.note.startsWith("unverified")) return `${l.name}, licence unverified: check the model card`;
  const first = /^(.+?[.;])(\s|$)/.exec(l.note)?.[1] ?? l.note;
  return first.replace(/[.;]$/, "");
}

/** The shorter form for the approve dialog: "not licensed in the US, EU, UK or South Korea; attribution required". */
export function licenceShort(l: LicenceNote): string {
  if (/minimax h3/i.test(l.name) || l.profile.startsWith("minimax-h3")) return "not licensed in the US, EU, UK or South Korea; attribution required";
  return licenceCopy(l);
}

const restricted = (e: Estimate) => e.licences.filter((l) => l.commercial !== "yes");

/** Restricted licences not yet acknowledged: the approve dialog shows when this is non-empty (D10). */
export const unacknowledged = (e: Estimate | undefined): LicenceNote[] => (e ? restricted(e).filter((l) => !l.acknowledged) : []);

/** Where the GPU work runs, for "31–42 min on Comfy Cloud". */
export function gpuWhere(e: Estimate): string {
  if (e.gpu.where === "cloud") return "Comfy Cloud";
  if (e.gpu.where === "local") return "this computer";
  try {
    return new URL(e.gpu.target).host;
  } catch {
    return e.gpu.target || "your GPU";
  }
}

/** "counts toward your Claude Max plan" / "billed to your Anthropic API key". */
export function claudeBilling(e: Estimate): string {
  if (e.claude.auth === "subscription") return `counts toward your ${e.claude.plan ?? "Claude"} plan`;
  if (e.claude.auth === "api-key") return "billed to your Anthropic API key";
  return e.claude.note || "uses your Claude Code sign-in";
}

const pct = (u: number) => Math.round(u <= 1 ? u * 100 : u);

/** Lowest GPU cap the stepper allows: the low estimate, rounded up to the step. */
export const minGpuCap = (e: Estimate) => Math.max(5, Math.ceil(e.gpu.lowMin / 5) * 5);

// ---------- receipt ----------

export function Receipt(p: ReceiptProps) {
  const [editing, setEditing] = useState(false);
  const e = p.estimate;
  if (!e) {
    return (
      <div class="kt-receipt empty" aria-busy={p.loading}>
        <p class="kt-receipt-time">About — min</p>
        <dl class="kt-receipt-rows">
          <dt>GPU</dt>
          <dd>—</dd>
          <dt>Claude</dt>
          <dd>—</dd>
          <dt>Models</dt>
          <dd>—</dd>
        </dl>
      </div>
    );
  }

  const r = restricted(e);
  const jobs = e.jobs.reduce((s, j) => s + j.takes, 0);
  const keyframes = e.groups.find((g) => g.label === "Keyframes");
  const known = (profile: string) => e.licences.find((l) => l.profile === profile);
  const hasR2v = e.jobs.some((j) => j.operation === "clip.r2v");
  const low = (n: number) => Math.round(n);
  const gpuMin = minGpuCap(e);
  const belowHigh = p.caps.gpuMinutes < e.gpu.highMin || p.caps.claudeUsd < e.claude.highUsd;
  const setCaps = (c: Partial<ReceiptProps["caps"]>) => p.onCaps({ ...p.caps, ...c });

  return (
    <div class={`kt-receipt${p.loading ? " loading" : ""}${p.compact ? " compact" : ""}`} aria-busy={p.loading}>
      <div class="kt-receipt-top">
        <p class="kt-receipt-time">
          About <Num value={e.wall.lowMin} />–<Num value={e.wall.highMin} /> min
        </p>
        <button type="button" class="kt-link" aria-expanded={editing} aria-controls="caps-editor" onClick={() => setEditing(!editing)}>
          Edit caps
        </button>
      </div>

      {editing && (
        <div class="kt-caps" id="caps-editor">
          <Stepper label="GPU cap" value={p.caps.gpuMinutes} min={gpuMin} max={600} step={5} format={(v) => `${v} min`} onChange={(v) => setCaps({ gpuMinutes: v })} />
          <Stepper label="Claude cap" value={p.caps.claudeUsd} min={5} max={200} step={5} format={(v) => `$${v}`} onChange={(v) => setCaps({ claudeUsd: v })} />
          {belowHigh && <p class="kt-warn-text">The edit may pause and ask for more.</p>}
        </div>
      )}

      <dl class="kt-receipt-rows">
        <dt>GPU</dt>
        <dd>
          <span>
            <Num value={low(e.gpu.lowMin)} />–<Num value={low(e.gpu.highMin)} /> min on {gpuWhere(e)} · cap <Num value={p.caps.gpuMinutes} />
          </span>
          <span class="kt-receipt-note">{e.gpu.note}</span>
        </dd>

        <dt>Claude</dt>
        <dd>
          <span>
            ≈ <Num value={e.claude.lowUsd} prefix="$" />–<Num value={e.claude.highUsd} /> · {claudeBilling(e)} · cap <Num value={p.caps.claudeUsd} prefix="$" />
          </span>
          {e.claude.fiveHourUtilization !== undefined && pct(e.claude.fiveHourUtilization) > 70 && (
            <span class="kt-warn-text">Your Claude plan is at {pct(e.claude.fiveHourUtilization)}% of its 5-hour limit. The edit may pause until it resets.</span>
          )}
        </dd>

        <dt>Models</dt>
        <dd class="kt-models">
          {r.length === 0 ? (
            <span>All permissive licences.</span>
          ) : (
            r.map((l) => (
              <span key={l.profile}>
                {shortModel(l.title)} {l.role}: {licenceCopy(l)}.
              </span>
            ))
          )}
          {p.clipsModel === "wan22" && (
            <span>
              Clips: Wan 2.2 (Apache-2.0).{hasR2v ? " Reference clips still use MiniMax H3." : ""}{" "}
              <button type="button" class="kt-link" onClick={() => p.onClipsModel("configured")}>
                Undo
              </button>
            </span>
          )}
          {p.commercial && keyframes && (
            <span>
              Keyframes: {shortModel(keyframes.profileTitle)} ({known(keyframes.profile)?.name ?? "permissive licence"}).
            </span>
          )}
          <span class="kt-models-actions">
            {e.canUseWan22 && p.clipsModel === "configured" && (
              <button type="button" class="btn small" onClick={() => p.onClipsModel("wan22")}>
                Use Wan 2.2 for clips instead
              </button>
            )}
            {!p.compact && (
              <Popover label="Details" title="Models and licences">
                <ModelDetails e={e} />
              </Popover>
            )}
          </span>
        </dd>
      </dl>

      {e.warnings
        // The track row already says when the track is too short.
        .filter((w) => !["SHARED_CREDITS", "PLAN_WINDOW", "FIVE_HOUR", "TRACK_SHORT"].includes(w.code) && !e.gpu.note.includes(w.message))
        .map((w) => (
          <p key={w.code} class="kt-warn-text">
            {w.message}
          </p>
        ))}

      <label class="kt-check">
        <input type="checkbox" checked={p.commercial} onChange={(ev) => p.onCommercial(ev.currentTarget.checked)} />
        <span>This edit is for paid or commercial work</span>
      </label>

      {!p.compact && e.jobs.length > 0 && (
        <details class="kt-more kt-jobs">
          <summary>
            <Icon name="chevron" size={12} class="kt-caret" />
            See all <span class="mono">{jobs}</span> jobs
          </summary>
          <div class="kt-more-body kt-scroll-x">
            <table class="kt-table">
              <thead>
                <tr>
                  <th scope="col">Shot</th>
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
                {e.jobs.map((j) => (
                  <tr key={j.line}>
                    <td class="mono">{j.line}</td>
                    <td class="mono">{j.operation}</td>
                    <td>{shortModel(e.groups.find((g) => g.profile === j.profile)?.profileTitle ?? j.profile)}</td>
                    <td class="num mono">{j.takes}</td>
                    <td class="num mono">{j.videoSec ? `${j.videoSec} s` : "—"}</td>
                    <td class="num mono">{j.minutes.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

/** Every chosen model with its role and licence (the receipt's and approve dialog's Details). */
export function ModelDetails({ e }: { e: Estimate }) {
  const rows = e.groups.filter((g) => g.profile);
  return (
    <div class="kt-model-details">
      <table class="kt-table">
        <thead>
          <tr>
            <th scope="col">For</th>
            <th scope="col">Model</th>
            <th scope="col">Licence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const l = e.licences.find((x) => x.profile === g.profile);
            return (
              <tr key={g.profile}>
                <td>{g.label}</td>
                <td>{g.profileTitle}</td>
                <td>
                  {l?.url ? (
                    <a href={l.url} target="_blank" rel="noreferrer">
                      {l.name}
                      <Icon name="external" size={11} />
                    </a>
                  ) : (
                    (l?.name ?? "Permissive licence")
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="kt-fine">A summary, not legal advice. Check each licence before you post or sell an edit.</p>
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
  onChange(v: number): void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const down = clamp(Math.ceil(value / step) * step - step);
  const up = clamp(Math.floor(value / step) * step + step);
  return (
    <div class="kt-stepper" role="group" aria-label={label}>
      <span class="label">{label}</span>
      <button type="button" class="btn icon-btn" aria-label={`Lower the ${label.toLowerCase()} to ${format(down)}`} disabled={value <= min} onClick={() => onChange(down)}>
        −
      </button>
      <output class="mono" aria-live="polite">
        {format(value)}
      </output>
      <button type="button" class="btn icon-btn" aria-label={`Raise the ${label.toLowerCase()} to ${format(up)}`} disabled={value >= max} onClick={() => onChange(up)}>
        +
      </button>
    </div>
  );
}

// ---------- the button ----------

export interface MakeReason {
  text: string;
  /** A fix link after the reason ("Set up", "How", "See what's missing"). */
  link?: { href: string; label: string };
}

export interface MakeButtonProps {
  caps: { gpuMinutes: number; claudeUsd: number };
  /** Why the button can't be pressed yet, in priority order; the first is shown. */
  reason?: MakeReason;
  /** Estimate blockers replace the button with a fix row. */
  blockers?: Estimate["blockers"];
  busy?: boolean;
  onMake(): void;
  /** Called when the disabled button is pressed (e.g. to focus what's missing). */
  onBlocked?(): void;
  label?: string;
  children?: ComponentChildren;
}

/** MAKE MY EDIT with what it approves, why it can't start yet, and the privacy line. */
export function MakeButton({ caps, reason, blockers, busy, onMake, onBlocked, label = "Make my edit" }: MakeButtonProps) {
  if (blockers?.length) {
    return (
      <div class="kt-make">
        {blockers.map((b) => (
          <p key={b.code} class="kt-fix">
            <Icon name="warn" size={14} />
            <span>{b.message}</span>
            <Link class="btn small" href="/setup">
              {b.code === "MODELS_MISSING" ? "See what's missing" : (b.action ?? "Set up")}
            </Link>
          </p>
        ))}
      </div>
    );
  }
  const blocked = Boolean(reason) || Boolean(busy);
  return (
    <div class="kt-make">
      <button
        type="button"
        class="btn cta kt-make-btn"
        aria-disabled={blocked || undefined}
        aria-describedby="make-why"
        onClick={() => (reason ? onBlocked?.() : busy ? undefined : onMake())}
      >
        {busy ? "Starting…" : label}
      </button>
      <p class={`kt-make-why${reason ? " blocked" : ""}`} id="make-why">
        {reason ? (
          <>
            {reason.text}
            {reason.link && (
              <>
                {" · "}
                <Link href={reason.link.href}>{reason.link.label}</Link>
              </>
            )}
          </>
        ) : (
          <>
            Approves up to <span class="mono">{caps.gpuMinutes}</span> GPU min · <span class="mono">${caps.claudeUsd}</span> of Claude usage
          </>
        )}
      </p>
      <p class="kt-privacy">Your photos go only to your GPU provider (to make shots) and to Claude (to judge them).</p>
    </div>
  );
}
