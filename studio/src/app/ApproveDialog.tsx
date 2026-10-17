import { useEffect, useState } from "preact/hooks";
import type { Estimate } from "../../../src/app/types.js";
import { gpuWhere, licenceShort, ModelDetails, shortModel, unacknowledged } from "./Receipt.js";
import { refreshSettings, saveSettings } from "./Shell.js";
import { Button, Dialog, Popover, toast } from "./ui.js";

/**
 * "Before your first edit" (spec §4.5): shown when a model with a restricted licence appears for the
 * first time (D10). It says what Make my edit starts and what it can spend, and asks once for the
 * licence acknowledgement; ticking stores those profiles in the app settings.
 */
export interface ApproveDialogProps {
  open: boolean;
  estimate: Estimate;
  caps: { gpuMinutes: number; claudeUsd: number };
  busy?: boolean;
  onClose(): void;
  /** Called after the acknowledgement is saved. */
  onConfirm(): void;
}

function directorWho(e: Estimate): string {
  if (e.claude.auth === "subscription") return `Claude Code, signed in with ${e.claude.plan ?? "your Claude plan"}`;
  if (e.claude.auth === "api-key") return "Claude Code, using your Anthropic API key";
  return "Claude Code";
}

function gpuWho(e: Estimate): string {
  if (e.gpu.where === "cloud") return "Comfy Cloud";
  if (e.gpu.where === "local") return "this computer's ComfyUI";
  return `ComfyUI on ${gpuWhere(e)}`;
}

export function ApproveDialog({ open, estimate: e, caps, busy, onClose, onConfirm }: ApproveDialogProps) {
  const [ticked, setTicked] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setTicked(false);
  }, [open]);
  const notes = unacknowledged(e);

  const confirm = async () => {
    if (!ticked || saving) return;
    setSaving(true);
    try {
      const current = (await refreshSettings())?.licencesAcknowledged ?? [];
      await saveSettings({ licencesAcknowledged: [...new Set([...current, ...notes.map((l) => l.profile)])] });
      onConfirm();
    } catch (err) {
      toast(`Couldn't save the licence note: ${(err as Error).message}`, { error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Before your first edit"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" disabled={!ticked || saving || busy} onClick={confirm}>
            Make my edit
          </Button>
        </>
      }
    >
      <p>“Make my edit” starts two things:</p>
      <ol class="kt-approve-list">
        <li>
          <span class="kt-approve-n mono">1</span>
          <p>
            The director ({directorWho(e)}) plans the shots, judges every take against your photo and cuts the edit. About{" "}
            <span class="mono">
              ${Math.round(e.claude.lowUsd)}–{Math.round(e.claude.highUsd)}
            </span>{" "}
            of usage. It stops at <span class="mono">${caps.claudeUsd}</span>.
          </p>
        </li>
        <li>
          <span class="kt-approve-n mono">2</span>
          <p>
            Your GPU ({gpuWho(e)}) makes the stills and clips. About{" "}
            <span class="mono">
              {Math.round(e.gpu.lowMin)}–{Math.round(e.gpu.highMin)}
            </span>{" "}
            GPU min. It stops at <span class="mono">{caps.gpuMinutes}</span>.
          </p>
        </li>
      </ol>
      <p class="kt-ash">Your photos go only to your GPU provider and to Claude.</p>
      {notes.length > 0 && (
        <>
          <h3 class="label kt-approve-h">Model licences</h3>
          <ul class="kt-approve-licences">
            {notes.map((l) => (
              <li key={l.profile}>
                <strong>{shortModel(l.title)}</strong> · {l.role} · {licenceShort(l)}
              </li>
            ))}
          </ul>
          <Popover label="Details" title="Models and licences">
            <ModelDetails e={e} />
          </Popover>
          <label class="kt-check kt-approve-tick">
            <input type="checkbox" checked={ticked} onChange={(ev) => setTicked(ev.currentTarget.checked)} data-autofocus />
            <span>I'll use edits made with these models within their licences.</span>
          </label>
        </>
      )}
    </Dialog>
  );
}
