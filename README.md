# open-katana

Remix any reference edit — aura-farming edits especially — with your own character, product or
outfit, using open-weights models on **your** ComfyUI: a local machine, a remote GPU, or Comfy Cloud.

You give Claude a reference edit and a photo. Claude reads the reference frame by frame, plans a
remix in its visual language, generates the shots it needs on ComfyUI (Qwen-Image, Wan 2.2 and other
open-weights models), judges every result, and cuts the final video with a deterministic ffmpeg
editor: beat-synced cuts, punch-ins, shake, flashes, speed ramps, grades and animated type, on the
reference's music.

open-katana is an open alternative to the reference-edit workflow of
[Higgsfield Katana](https://higgsfield.ai/katana).

> open-katana is an independent open-source project. It is not affiliated with, endorsed by or
> sponsored by Higgsfield AI. Higgsfield and Katana are trademarks of their respective owners.

## How it works

```
 you: /katana + reference edit + your photo
        │
        ▼
 Claude (the director) ── follows the katana skill
        │
        ├─ katana_analyze ─▶ cuts, 1-frame inserts, flashes, camera moves, shake, punches, beats
        ├─ katana_view/review ─▶ every native frame, proven read (check codes on each page)
        ├─ katana_plan ─▶ concept, shot routes, generation lines, GPU-time estimate → your approval
        ├─ katana_generate/wait/judge ─▶ ComfyUI: keyframes → clips (motion from reference shots)
        ├─ katana_edit/render ─▶ ffmpeg EDL renderer + energy check against the reference
        └─ katana_deliver ─▶ versioned MP4 + in-chat player
```

- **Free first, compute last.** Analysis, editing, text, grade and camera work run locally and
  cost nothing; only the generated shots use GPU time, and you approve an estimate first.
- **Edits are code.** Text, timing, fonts, music and reframes re-render from cached shots in
  seconds without regenerating anything.
- **The reference's energy is measured and enforced.** The output must reach ≥ 0.6× the
  reference's cut, flash, camera-move and shake rates (and not overshoot shake).
- **Identity comes from models, never from editing faces.** The hero keyframe anchors every
  later still; clips start from accepted keyframes; people are motion-transferred with pose
  skeletons so the reference performer's likeness never leaks in.

## Requirements

- **Node.js ≥ 22.12** and **pnpm** (`npm install -g pnpm`, or `corepack enable`).
- **ffmpeg ≥ 6 built with libass, freetype and fontconfig.** The renderer sets type with the
  `subtitles` filter (libass) and stamps review pages with `drawtext` (freetype).
  - macOS: Homebrew's plain `ffmpeg` formula no longer includes these libraries. Install
    `ffmpeg-full` instead. It is keg-only, so put it on your `PATH` yourself (add the export to
    `~/.zshrc` to keep it):

    ```
    brew install ffmpeg-full
    export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
    ```

  - Ubuntu 24.04+ and Debian 13+: `sudo apt install ffmpeg` (built with all three). Older releases
    ship ffmpeg < 6 (Ubuntu 22.04 has 4.4, Debian 12 has 5.1): install a newer build.
  - Check: `ffmpeg -hide_banner -filters | grep -E "drawtext|subtitles"` must list both filters.
- **A ComfyUI to generate on**: local, a remote GPU or Comfy Cloud (see
  [Configure the backend](#configure-the-backend)). On your own GPU, budget disk for the model
  weights (measured from the files the profiles download, shared files counted once):

  | Set | Disk |
  |---|---|
  | Default workflows: Qwen-Image 2.1 keyframes and plates, MiniMax H3 clips (image-to-video, first/last frame, reference-to-video), Wan Animate 2 motion, BiRefNet mattes | about 105 GB (H3 alone is 61 GB; 83 GB without reference-to-video) |
  | Apache-2.0 route (commercial mode): Boogu keyframes, Z-Image plates, Wan 2.2 clips, Wan Animate 2 | about 100 GB |
  | Smallest working set for a 24 GB GPU: Qwen-Image 2.1 Turbo keyframes and plates, Wan 2.2 5B | about 50 GB |
  | Every profile that can be a default | about 350 GB |
  | Camera moves (orbits, arcs, push-ins): Marigold V2 depth, on top of MiniMax H3 + Fun ControlNet Union | about 21 GB more |
  | The upscale for the final render: SeedVR2 7B sharp (3B on the lite tier) | about 9 GB more (4 GB) |

  Comfy Cloud needs none of this: it loads the weights on demand. To fill your own ComfyUI with the
  default set (140 GB), see [Run open-katana on your own GPU](docs/local-gpu.md): a manifest of every
  file and download scripts for Windows, Linux and macOS.
- A network connection on first use: title fonts are downloaded then (see [Third-party](#third-party)).

## Install

open-katana is not published to npm. Install it from a clone and build it once:

```
git clone https://github.com/shrimbly/open-katana
cd open-katana
pnpm install
pnpm build
```

### Claude Code (plugin)

Add the clone as a plugin marketplace and install the plugin from it:

```
/plugin marketplace add /absolute/path/to/open-katana
/plugin install open-katana@open-katana
```

Claude Code installs a copy of the folder, build included, so build before you install and
reinstall the plugin after you pull and rebuild. To load the clone in place for one session
instead, start Claude Code with `claude --plugin-dir /path/to/open-katana`.

Then type `/katana` (or `/open-katana:katana`) in any chat.

### Other MCP clients (Claude Desktop, Cursor, …)

Add the server to the client's MCP configuration:

```json
{
  "mcpServers": {
    "open-katana": {
      "command": "node",
      "args": ["/path/to/open-katana/dist/cli.js", "mcp"]
    }
  }
}
```

With no backend settings the server uses the ComfyUI at `http://127.0.0.1:8188`; see
[Configure the backend](#configure-the-backend) to change it.

Apps started from the Dock or Start menu do not read your shell profile. If the client cannot find
`node` or ffmpeg, give the absolute path to `node` as `command` and set `PATH` in `env`, for example
`"PATH": "/opt/homebrew/opt/ffmpeg-full/bin:/opt/homebrew/bin:/usr/bin:/bin"`.

These clients have no `/katana` skill: type the same request, start it with `/katana` or
`/katana/<preset>`, or use the server's `katana` prompt. The server tells the agent to load the
workflow with `katana_guide`.

## Configure the backend

The server picks its ComfyUI from environment variables, or from a saved config when none of
`COMFYUI_URL`, `COMFY_CLOUD_API_KEY` and `OPEN_KATANA_BACKEND` is set.

| Variable | Use |
|---|---|
| `COMFYUI_URL` | Address of a local or remote ComfyUI (default `http://127.0.0.1:8188`) |
| `COMFYUI_TOKEN` | Bearer token for a remote ComfyUI behind a protected proxy |
| `COMFY_CLOUD_API_KEY` | Comfy Cloud API key from [platform.comfy.org](https://platform.comfy.org); selects the `cloud` backend when `COMFYUI_URL` is not set |
| `OPEN_KATANA_BACKEND` | `http`, `cloud` or `comfy-cli`, to choose the backend explicitly |
| `OPEN_KATANA_HOME` | Data directory for projects, presets, fonts and the config (default `~/.open-katana`) |

Set only the variables for the backend you use. Each backend reads only its own variables, so a
Comfy Cloud key is never sent to a `COMFYUI_URL` host. For Claude Code, export them in the shell
before you start `claude`; the plugin passes your environment to the server:

```
export COMFYUI_URL=http://192.168.1.20:8188   # a GPU box on your network
claude
```

For other MCP clients, put them in the server's `env` block.

The three backends:

| Backend | Settings |
|---|---|
| Local or remote ComfyUI | `COMFYUI_URL` (and `COMFYUI_TOKEN` for a protected proxy) |
| Comfy Cloud with an API key | `COMFY_CLOUD_API_KEY` |
| Comfy Cloud through the comfy CLI | Install the [comfy CLI](https://docs.comfy.org/comfy-cli/getting-started), run `comfy cloud login`, then set `OPEN_KATANA_BACKEND=comfy-cli` |

Instead of environment variables, you can ask Claude to run `katana_backend` with `action: "set"`
(`kind`, and `url` or `apiKey`; `tier: "lite"` for 24–48 GB machines; `commercial: true`, see
below). It saves the settings to `~/.open-katana/config.json` (under `OPEN_KATANA_HOME` when set).
The file is plain text with mode 0600, and it includes any API key you pass. A key passed this way
also stays in the conversation, so for Comfy Cloud prefer `COMFY_CLOUD_API_KEY` or the comfy CLI.
The environment variables above override a saved backend, so leave them unset if you choose the
backend this way (`katana_backend` warns when one is set).

`katana_backend` with no action reports which generation profiles your server can run, links
every missing model and shows the licence of each default. From a terminal,
`node dist/cli.js backend` in the clone lists which profiles your server can run.

## Models and licences

| Operation | Quality profile | Lite profile (24–48 GB, Apple Silicon) |
|---|---|---|
| Face crop for identity | YOLOv8 face detector | same |
| Hero in a scene (identity keyframe) | Qwen-Image 2.1 (then Turbo, Boogu Image Edit, Qwen-Image-Edit 2511) | Qwen-Image 2.1 Turbo, Boogu Image Edit Turbo |
| Empty location plates | Qwen-Image 2.1 (the keyframe weights; Z-Image Turbo in commercial mode; Krea 2 Turbo and its style reference by name) | Qwen-Image 2.1 Turbo |
| Clips from a keyframe | MiniMax H3 image-to-video (full model, native canvas; Wan 2.2 I2V A14B as the Apache-2.0 fallback) | MiniMax H3 + 8-step turbo, Wan 2.2 TI2V 5B |
| Motion from a reference shot (fights, dance, sport) | Wan Animate 2 (MiniMax H3 + Fun ControlNet Union on pose skeletons, Wan 2.2 Fun Control A14B) | Wan Animate 2, Wan 2.2 Fun Control 5B |
| Camera moves: orbits, arcs, push-ins with parallax | MiniMax H3 + Fun ControlNet Union, steered by the keyframe's own Marigold V2 depth re-rendered along the move | same |
| New shots from reference images | MiniMax H3 reference-to-video | MiniMax H3 reference-to-video + 4-step turbo |
| Spins, turns, morphs and transitions | MiniMax H3 first/last frame (Wan 2.2 A14B first/last frame) | MiniMax H3 first/last frame + 8-step turbo |
| Subject mattes | BiRefNet | BiRefNet |
| Upscale for the final render (1080p by default) | SeedVR2 7B sharp (then SeedVR2 7B) | SeedVR2 3B |

Graphs are built in code from the official ComfyUI templates and validated against your server's
`object_info`; model files are matched by name across precision variants (fp8, bf16, …). Each
operation uses the first model in its preference list that your ComfyUI can run. FLUX 3 Image
Klein is wired in too (`flux3-klein-edit`, used only when named) for ComfyUI installs that have
it. Keyframes use an identity-first recipe (the subject photo plus a detected face crop, the shot
described in words); how that and the defaults were chosen: [docs/models.md](docs/models.md).

open-katana ships no model weights. You download them into your ComfyUI (`katana_backend` links
each missing file), or Comfy Cloud provides them, and each model's own licence governs how you may
use it and, for some, its outputs. The table below is a summary, not legal advice: read the
licence on each model card before you publish or sell anything made with it.

| Model | Profiles | Licence | Commercial use (summary) |
|---|---|---|---|
| [Qwen-Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) and 2.1 Turbo | `qwen21-edit` (default keyframes), `qwen21-turbo-edit` (lite default), `qwen21-turbo` | [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) | No: research and evaluation only |
| [Qwen-Image-Edit 2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) + [Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning) | `qwen-edit-2511` | Apache-2.0 | Yes |
| [Boogu Image Edit 0.1](https://huggingface.co/Boogu/Boogu-Image-0.1-Edit) and Turbo | `boogu-edit`, `boogu-edit-turbo` | Apache-2.0 | Yes |
| [FireRed-Image-Edit 1.1](https://huggingface.co/FireRedTeam/FireRed-Image-Edit-1.1) + Lightning | `firered-edit-1.1` | Apache-2.0 | Yes |
| [FLUX.2 [klein] 9B](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B) | `flux2-klein-9b` (only when named) | [FLUX Non-Commercial License](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md) | No |
| [FLUX 3 Image Klein](https://huggingface.co/black-forest-labs/flux-3-image-klein) | `flux3-klein-edit`, `flux3-klein` (only when named) | [FLUX Kommunity License v1.0](https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md) | Restricted: commercial output only for organisations under US$5M gross annual revenue (affiliates included) |
| [Mage-Flow-Edit Turbo](https://huggingface.co/Comfy-Org/Mage-Flow) | `mage-flow-edit-turbo` (only when named) | MIT per the Comfy-Org repackage; unverified, see model card | See model card |
| [Lens Turbo](https://huggingface.co/Comfy-Org/Lens) | `lens-turbo` (only when named) | MIT per the Comfy-Org repackage; unverified, see model card | See model card |
| [Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | `z-image-turbo` (plates in commercial mode) | Apache-2.0 | Yes |
| [ERNIE-Image Turbo](https://huggingface.co/baidu/ERNIE-Image-Turbo) | `ernie-image-turbo` | Apache-2.0 | Yes |
| [Krea 2 Turbo](https://huggingface.co/krea/Krea-2-Turbo) and its style-reference LoRA | `krea2-turbo`, `krea2-style-reference` (only when named) | [Krea 2 Community License](https://cdn.jsdelivr.net/gh/krea-ai/krea-2@db3984fbc6e13b34c0064990fc2d95ac64d00058/assets/hf_samples/LICENSE.pdf) | Restricted: commercial use only for organisations under US$1M total annual revenue, plus content-filtering and pass-through obligations |
| [Wan 2.2](https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B) (I2V A14B, TI2V 5B, [Fun Control](https://huggingface.co/alibaba-pai/Wan2.2-Fun-A14B-Control)) + [lightx2v LoRAs](https://huggingface.co/lightx2v/Wan2.2-Distill-Loras) | `wan22-*` | Apache-2.0 | Yes |
| [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) + [turbo LoRAs](https://github.com/ModelTC/Minimax-H3-Turbo) and [Fun ControlNet Union](https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union) (the default for clips) | `minimax-h3-i2v`, `minimax-h3-flf`, `minimax-h3-r2v`, `minimax-h3-motion` and the `-turbo` variants | [MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) | Restricted: use of the open weights and their outputs in the United States, the European Union, the United Kingdom and South Korea is not licensed, whether on your own GPU or on a hosted service such as Comfy Cloud; a product that uses it must show "MiniMax H3" in its interface; separate authorisation above US$20M annual revenue; outputs may not be used to train other models. Comfy states that Comfy Cloud generations include commercial rights: check that this covers your territory. MiniMax's own API is under separate terms. |
| [Wan Animate 2](https://huggingface.co/Wan-AI/Wan2.2-Animate-2-14B) ([Comfy repackage](https://huggingface.co/Comfy-Org/Wan-Animate-2)) | `wan-animate2` | Apache-2.0 | Yes |
| [SDPose Wholebody](https://huggingface.co/Comfy-Org/SDPose) with its RT-DETR person detector, [Depth Anything 3 Mono Large](https://huggingface.co/depth-anything/DA3MONO-LARGE) | pose control, and depth control with `depth: "da3"`, for `minimax-h3-motion` and `wan22-*-fun-control` | MIT (SDPose), Apache-2.0 (Depth Anything 3) | Yes |
| [Marigold V2 depth](https://huggingface.co/Comfy-Org/marigold-v2-0) (a LoRA on Qwen-Image-Edit 2509) | the depth for camera moves and `control: "depth"` | Apache-2.0 | Yes |
| [SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2) 7B sharp, 7B and 3B | the upscale of every shot before the final render | Apache-2.0 | Yes |
| [BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet) | `birefnet` | MIT | Yes |
| face_yolov8m ([Bingsu/adetailer](https://huggingface.co/Bingsu/adetailer)) | `face-crop` | Apache-2.0 weights (per the uploader), run by Ultralytics YOLOv8 code (AGPL-3.0) inside the ComfyUI FaceParsing node | Weights: yes; the detector code is AGPL-3.0 |

Text encoders, VAEs and LoRAs come from the same or related repositories and have their own cards.

Profiles marked "only when named" are never picked as a default or a fallback: name one in a job
or with `katana_backend` `profiles` to use it.

**Commercial work.** Qwen-Image 2.1 stays the default keyframe model because it gives the best
likeness in our tests, but its licence does not allow commercial use. For commercial work, ask
Claude to run `katana_backend` with `action: "set"` and `commercial: true` (saved in
`config.json`). Model defaults then skip profiles with a non-commercial licence (keyframes use
Boogu Image Edit or Qwen-Image-Edit 2511 instead). Profiles under restricted licences, such as
MiniMax H3, stay available and are flagged, and a profile you name still runs, with a warning.
MiniMax H3 is the default for every clip; if its licence doesn't cover you, choose **Use Wan 2.2 for
clips instead** on the app's receipt for an edit, or set the Wan profiles with `katana_backend`
`profiles` (`clip.i2v: wan22-14b-i2v`, `clip.flf: wan22-14b-flf`, `clip.motion: wan-animate2`).
`katana_backend` shows the licence of each profile in use, and `katana_plan` shows each job's
licence and lists licence warnings before you approve the estimate.

## Using it

### The app

The app makes edits without a chat: pick a template and drop a photo of you, or drop an edit you
love and put yourself in it. Start it from the clone, after [Install](#install):

```
pnpm install && pnpm build  # once, and again after every pull
node dist/cli.js app        # opens http://127.0.0.1:4310 (--port N, --no-open, --replace)
```

Browsing templates and decoding work straight away. To make edits the app needs three things, and
its **Setup** page (the status pill at the top right) checks each one and says what to do:
[Claude Code](https://docs.claude.com/en/docs/claude-code/setup) installed and signed in (run
`claude` once in a terminal), a ComfyUI to generate on (Comfy Cloud, this computer's or another
computer's), and ffmpeg. Running `node dist/cli.js app` again opens the app that is already running;
if an older open-katana holds the port, the app tells you to restart it with `--replace`, or starts
on a free port and prints the address.

1. **Templates.** Click one, drop a photo, and change the words if you like: every field starts
   with the template's own. Each template ships its own soundtrack; to use yours, choose **My own
   track** and drop a file or paste an Instagram reel link (**Use its sound**). The receipt shows
   the time, GPU minutes and Claude usage as ranges, the caps, and each model's licence. **Make my
   edit** approves those caps.
2. **Any edit.** Drop a video (2–60 s) anywhere on the home page, or paste an Instagram reel link
   and click **Copy this edit**. It decodes in a few seconds and draws its Cut Map: every cut,
   flash and beat. Click **Put me in this edit**, drop a photo, and **Make my edit**.

Instagram links are fetched on your computer with [instaloader](https://github.com/instaloader/instaloader)
(MIT), which you install yourself: `pipx install instaloader`. Instagram often wants you signed in:
run `instaloader --login <your username>` once in a terminal (it saves a session, and your password
stays with instaloader), then enter the username in the app's **Settings**, or pick a browser there
to borrow its Instagram login. The app never asks for your Instagram password. Copy only edits, and
use only sounds, you have the rights to: downloading other people's posts can break Instagram's
terms and their copyright.

The director is your own Claude Code, run headless with only the open-katana tools; the shots are
made on your ComfyUI. Edits keep going if you close the app, Stop also cancels the GPU jobs, and
spending never passes the caps you approved. Each result can be downloaded, opened in the studio,
given new words without the GPU, changed by the director, or (for decoded edits) saved as a
template. It needs ffmpeg, a ComfyUI and Claude Code signed in; usage counts toward your Claude
plan or is billed to your API key, as your Claude Code is set up.
See [docs/app.md](docs/app.md) for setup, billing, privacy, data locations and troubleshooting.

### In a chat

```
/katana
/katana neon-rain            (a built-in preset; attach or paste the path of your photo)
/katana make an aura edit of me from this reference: ~/Downloads/ref.mp4, photo: ~/me.jpg
/katana recreate this edit shot for shot with my character: …
/katana cut my clips to the rhythm of this reference: …
```

Built-in presets come in two kinds:

- **Templates** with slots for the shots your material must supply and a ready-made edit skeleton
  that the agent fills: `night-stare`, `hype-energy`, `iron-mindset`.
- **Style recipes** (structure, energy, look, type) that the agent builds a new edit from:
  `cold-stare`, `golden-hour`, `neon-rain`, `phonk-velocity`.

Save your own with a reference edit (3–30 s) via `katana_preset_save`, or with **Save as template**
on an edit made in the app; presets live in `~/.open-katana/presets`. How templates are built
(brief fields, title style, timing, soundtracks and examples): [docs/templates.md](docs/templates.md).

### The studio

Every project opens in a local timeline editor. Ask the agent for its `katana_studio` link, or start
it from the clone:

```
node dist/cli.js studio              # pick a project
node dist/cli.js studio <project>    # open one project (--port N, --no-open)
```

It shows the edit the way an NLE does: picture, text, flash, sound-effect and music lanes on a ruler
counted in bars and beats, with the reference's cuts as hairlines so you can see where your cuts
land against the original. Text draws live over the picture in the same fonts and metrics the
renderer uses, so you can retype words, change fonts, sizes, glow and entrances, or drag words around
the frame and see the result immediately. Trim or roll cuts (they snap to beats), split shots, slip a
clip with Alt-drag, drop a different take from the media panel onto a shot, add flashes and sound
effects, and change camera moves and looks per shot. Picture changes re-render in the background from
the shot cache; **Render preview** shows the exact libass output, and **Export** renders the master and
saves a new version. Edits land in the project's EDL, so the agent picks up from whatever you changed.

Projects live in `~/.open-katana/projects/<id>` (override with `OPEN_KATANA_HOME`): imported media,
analysis records and review sheets, the plan, every generation job and its outputs, QA verdicts,
the EDL, renders and delivered versions. Any session can resume a project with `katana_status`.

## Documentation

- [The app](docs/app.md)
- [Run open-katana on your own GPU](docs/local-gpu.md): the model files and download scripts
- [Authoring templates](docs/templates.md)
- [Architecture](docs/architecture.md)
- [EDL reference](docs/edl.md)
- [Choosing the models](docs/models.md): keyframes, clips and motion transfer, with test results
- [Research notes: Higgsfield Katana and open-katana](docs/research.md)

## Development

```
pnpm install
pnpm test        # engine, renderer, ComfyUI layer (mock server) and MCP integration tests
pnpm typecheck
pnpm build       # dist/, single-file widgets in dist/ui and the studio in dist/studio-ui
pnpm dev         # MCP server on stdio from source (tsx src/cli.ts mcp)
pnpm widgets:dev # build the widgets plus a local MCP Apps host to preview them with sample data
pnpm studio:dev  # studio front end with hot reload (proxying a running studio)
pnpm app:dev     # the app from source on port 4310, for pnpm studio:dev to proxy
pnpm test:smoke  # browser smoke test of the app with a fake director (needs Chrome; not in pnpm test;
                 # builds the client into a temp folder served via OPEN_KATANA_UI_DIR, so dist/ is untouched)
node scripts/build-examples.mjs --check   # size budgets of the templates' bundled media
```

## Responsible use

Use only footage and photos you own or have permission to use, and get consent before putting a
real person's likeness in an edit. Music in reference edits is usually someone else's work: check
the rights before publishing. Check each model's licence before commercial use
(see [Models and licences](#models-and-licences)).

## Third-party

- Bundles [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) (SIL OFL 1.1,
  [assets/fonts/JetBrainsMono-OFL.txt](assets/fonts/JetBrainsMono-OFL.txt)) for review-page stamps.
- Title fonts are SIL OFL families downloaded on first use from
  [github.com/google/fonts](https://github.com/google/fonts), with weights and italics from the
  Google Fonts static instances (fonts.googleapis.com). They are cached in `~/.open-katana/fonts`.
- Model weights are not bundled; see [Models and licences](#models-and-licences).

## License

open-katana's code is under the [MIT License](LICENSE). Bundled fonts and the models it runs have
their own licences: see [Third-party](#third-party) and [Models and licences](#models-and-licences).
