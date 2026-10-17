import { useEffect, useState } from "preact/hooks";
import { ApiError, app } from "./api.js";
import { navigate } from "./router.js";
import { Button, Sheet, toast } from "./ui.js";

/**
 * Save as template (spec §4.9, D20): a delivered edit of a decoded video becomes a reusable shot list.
 * Deterministic and instant on the server (`POST /api/templates {fromProject}`); the new template opens.
 */
export interface SaveTemplateSheetProps {
  open: boolean;
  project: string;
  defaultTitle: string;
  /** From the page data; when not ok, `reason` says why (e.g. frames of the original video). */
  can: { ok: boolean; reason?: string };
  /** The edit plays the decoded video's own sound (it gets the third-party track line). */
  originalSound: boolean;
  onClose(): void;
}

export function SaveTemplateSheet({ open, project, defaultTitle, can, originalSound, onClose }: SaveTemplateSheetProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle);
    setDescription("");
    setError(undefined);
  }, [open]);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const t = await app.saveTemplate({ fromProject: project, title: title.trim(), description: description.trim() || undefined });
      onClose();
      navigate(`/t/${encodeURIComponent(t.slug)}`);
    } catch (e) {
      const err = e as ApiError;
      const reasons = Array.isArray(err.body?.reasons) ? (err.body.reasons as string[]) : [];
      setError(reasons.length ? reasons.join(" ") : err.message);
      if (!(e instanceof ApiError)) toast(err.message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title="Save as a template" onClose={onClose}>
      <div class="save-template">
        <p>Your cut becomes a reusable shot list: the generated shots become slots, your words become the default text, and the timing stays exactly as it is.</p>
        <label class="field-block">
          <span class="kt-field-label">Title</span>
          <input class="kt-input" value={title} maxLength={80} disabled={!can.ok} onInput={(e) => setTitle(e.currentTarget.value)} />
        </label>
        <label class="field-block">
          <span class="kt-field-label">One-line description</span>
          <input class="kt-input" value={description} maxLength={160} disabled={!can.ok} onInput={(e) => setDescription(e.currentTarget.value)} />
        </label>
        {originalSound && <p class="kt-fine">The original sound stays on this computer as the template's track. It isn't yours to publish.</p>}
        {!can.ok && can.reason && <p class="form-note">{can.reason}</p>}
        {error && <p class="kt-error">{error}</p>}
        <div class="sheet-actions">
          <span class="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!can.ok || busy || !title.trim()} onClick={() => void save()}>
            Save template
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
