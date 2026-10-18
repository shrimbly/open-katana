# Run open-katana on your own GPU

open-katana sends its generations to a ComfyUI: Comfy Cloud, or one you run yourself on this computer
or another one on your network. This guide sets up your own: the model files, a check that ComfyUI
sees them, and the connection from open-katana.

## What you need

- **ComfyUI 0.39 or newer** (Comfy Desktop's current release is fine). The workflows use only core
  nodes, including the MiniMax H3, Marigold V2 and SeedVR2 ones; no custom nodes.
- **An NVIDIA GPU with 24 GB or more.** On 24 GB (an RTX 4090), the quality models run with ComfyUI
  moving weights between the GPU and system memory, so give it 64 GB of RAM or more.
- **About 150 GB of free disk** for the quality set (140 GB of models plus room to spare).

## The model files

[`models-manifest.json`](models-manifest.json) lists every file the default workflows load, with its
ComfyUI models folder, download URL and exact size: keyframes and plates (Qwen-Image 2.1), clips
(MiniMax H3), reference-shot motion (Wan Animate 2), camera moves (MiniMax H3 + Fun ControlNet Union,
steered by Marigold V2 depth), mattes (BiRefNet) and the final upscale (SeedVR2). `quality` is 22
files and 140 GB; `lite` swaps in turbo and smaller variants. `open-katana models` prints the same
list. Check each licence in the [README](../README.md#models-and-licences) before you use the edits.

### 1. Find the models folder

- **Comfy Desktop:** the `models` folder inside the folder you chose at install time (often
  `Documents\ComfyUI\models`). Comfy Desktop passes the paths it uses in an
  `--extra-model-paths-config` YAML file; its `base_path` plus the folder names below are where
  ComfyUI looks.
- **Portable or git install:** `ComfyUI/models`, unless `extra_model_paths.yaml` points elsewhere.

To check, ask the running ComfyUI which files it sees in a folder:
`curl http://127.0.0.1:8188/api/experiment/models/vae` (also `diffusion_models`, `loras`,
`text_encoders`, `model_patches`, `embeddings`, `clip_vision`, `background_removal`).

### 2. Download

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/shrimbly/open-katana/main/scripts/download-models.ps1 -OutFile $HOME\download-models.ps1
powershell -ExecutionPolicy Bypass -File $HOME\download-models.ps1 -ModelsDir "C:\path\to\ComfyUI\models"
```

Linux or macOS:

```sh
curl -fsSLO https://raw.githubusercontent.com/shrimbly/open-katana/main/scripts/download-models.sh
bash download-models.sh /path/to/ComfyUI/models
```

Both scripts skip files that are already there at the right size, stop if the disk is too small,
download three files at a time and check every file byte for byte before giving it its real name
(it downloads as `<name>.part`, so ComfyUI never loads half a file). Run them again to resume; they
never delete or overwrite a finished file. Add `-Tier lite` (PowerShell) or `lite` as the second
argument (shell) for the lite set.

### 3. Check that ComfyUI sees them

ComfyUI picks up new files without a restart. Each loader should now list them:

```
curl http://127.0.0.1:8188/object_info/UNETLoader        # diffusion_models
curl http://127.0.0.1:8188/object_info/VAELoader         # vae
curl http://127.0.0.1:8188/object_info/CLIPLoader        # text_encoders
curl http://127.0.0.1:8188/object_info/ModelPatchLoader  # model_patches
```

From the computer that runs open-katana, `node dist/cli.js backend` lists every profile as `ready`
or `missing` with the files it lacks.

## Connect open-katana to it

On the same computer, the default `http://127.0.0.1:8188` just works. For a ComfyUI on another
computer, start ComfyUI with `--listen` and point open-katana at it: the app's **Set up** page, or
`~/.open-katana/config.json`:

```json
{ "backend": { "kind": "http", "url": "http://192.168.1.20:8188" }, "tier": "quality" }
```

`--listen` lets anyone who can reach that port run workflows on the machine. Keep it on a network
you trust (a private Tailscale network, your home LAN), or limit the port in the machine's firewall
to the computers that run open-katana.

## Let Claude Code do it

On the GPU machine, in a terminal where Claude Code is installed:

```
claude "Set up this computer's ComfyUI for open-katana: follow https://raw.githubusercontent.com/shrimbly/open-katana/main/docs/local-gpu.md, download the quality set, and finish with a table of each file, its folder and whether it is in place."
```

Instructions for that agent:

1. Find the folder ComfyUI loads models from (step 1) and confirm it with the
   `/api/experiment/models/<folder>` check before downloading anything.
2. Run the download script for this system (step 2) against that folder. If a file stays
   incomplete, run the script again; report any that still fail.
3. Confirm ComfyUI lists every file (step 3) and report the free disk space left.
4. Download and check model files only: don't install, update or remove ComfyUI, custom nodes or
   Python packages, don't restart ComfyUI, don't change its settings, and don't delete files.
