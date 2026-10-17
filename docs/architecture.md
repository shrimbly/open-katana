# Architecture

open-katana has three tiers, mirroring how reference-edit remixing works in practice:

1. **The agent** (Claude, following `skills/katana/SKILL.md`) is the director. It reads every
   frame, writes the plan and the edit, and judges every generated result.
2. **The MCP server** (`src/server`) is the crew. It exposes 18 focused tools plus one app-only
   upload tool, three MCP Apps widgets, a `katana` prompt and project media as resources.
3. **ComfyUI** (local, remote GPU or Comfy Cloud) does the generation. Everything else — analysis,
   editing, QA — runs locally with ffmpeg and TypeScript.

## Modules

| Path | Role |
|---|---|
| `src/engine/` | Reference analysis. `frames.ts` decodes every native frame at 128 px; `cuts.ts` detects hard cuts, flash-hidden cuts, dissolves, one-frame inserts, white/black flashes and tonal pulses (normalized cross-correlation keeps glow pulses from counting as cuts); `motion.ts` estimates global similarity motion per frame with two-level block matching, Shi–Tomasi texture gating, zero-biased tie breaking and parabolic sub-pixel refinement; `audio.ts` computes a spectral-flux onset envelope, autocorrelation tempo with a log-normal prior and a dynamic-programming beat tracker; `energy.ts` turns all of it into camera-move, shake, punch, flash, hit and cut events plus per-second rates; `sheets.ts` renders stamped every-frame review pages (shot, frame, time and a per-page check code). |
| `src/comfy/` | Generation. `operations.ts` holds the profiles (with each model's licence) and builds API-format graphs in code (derived from the official ComfyUI templates); `resolve.ts` matches model files across precision variants and checks a profile against `object_info`; `backend.ts` talks to ComfyUI (`http`), Comfy Cloud (`cloud`, API key) or the comfy CLI (`comfy-cli`); `jobs.ts` uploads inputs once per backend, cuts control clips from reference shots as animated WebP, submits, polls, downloads and records timings for future estimates. |
| `src/render/` | The editor. `edl.ts` is the edit schema (seconds, `b<n>` beats, `f<n>` frames); `expr.ts` compiles camera moves into one `perspective` transform per shot (sub-pixel zoom, pan, roll, punches, shake, handheld with automatic overscan) and effects into ffmpeg filters; `ass.ts` compiles text into libass scripts with animated override tags; `render.ts` renders each shot to an exact frame count (cached by content hash), then a finish pass adds the look, grain, vignette, letterbox, timeline flashes, text and the soundtrack; `qa.ts` checks frame count, size and audio and re-measures the output's energy against the reference; `deliver.ts` writes the size-capped deliverable. |
| `src/project/` | A project is a directory: `project.json` (assets, stage, review log, versions), `media/`, `analysis/`, `plan/` (plan, estimate, jobs, uploads), `gen/`, `qa/` (sheets, verdicts), `render/` (EDL, cache, renders) and `deliver/`. |
| `src/presets/` | Built-in recipes (`presets/*/preset.json`) and the user library (`~/.open-katana/presets`). |
| `src/server/` | Tool registrations by stage, widget resources, media resources. |
| `src/studio/` + `studio/` | The studio: a local HTTP server (project state, EDL saves with validation, thumbnails, waveforms, ranged media, background renders with progress over server-sent events, file watching so agent edits appear live) and a Preact timeline editor. Text is drawn live on a canvas over a picture-only render, using each font's OS/2 metrics so it matches libass; every other change re-renders the picture from the shot cache. Pure edit operations (roll trims with anchored in-points, splits that carry clip position, zoom and edge effects across the cut) live in `studio/src/edits.ts`. |
| `ui/` | MCP Apps widgets (vanilla TypeScript, built to single HTML files): result player, preset gallery with a start form, estimate card. |

## Gates

The server enforces the parts of the workflow that matter most for quality and spend:

- `katana_generate` refuses to run until every review page is logged with its correct check code
  (proof that each frame was actually looked at), and until the user approved the estimate.
- A project budget (GPU minutes) caps everything submitted.
- With `commercial: true` in the config, model defaults skip non-commercial profiles, and
  `katana_backend` and `katana_plan` report licence warnings.
- `katana_edit` warns when a shot uses a rejected asset or a clip's recorded bad range.
- `katana_render` reports the energy check; `katana_deliver` refuses a stale master.

## Why ffmpeg instead of a browser compositor

The edits that matter here (aura, velocity and character edits) are built from cuts, camera work,
speed changes, flashes, grades and type. ffmpeg covers all of these deterministically and fast:
a 4-second 1080×810 edit with five shots renders in under 3 s, and a text-only change re-renders
in under 1 s from the shot cache. Matte-based layers (text behind the subject) use BiRefNet mattes
from ComfyUI.
