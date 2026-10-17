import { useEffect, useState } from "preact/hooks";
import type { RunDiagnostics } from "../../../src/app/types.js";
import { app } from "./api.js";
import { fmtUsd } from "./beat.js";
import { Button, Sheet, toast } from "./ui.js";

/**
 * Details of a failed run (spec §4.8): the last 40 lines of the director's stderr (environment values
 * already redacted by the server), exit code or signal, session id and attempts, plus Copy diagnostics.
 */
export function DiagnosticsSheet({ runId, open, onClose }: { runId: string; open: boolean; onClose(): void }) {
  const [d, setD] = useState<RunDiagnostics>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setError(undefined);
    app.diagnostics(runId).then(setD, (e: Error) => setError(e.message));
  }, [open, runId]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ run: runId, ...d }, null, 2));
      toast("Diagnostics copied.");
    } catch {
      toast("Couldn't copy. Select the text and copy it by hand.", { error: true });
    }
  };
  const ended = d?.signal ? `Signal ${d.signal}` : d?.exitCode !== undefined && d.exitCode !== null ? `Exit code ${d.exitCode}` : "No exit code";

  return (
    <Sheet open={open} title="Details" onClose={onClose}>
      {error && <p class="kt-error">{error}</p>}
      {d && (
        <div class="diagnostics">
          <dl class="facts">
            <dt>Ended</dt>
            <dd class="mono">{ended}</dd>
            <dt>Session</dt>
            <dd class="mono">{d.sessionId}</dd>
            <dt>Attempts</dt>
            <dd class="mono">{d.attempts.length}</dd>
          </dl>
          {d.attempts.length > 0 && (
            <div class="kt-scroll-x table-scroll">
              <table class="kt-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Why</th>
                    <th scope="col">Started</th>
                    <th scope="col" class="num">
                      Exit
                    </th>
                    <th scope="col" class="num">
                      Turns
                    </th>
                    <th scope="col" class="num">
                      Claude
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.attempts.map((a) => (
                    <tr key={a.n}>
                      <td class="mono">{a.n}</td>
                      <td>{a.reason}</td>
                      <td class="mono">{new Date(a.startedAt).toLocaleTimeString()}</td>
                      <td class="num mono">{a.signal ?? a.exitCode ?? "—"}</td>
                      <td class="num mono">{a.turns ?? "—"}</td>
                      <td class="num mono">{a.costUsd !== undefined ? fmtUsd(a.costUsd) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.warnings.length > 0 && (
            <ul class="warnings">
              {d.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <span class="label">Last lines from Claude Code</span>
          <pre class="stderr mono" tabIndex={0}>
            {d.stderrTail.length ? d.stderrTail.slice(-40).join("\n") : "(nothing written)"}
          </pre>
          <div class="sheet-actions">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" onClick={() => void copy()}>
              Copy diagnostics
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
