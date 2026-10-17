import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One scratch root per test run. tempDir() and each test file's data home are created under it,
 * and teardown removes it, so runs leave nothing behind in $TMPDIR.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "ok-test-run-"));
  process.env.OPEN_KATANA_TEST_TMP = root;
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
