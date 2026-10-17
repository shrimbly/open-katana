import { useEffect, useState } from "preact/hooks";
import { Button, Chip, Sheet } from "./ui.js";

/**
 * Ask the director for changes (spec §4.9): one plain request, sent as a `reply` that continues the same
 * run; the result becomes the next version. The director's caps are topped up by the server's defaults.
 */
export interface ChangesSheetProps {
  open: boolean;
  /** The director's known issues, so "Fix the issues you noted" only shows when there are some. */
  issues: string[];
  busy: boolean;
  onClose(): void;
  onSend(reply: string): void;
}

const CHIPS = ["Bigger words", "Faster cuts", "Swap the opening shot"];

export function ChangesSheet({ open, issues, busy, onClose, onSend }: ChangesSheetProps) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const add = (chip: string) => setText((t) => (t.trim() ? `${t.trim().replace(/[.,]?$/, ".")} ${chip}.` : `${chip}.`));
  const chips = issues.length ? [...CHIPS, "Fix the issues you noted"] : CHIPS;
  const reply = text.trim();

  return (
    <Sheet open={open} title="Ask the director for changes" onClose={onClose}>
      <div class="changes-sheet">
        <label class="field-block">
          <span class="kt-field-label">What should change?</span>
          <textarea
            class="kt-input kt-textarea"
            rows={5}
            maxLength={2000}
            value={text}
            placeholder="Say it like you'd tell an editor: 'make the spin cleaner, end on the throne'"
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </label>
        <div class="chip-row">
          {chips.map((c) => (
            <Chip key={c} onClick={() => add(c)}>
              {c}
            </Chip>
          ))}
        </div>
        <p class="receipt-compact">Uses the director (about $1–3). GPU time only if shots are re-made: up to 10 more min.</p>
        <div class="sheet-actions">
          <span class="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !reply} onClick={() => onSend(reply)}>
            Send to the director
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
