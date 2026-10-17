# Authoring templates

A template is a preset folder. Built-in ones live in `presets/<slug>/` in this repo; templates you
save from the app live in `~/.open-katana/presets/<slug>/` and shadow a built-in with the same slug.

```
presets/hype-energy/
  preset.json      the template (required)
  example.mp4      an example render, web size (optional)
  poster.jpg       its poster frame (required with an example)
  cutmap.json      the example's cut map (optional)
  soundtrack.m4a   the track the skeleton is timed to (optional)
```

There are two kinds, and the app shows which:

- **Shot-for-shot**: `slots` and a `skeleton` (an [EDL](edl.md) whose sources are `"slot:<id>"`).
  The director makes one generation line per slot and fills the skeleton with
  `katana_edit fromPreset`. `night-stare`, `hype-energy` and `iron-mindset` are shot-for-shot.
- **Freestyle**: only a `recipe` (look, energy, structure, type, music). The director writes the
  shot list from it each time. `cold-stare`, `golden-hour`, `neon-rain` and `phonk-velocity` are
  freestyle.

The rest of this page covers the fields the app reads. `tests/presets.test.ts` checks every rule
below for the built-in templates, so run `pnpm test` after any change.

## `display`: the title style

Each template's title is set in its own edit font on its tile and page, and the brief's word fields
use the same style.

```json
"display": { "font": "League Gothic", "weight": 400, "italic": true, "case": "upper", "color": "#FEFBF3" }
```

| Field | Meaning |
|---|---|
| `font` | A Google Fonts family (the renderer downloads it on first use). Use the skeleton's main title font. |
| `weight` | 100–900, default 400. |
| `italic` | Default false. |
| `case` | `upper`, `lower` or `as-typed`. |
| `color` | `#rrggbb`. Shown at 28 px or larger on near-black, so it needs 3:1 contrast against `#0b0c0d`. |

## `timing`

```json
"timing": { "dropBeat": 18, "nominalBpm": 120 }
```

- `dropBeat`: the beat of the big moment. When the person brings their own track, the app starts
  it so its drop lands on this beat ("We'll start it at 0:38.9 so the drop hits the big moment").
  Use a whole beat so every beat of the edit lands on a beat of their track.
- `nominalBpm`: the tempo to assume when the skeleton has no `grid` (for the cut map and
  estimates). A skeleton with a grid doesn't need it.

## `brief`: what the person is asked

The brief is the template's "prompt": the words and choices the app asks for, each prefilled so
nothing has to be typed. The app writes the answers to `plan/brief.json` before the director
starts, and `katana_edit fromPreset` applies them (words, colours, grid, length and sound). The
director never retypes the person's words: in app runs `katana_edit` refuses an edit that changes
them.

```json
"brief": [
  { "id": "who", "label": "Who are you, plainly?", "help": "Plain on purpose: the drop flips it. Up to 13 letters so it fits the frame.",
    "kind": "text", "binds": [{ "index": 0 }], "default": "NOTHING NEW", "maxChars": 13,
    "suggestions": ["NEW IN TOWN", "NINE TO FIVE", "QUIET ONE", "BACK ROW KID"] },
  { "id": "drop", "label": "Two words that slam in on the drop", "kind": "words",
    "binds": [{ "index": 3 }, { "index": 4 }], "default": ["BORN", "DIFFERENT"], "maxChars": 9,
    "suggestions": [["BUILT", "DIFFERENT"], ["MAIN", "EVENT"]] },
  { "id": "place", "label": "Where's your everyday?", "kind": "text", "default": "a rooftop car park", "maxChars": 60,
    "prompt": "Place: {value}, the whole edit happens here, soft overcast daylight." }
]
```

| Field | Meaning |
|---|---|
| `id` | `^[a-z][a-z0-9_]{0,31}$`, unique in the brief. |
| `label`, `help` | What the person reads. Second person, short, no exclamation marks. |
| `kind` | `text` (one string), `words` (a list, one entry per card), `choice` (one of `options`), `color` (`#rrggbb`) or `toggle` (true or false). |
| `required` | The button stays disabled until it is filled in ("Fill in: Your name, for the closing card"). Default false. |
| `default` | The prefilled value. |
| `placeholder` | Shown when empty; also the value used when there is no default (`briefDefaults`). |
| `suggestions` | Up to 8 values the person can pick, or cycle through with **Surprise me**. For `words`, each suggestion is a list. |
| `maxChars` | Characters per entry. Size it to what fits the card at its font size: the renderer doesn't shrink text. |
| `binds` | Skeleton text cards this field writes, by index into `skeleton.text`. `format` wraps the value, such as `"{value}."`. A `text` field binds one card; a `words` field binds one card per entry, in order. |
| `count` | For `words` without binds: the most entries. |
| `verbatim` | Each entry must appear on some text card. Use it on freestyle templates, where the director writes the cards. |
| `options`, `allowOther` | For `choice`: the options, and whether free text is allowed. |
| `prompt` | A line for the director, with `{value}` replaced, e.g. `"Sport: {value}."`. Skipped when an optional field is empty. |
| `optionPrompts` | For `choice`: one line per option instead of `prompt`. |
| `promptOn`, `promptOff` | For `toggle`: the line for each state. |
| `recolor` | For `color`: skeleton colours to replace with the value. With `lightness` (OKLCH L, 0–1), that entry gets the value's hue at this lightness, for a lighter or darker shade of the same colour. |
| `collapsed` | Shown under "▸ More words". Default false. |

The rules the tests enforce:

- A bound field's default (or placeholder), after `format`, equals the card's text in the
  skeleton exactly. So the defaults reproduce the template as it was made.
- Every bind points at a card that exists, and no card is bound twice.
- Every default and suggestion fits `maxChars`. A `words` suggestion has exactly one entry per
  bound card, or at most `count` entries.
- A `words` field without binds is `verbatim` and has a `count`.
- A `choice` default is one of its options; a `color` field's `recolor` colours appear in the
  skeleton; a `toggle` has both prompts; every `prompt` contains `{value}`.

Words come from the template itself. For a skeleton, read them from `skeleton.text`; never invent
the defaults.

## `inputs.music` and `soundtrack`

Skeletons are timed to music, so a template without its own track asks the person for one:
`inputs.music` is `"required"` until the template ships a `soundtrack`, then `"optional"` (the app
offers the template's track or the person's own).

```json
"soundtrack": { "file": "soundtrack.m4a", "title": "Concrete Halo", "artist": "…", "licence": "MIT, original instrumental", "bpm": 144, "dropSec": 8.1 }
```

The track must be yours to publish: owned, commissioned or generated under a licence that allows
it. Never ship a reference video's audio. Once a skeleton ships a soundtrack it needs a `grid`
(beat times then follow a fixed tempo instead of the tracked beats of a reference), and the
track's beats must sit on that grid.

## `example` and `cutmap`

```json
"example": { "video": "example.mp4", "poster": "poster.jpg", "credit": "Example made with a fictional person. Keyframes: Qwen-Image 2.1 (non-commercial licence). Music: 'Concrete Halo', MIT.", "models": ["qwen21-edit", "wan22-14b-i2v"] },
"cutmap": "cutmap.json"
```

Until a template has an example, its tile is a typographic card. Rules for example media:

- The person in it is fictional: generate the hero with `z-image-turbo` (Apache-2.0). Never use a
  real person's photo or footage from a reference edit.
- The music is the template's own soundtrack.
- Render on the default (best) models, and name them in `credit`, with their licence when it
  limits commercial use. The app adds "Made with: …" from `models` (each model's role, name and
  licence) after the credit, so list every profile that made the example there.
- Budgets: example ≤ 3.5 MB, poster ≤ 200 KB, soundtrack ≤ 1 MB, cut map ≤ 20 KB, and all
  built-in template media together ≤ 30 MB.

## Building examples and soundtracks

`scripts/build-examples.mjs` writes these files and the matching `preset.json` keys, leaving every
other line of the file as it is.

Add a soundtrack:

```
node scripts/build-examples.mjs night-stare --soundtrack ~/music/night-stare.m4a \
  --title "Night Stare" --licence "MIT, original instrumental"
```

It copies the track to `presets/<slug>/soundtrack.m4a` (without metadata), sets `soundtrack`,
flips `inputs.music` to `"optional"` and prints the tempo, the drop and how the track's hits sit
against the grid:

- `--grid keep` (the default when the skeleton has a grid) keeps it and warns when the track is
  off it by more than a frame, with the `--shift <sec>` that lines it up (a positive shift trims
  the track's start; a negative one pads it with silence).
- `--grid auto` (the default when the skeleton has none, as for night-stare) fits a grid to the
  track: its tempo, with beat `timing.dropBeat` on the drop, nudged onto the hits. If the last
  shot then ends before the edit does, the edit's length is set to where it ends.
- `--grid <bpm>@<phase>` sets one by hand.
- `--drop <sec>` gives the drop. Otherwise a `music.json` next to the track (keyed by slug, with
  `drop_in_edit` in seconds) gives the intended drop, checked against the largest loudness rise.

Add an example from a delivered project (a run of that template):

```
node scripts/build-examples.mjs night-stare --project <project-id> \
  --credit "Example made with a fictional person. Keyframes: Qwen-Image 2.1 (non-commercial licence). Clips: Wan 2.2 I2V A14B. Music: 'Night Stare', MIT."
```

It encodes the latest version (or `--version <n>`) at 720 px tall
(`scale=-2:720 -c:v libx264 -crf 26 -preset slow -movflags +faststart -map_metadata -1`, raising
the CRF if needed to fit the budget), takes the poster near the drop on a frame without the edit's
own words, a flash or a cut (the tile sets the template's title over it, so a word in the frame would
read twice; small corner captions count for little), writes
the cut map with each shot's slot and colour, and fills `example` and `cutmap`. Without `--credit`
it stops and suggests one from the project's jobs; check that it is true before you use it.
`--models` overrides the profile list, `--poster-at <sec>` the poster time, `--height <px>` the
size.

Both steps can run in one command (the soundtrack first). Each prints the sha256 and size of every
file it wrote, then the budgets of all templates. `--dry-run` writes nothing, and
`node scripts/build-examples.mjs --check` prints only the budgets.

## Templates saved from the app

After an edit of a decoded video is made, **Save as template** turns it into a template in
`~/.open-katana/presets/` without the director or the GPU:

- every generated shot becomes a slot (its line's keyframe and motion prompts become the slot's
  guidance), and a photo used as is becomes the `photo` slot;
- the skeleton is the cut, with its timing frozen exactly as it was;
- every text card becomes a brief field (cards less than 1.5 s apart form one words field),
  defaulting to the words you used;
- the delivered video becomes the example, and the edit's sound becomes `soundtrack.m4a`.

An edit that shows frames of the original video can't become a template yet. When the sound is
the original video's, the soundtrack is labelled "third-party: from the original video, not
yours to publish" and stays on your computer. These templates are local: share them only with
media you have the rights to.
