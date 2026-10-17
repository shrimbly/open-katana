# EDL reference

`katana_edit` takes one JSON document. Its full schema (with descriptions) is in the tool's input
schema; this page is the readable version.

## Times

Every time is one of:

- seconds: `1.25`
- a beat of the soundtrack: `"b12"` is the 13th tracked beat; `"b12.5"` is halfway to the next
  (beats are shifted by `audio.offset`, so `b0` is the first beat heard in the edit)
- a frame: `"f240"`

Frame `f` covers `[f/fps, (f+1)/fps)`; shot boundaries round to the nearest frame.

When the edit is cut to a grid the beat tracker missed, override it: `"grid": { "bpm": 144,
"phase": 0.5 }` makes `b0` fall at 0.5 s and every beat 60/144 s apart. Reference analysis already
checks its tempo against the reference's own cuts (`audio.json` → `tempoSource: "cuts"`).

## Document

```jsonc
{
  "canvas": { "width": 1080, "height": 1920, "fps": 30, "durationSec": 15 },
  "audio": { "asset": "ref", "offset": 0, "gainDb": 0, "fadeOut": 0.2 },   // or null for silence
  "finish": { "look": "teal-night", "grain": 0.3, "vignette": 0.4, "letterbox": 0 },
  "shots": [ /* see below; gaps render black, later shots win overlaps */ ],
  "grid": { "bpm": 144, "phase": 0.5 },   // optional beat-grid override
  "flashes": [ { "at": "b8", "duration": 0.08, "color": "white", "intensity": 1, "overText": false } ],
  "text": [ /* see below */ ],
  "sfx": [ { "at": "b8", "sound": "hit", "gainDb": -6 } ]   // built-in name or an audio asset id
}
```

## Shots

```jsonc
{
  "id": "s3",
  "start": "b4", "end": "b6",
  "source": {
    "asset": "v2_t1",          // asset id, "ref", or "black" / "white" / "#rrggbb"
    "in": 0.4,                 // seconds into the source
    "speed": 1,                // 0 freezes the frame at `in`
    "speedTo": 0.3,            // optional linear ramp to this speed by the end of the shot
    "reverse": false,
    "interpolate": "none",     // "blend" or "motion" when the source is slower than the canvas
    "fit": "cover",            // or "contain"
    "focus": [0.5, 0.4],       // crop anchor for cover
    "matte": "mat1_t1"         // optional subject matte clip (a matte job's output) for text behind the subject
  },
  "camera": {
    "zoom": [1, 1.15], "ease": "out",
    "pan": [0.05, 0],          // drift as a share of width/height over the shot
    "roll": [-2, 1],           // degrees
    "punch": { "at": ["b4.5", "b5"], "amount": 0.08, "decay": 0.18 },
    "shake": { "amp": 0.012, "freq": 9, "from": "b5", "to": "b5.5", "decay": true },
    "handheld": { "amp": 0.004, "freq": 0.7 },
    "anchor": [0.5, 0.35],     // zoom focus point
    "panFrom": [0.3, 0],       // start offset, so a whip can land inside the shot
    "overscan": 1.0            // exact scale instead of automatic overscan (match a neighbouring hold)
  },
  "fx": {
    "look": "bw-contrast", "exposure": 0, "contrast": 1.1, "saturation": 0.9,
    "glow": 0.35, "glowColor": "#FFB46A",
    "blur": 0,                 // or [0, 20] to blur in over the shot
    "motionBlur": { "direction": "horizontal", "amount": 40 },   // whips
    "zoomBlur": 0.5,           // radial
    "rgbSplit": 4, "invert": false,   // or 0–1 for a partial invert
    "bw": false, "mirror": false,
    "tint": { "color": "#4FC3F7", "amount": 0.5 },
    "duotone": { "shadow": "#0B1640", "highlight": "#7FB2FF" },
    "keepColor": { "color": "#D01020", "similarity": 0.3 },     // grey out everything else
    "threshold": 0.5, "posterize": 4, "vignette": 0.5,
    "mask": { "shape": "circle", "center": [0.5, 0.5], "size": [0.7, 0.7], "feather": 0.06, "color": "#000000" },
    "leak": { "color": "#FFB46A", "side": "left", "amount": 0.6 },
    "flashIn": 0.1, "flashOut": 0, "dipIn": 0, "dipOut": 0.15,
    "strobe": { "rate": 8, "intensity": 0.5 },
    "frameStrobe": { "every": 2, "on": 1, "color": "black" },   // frame-locked black/white strobe
    "trail": 0.4
  },
  "background": "#000000",     // subject cut out (needs source.matte) over a colour
  "tile": { "cols": 3, "rows": 2, "mirror": "alternate", "offset": 0.1, "stagger": 0.05, "gap": 0.01, "enter": "pop" },
  "layers": [ /* see Layers */ ]
}
```

Camera times (`punch.at`, `shake.from/to`) are timeline times like everything else.
Moves never reveal frame edges: the renderer over-scans just enough for the pan, shake and roll
you ask for.

A circle mask's `size[0]` is its diameter as a share of the frame's shorter side; a rect mask's
`size` is [width, height] as shares of the frame.

### Layers

Layers composite over the shot, in order: picture-in-picture cards, split-screen panels, clones of
the subject, blend-mode overlays and regional effects.

```jsonc
{
  "source": { "asset": "c2_t1", "in": 0.3, "matte": "m2" },   // same fields as a shot source
  "box": [0.56, 0.08, 0.36, 0.36],   // x, y, width, height as shares of the canvas
  "start": "b6", "end": "b8",        // timeline times; default the whole shot (the source starts at `start`)
  "key": false,                      // cut the subject out with source.matte (clones)
  "window": false,                   // show the shot's own picture in the box, with this layer's fx
  "shape": "rect",                   // or "circle"
  "opacity": 1,
  "blend": "normal",                 // screen, add, multiply, overlay, difference, lighten, darken
  "border": { "width": 0.012, "color": "#FFFFFF", "bottom": 0.04 },   // card / polaroid edge
  "shadow": 0.6,
  "enter": { "type": "pop", "duration": 0.25 },   // fade, pop, slide-left/right/up/down
  "exit": { "type": "fade", "duration": 0.2 },
  "camera": { "zoom": [1, 1.1] },    // moves inside the box
  "fx": { "bw": true }
}
```

A `tile` repeats the shot's own source in a grid as layers; `offset` puts each copy that many
seconds further into the clip (clone tiles), `stagger` reveals them one by one.

Looks: `none`, `teal-night`, `cold-blue`, `warm-film`, `bw-contrast`, `bleach`, `crushed`, `sepia`,
`neon`, `dreamy`.

## Text

```jsonc
{
  "text": "AURA", "start": "b8", "end": "b10",
  "font": "UnifrakturMaguntia",   // see katana_guide topic "fonts"
  "size": 0.14,                   // cap height as a share of canvas height (exact: read from the font's metrics)
  "color": "#FFFFFF",
  "outline": { "color": "#000000", "width": 0.05 },
  "shadow": 0.03, "glow": 6,
  "position": "center",           // top, bottom, upper-third, lower-third or [x, y] in 0–1
  "align": "center", "tracking": 0.1, "uppercase": true,
  "italic": false,                // a real italic face when the family has one
  "weight": 700,                  // 100–900: a real static face (Bold, Black, Light…)
  "opacity": 1,
  "anim": "slam",                 // none, pop, slam, fade, rise, type, flicker, glitch
  "exit": "none",                 // none (hard cut), fade, flicker, shrink, blur
  "behind": false                 // true: drawn behind the subject on shots with a source.matte
}
```

Fonts are SIL OFL families fetched from google/fonts on first use; weights and italics come from
the Google Fonts static instances. Flashes draw under the text unless `overText` is set.

## Sound effects

`sfx` cues are mixed under the soundtrack and limited to −1 dBFS. `sound` is an audio (or video)
asset id — recorded effects you own sound best — or a built-in procedural effect: `whoosh`,
`hit`, `boom`, `riser`, `tick`, `glitch`.
