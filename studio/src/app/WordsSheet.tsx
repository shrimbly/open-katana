import { useEffect, useState } from "preact/hooks";
import type { ProjectPageData } from "../../../src/app/types.js";
import { app, MOCK } from "./api.js";
import { Link } from "./router.js";
import { Button, Sheet, toast } from "./ui.js";
import { fmtTime } from "./beat.js";
import type { ExportState } from "./useRun.js";

/**
 * Change the words (spec §4.9): every text card of the cut with its time and an input set in the card's
 * own font. Update writes the EDL (text only) and exports a new version: no GPU, no Claude.
 */
export interface WordsSheetProps {
  open: boolean;
  project: string;
  words: NonNullable<ProjectPageData["words"]>;
  /** The project channel's latest export event, for the inline progress. */
  exporting?: ExportState;
  onClose(): void;
}

export function WordsSheet({ open, project, words, exporting, onClose }: WordsSheetProps) {
  const [values, setValues] = useState<Record<number, string>>({});
  const [phase, setPhase] = useState<"edit" | "saving" | "rendering">("edit");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setValues(Object.fromEntries(words.map((w) => [w.index, w.text])));
    setPhase("edit");
    setError(undefined);
    // The editor's font loader (same files as the renderer), loaded with the editor's chunk.
    void import("../fonts.js").then((f) => f.loadTextFaces(words));
  }, [open]);

  // The export finished (or failed) while this sheet waited for it.
  useEffect(() => {
    if (phase !== "rendering" || !exporting) return;
    if (exporting.state === "done") {
      toast(`Saved as v${exporting.version ?? ""}`.trim());
      onClose();
    } else if (exporting.state === "error") {
      setPhase("edit");
      setError(exporting.error ?? "The render failed. Your words are saved; try Update video again.");
    }
  }, [exporting, phase]);

  const changed = words.filter((w) => (values[w.index] ?? w.text) !== w.text);
  const empty = words.some((w) => !(values[w.index] ?? "").trim());

  const update = async () => {
    setPhase("saving");
    setError(undefined);
    try {
      if (MOCK) {
        setPhase("rendering");
        setTimeout(() => {
          toast("Saved as v2");
          onClose();
        }, 900);
        return;
      }
      const { api } = await import("../api.js");
      const state = await api.project(project);
      if (!state.edl) throw new Error("This edit has no cut yet.");
      const edl = structuredClone(state.edl);
      for (const w of changed) {
        const card = edl.text[w.index];
        if (card) card.text = (values[w.index] ?? w.text).trim();
      }
      await app.saveEdl(project, edl);
      await app.exportProject(project);
      setPhase("rendering");
    } catch (e) {
      setPhase("edit");
      setError((e as Error).message);
    }
  };

  const progress = phase === "rendering" && exporting?.state === "rendering" && exporting.total ? `Rendering ${exporting.done ?? 0} / ${exporting.total}` : phase === "edit" ? undefined : "Rendering…";

  return (
    <Sheet open={open} title="Change the words" onClose={onClose}>
      <div class="words-sheet">
        <ol class="word-rows">
          {words.map((w) => (
            <li key={w.index} class="word-row">
              <span class="mono word-time">{fmtTime(w.startSec)}</span>
              <input
                class="kt-input word-input"
                aria-label={`Card at ${fmtTime(w.startSec)}`}
                value={values[w.index] ?? w.text}
                disabled={phase !== "edit"}
                maxLength={80}
                style={{ fontFamily: `"${w.font}", var(--ui)`, fontWeight: w.weight, fontStyle: w.italic ? "italic" : "normal", textTransform: w.uppercase ? "uppercase" : "none" }}
                onInput={(e) => setValues((v) => ({ ...v, [w.index]: e.currentTarget.value }))}
              />
            </li>
          ))}
        </ol>
        <p class="kt-fine">Size, timing and style stay the same.</p>
        <Link class="more-link" href={`/edit/${encodeURIComponent(project)}`}>
          More control in the editor ↗
        </Link>
        {error && <p class="kt-error">{error}</p>}
        <div class="sheet-actions">
          {progress && (
            <span class="mono sheet-progress" role="status">
              {progress}
            </span>
          )}
          <span class="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={phase !== "edit" || !changed.length || empty} onClick={() => void update()}>
            Update video
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
