import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never touch the user's real ~/.open-katana (timings, fonts, presets, projects).
// The home sits under the run's scratch root (tests/helpers/global-setup.ts), which teardown removes.
process.env.OPEN_KATANA_HOME ??= mkdtempSync(join(process.env.OPEN_KATANA_TEST_TMP ?? tmpdir(), "home-"));
