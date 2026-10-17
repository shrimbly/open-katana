import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Take } from "../../../src/app/types.js";
import { app } from "./api.js";
import { reducedMotion } from "./flash.js";
import { Button, toast, useLayer } from "./ui.js";

/**
 * One take, large (spec §4.10): the still or clip, the identity panel the director judged it with, the
 * director's verdict and reason, and **Use this take**. ←/→ step through the takes of the same line; Esc
 * closes and focus returns to the tile that opened it. During a run the pick goes to the director; after
 * one (the result page's takes) it is swapped into the cut, and the toast offers **Update video**.
 */
export interface TakeLightboxProps {
  project: string;
  takes: Take[];
  /** The take shown; undefined closes the lightbox. */
  asset?: string;
  /** A run holds the project: picks go to the director instead of the edit. */
  running: boolean;
  onAsset(asset: string | undefined): void;
  /** A pick was saved (the page reads the takes again, so the tile shows YOUR PICK). */
  onPicked?(): void;
  /** The toast's Update video: render a new version from the edited cut. */
  onUpdateVideo?(): void;
}

export function TakeLightbox({ project, takes, asset, running, onAsset, onPicked, onUpdateVideo }: TakeLightboxProps) {
  const take = takes.find((t) => t.asset === asset);
  const siblings = take ? takes.filter((t) => t.line === take.line && t.state === "ready") : [];
  const at = take ? siblings.indexOf(take) : -1;
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  // On the commit that draws it, so an Esc right after opening still returns focus to the tile.
  useLayoutEffect(() => {
    if (!take) return;
    opener.current ??= document.activeElement;
    box.current?.querySelector<HTMLElement>(".lightbox-close")?.focus();
  }, [Boolean(take)]);

  const close = () => {
    onAsset(undefined);
    (opener.current as HTMLElement | null)?.focus?.();
    opener.current = null;
  };

  // Esc closes it and Tab stays inside (the app's layer stack, ui.tsx), from the moment it is drawn.
  useLayer(Boolean(take), close, box);
  useLayoutEffect(() => {
    if (!take) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !(e.target as HTMLElement).closest("input, textarea")) {
        e.preventDefault();
        const next = siblings[at + (e.key === "ArrowLeft" ? -1 : 1)];
        if (next) onAsset(next.asset);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (!take) return null;
  const v = take.verdict;
  const yours = v?.by === "you" && v.verdict === "accept";

  const use = async () => {
    setBusy(true);
    try {
      const r = await app.pick(project, { line: take.line, asset: take.asset });
      const update = onUpdateVideo ?? (() => void app.exportProject(project).catch((e: Error) => toast(e.message, { error: true })));
      if (running) toast("Your pick. The director will use it.");
      else if (r.edlChanged) toast("Your pick is in the edit.", { action: { label: "Update video", onClick: update } });
      // Not in the cut (say, a keyframe whose clip is what the cut shows): it waits for the director's next go.
      else toast("Your pick is saved. The director will use it next time.");
      onPicked?.();
      close();
    } catch (e) {
      toast((e as Error).message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="lightbox" role="dialog" aria-modal="true" aria-label={`Take ${take.asset}`} onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="lightbox-box" ref={box}>
        <div class="lightbox-head">
          <span class="mono">{take.asset}</span>
          {siblings.length > 1 && (
            <span class="mono lightbox-count">
              {at + 1} / {siblings.length}
            </span>
          )}
          <span class="spacer" />
          <Button variant="ghost" size="small" class="lightbox-close" aria-label="Close" onClick={close}>
            Close
          </Button>
        </div>
        <div class={`lightbox-media${take.panel ? " with-panel" : ""}`}>
          {take.kind === "clip" || take.kind === "matte" ? (
            <video key={take.asset} src={take.url} poster={take.thumb} muted loop autoPlay={!reducedMotion()} playsInline controls />
          ) : (
            <img key={take.asset} src={take.url ?? take.thumb} alt={`Take ${take.asset}`} />
          )}
          {take.panel && (
            <figure class="lightbox-panel">
              <img src={take.panel} alt="Identity panel: this take next to your face photo" />
              <figcaption class="label">Checked against your photo</figcaption>
            </figure>
          )}
        </div>
        <div class="lightbox-foot">
          <div class="lightbox-verdict">
            {yours ? (
              <span class="take-chip pick">YOUR PICK</span>
            ) : v ? (
              <>
                <span class="label">The director</span>
                <span class={`verdict ${v.verdict}`}>
                  {v.verdict === "accept" ? "Kept" : "Passed"}
                  {v.reason ? ` · ${v.reason}` : ""}
                </span>
              </>
            ) : (
              <span class="label">Not judged yet</span>
            )}
          </div>
          <div class="lightbox-nav">
            <Button variant="ghost" size="small" aria-label="Previous take" disabled={at <= 0} onClick={() => onAsset(siblings[at - 1]!.asset)}>
              ←
            </Button>
            <Button variant="ghost" size="small" aria-label="Next take" disabled={at < 0 || at >= siblings.length - 1} onClick={() => onAsset(siblings[at + 1]!.asset)}>
              →
            </Button>
          </div>
          <Button variant="primary" disabled={busy || yours || take.state !== "ready"} onClick={() => void use()}>
            Use this take
          </Button>
        </div>
      </div>
    </div>
  );
}
