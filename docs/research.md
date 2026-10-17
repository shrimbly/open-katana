# Research notes: Higgsfield Katana and open-katana

> open-katana is an independent open-source project. It is not affiliated with, endorsed by or
> sponsored by Higgsfield AI. Higgsfield and Katana are trademarks of their respective owners.

These notes were written in October 2026, shortly after Higgsfield launched Katana (2026-10-08).
They draw only on public material: Higgsfield's blog and help center, the public preset catalog at
higgsfield.ai/katana, and about 25 creator videos that show Katana in use. They describe the product
as a user sees it, in our own words, and explain the choices open-katana makes. open-katana contains
no Higgsfield code, prompts, presets or media.

## What Katana is

Katana is not a model. It is an **agent workflow** that runs inside Claude, connected through
Higgsfield's MCP server:

- The user types `/katana`, picks a preset or brings a reference edit, and adds photos of their
  subject.
- Claude does the creative work: it reads the reference, writes the plan, the prompts and the edit,
  and judges every result.
- Higgsfield provides everything else as a hosted service: its own image and video models, media
  storage, credits and billing, and the cloud compute that analyses and assembles the edit.

## What users see

- A gallery of presets inside the chat. Each preset has a looping preview, a short form (photos,
  optional instructions) and a button that starts the run.
- The same presets in the web catalog, which opens Claude with the run ready to start.
- Short status lines while it works, a cost summary to approve before anything is generated, and a
  result player with a download at the end.
- In creator videos, a 10–30 s edit takes roughly 20–40 minutes and is paid for in Higgsfield
  credits.

## The ideas we kept

Higgsfield's public material describes a handful of principles. open-katana keeps the principles and
builds each one its own way:

| Principle | How open-katana does it |
|---|---|
| Read the whole reference, not a summary | `katana_analyze` puts every native frame on stamped review pages, each with a check code; `katana_generate` stays locked until every page is logged with its code. |
| Keep the reference's energy | Cuts, one-frame inserts, flashes, camera moves, shake, punches and beats are measured; `katana_render` re-measures the output and reports any rate below 0.6× the reference's (or too much shake). |
| Remix by default | The reference contributes its visual language; scenes are new. A `recreate` mode copies the cut map shot for shot when the user asks for it. |
| Keyframe first | One accepted hero still anchors every later still; each new location gets its own empty plate; clips start from accepted stills. |
| Approve spend before generating | `katana_plan` estimates GPU minutes from recorded timings; nothing runs until the user approves, and a project budget caps everything submitted. |
| Deterministic assembly | An ffmpeg renderer with libass type, recorded music and sound effects, and a QA pass on the delivered file. |
| Cheap refinement | Text, timing, music and reframes re-render from cached shots in seconds. |

## Where open-katana differs

| | Katana | open-katana |
|---|---|---|
| Where it runs | Inside Claude, through Higgsfield's hosted MCP server | Any MCP client; the server runs on your machine |
| Generation | Higgsfield's hosted models, paid in credits | Your ComfyUI (local, a remote GPU or Comfy Cloud) with open-weights models, each under its own licence |
| Analysis and editing | Hosted by Higgsfield | Your machine, free: ffmpeg and TypeScript, a shot renderer with a sub-pixel `perspective` camera and libass type |
| Tools | Higgsfield's hosted toolset | 18 focused tools (plus an app-only upload tool) |
| Spend | Credit quotes | A GPU-minute estimate, your approval and a project cap |
| People in motion transfer | Higgsfield's own models | Wan 2.2 Fun Control driven by pose skeletons, so the identity stays the user's |
| Presets | Higgsfield's catalog | Built-in templates and recipes, plus your own presets with reference videos |
| Source | Proprietary hosted service | MIT |

## Our presets

The three templates are original recipes for common edit styles:

- `night-stare`: a lone-figure night aura edit in 4:3, with a cold teal and sodium-green grade,
  black-and-white inserts and uncanny eye beats.
- `hype-energy`: an understated-to-hype character edit on a tight beat grid, with whip and spin
  landings, a stacking photo-card collage and a flash-cut drop with giant stacked words and cloned
  tiles.
- `iron-mindset`: a black-and-white athlete mindset montage with a spoken-word intro, giant
  translucent numerals, colour kept in grey frames, duotone accents and split screens.

Each one has a fixed cut map, slots for the shots the user's material must supply, and an edit
skeleton the agent fills (`katana_edit` with `fromPreset`). The four style recipes (`cold-stare`,
`golden-hour`, `neon-rain`, `phonk-velocity`) describe structure, energy, look and type only.

Building the templates drove most of the renderer's compositing work, because these styles are made
in the edit, not in the model: picture-in-picture collages, clone and mirror tiles, subjects over
black, iris masks, regional windows, x-ray blend overlays, duotone and one-colour grades,
frame-locked strobes, tinted flashes over the titles, glitch and blur text exits, translucent
monument numerals, and real bold and italic faces.

## Lessons from building it

- The edit carries the energy, not the generator. Wan clips are calm; punches, shake, flashes and
  speed ramps make the edit hot.
- Beat trackers miss some grids. Edits in these styles are often cut to a tempo 4:3 away from the
  audio estimate, so analysis checks its tempo against the reference's own cuts, and an EDL can
  override the grid.
- Edge-map control copies the source performer's face and logos into motion-transfer shots. Pose
  skeletons keep the user's identity; depth leaks it at the start of the clip.
- A reference frame with a person in it leaks that person into keyframes. Stills are judged next
  to the subject photo, and face close-ups never use a reference frame as an input.
- Qwen-Image-Edit re-composes freely: say explicitly when framing must be kept.
- A glow screen blend done in YUV tints shots magenta; blends run in planar RGB.
- Glow pulses and exposure flashes look like cuts to histogram detectors; normalized
  cross-correlation separates "same picture, new tone" from a real cut.
- Comfy Cloud cannot feed uploaded videos to `LoadVideo`; animated WebP through `LoadImage` works
  everywhere.
- Using the tool on real briefs found two gaps, both fixed: reference frames can be generation
  inputs (`"ref@f42"` / `"ref@2.1"`), and `katana_view` target `render-pages` shows every frame of
  a render instead of a sampled sheet.
