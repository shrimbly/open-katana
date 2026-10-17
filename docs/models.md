# Choosing the image models

Keyframes decide likeness for the whole edit: every clip starts from one. The default for each
operation is picked by running the same inputs, prompt and seeds through each candidate on Comfy
Cloud and comparing the results next to the subject photo.

Each model has its own licence, and some do not allow commercial use. The licence notes on this
page are summaries, not legal advice; the [README](../README.md#models-and-licences) lists every
model with a link to its licence. For commercial work, turn on the commercial switch
(`katana_backend` with `action: "set"` and `commercial: true`): model defaults then skip profiles
whose licence is non-commercial, and `katana_backend` and `katana_plan` report licence warnings.

## Keyframes (`still.compose`), October 2026

### What decides likeness: the inputs, more than the model

Three rounds on the same subject (two seeds per case), judged side by side with the subject photo:

| Change | Effect |
|---|---|
| **A tight face crop as an extra identity image** (`still.face`) | The biggest single gain, for every model: the face is no longer ~200 px after the references are scaled to 1 MP. |
| **No reference frame with a person in it** | Qwen-Image 2.1 treats image 1 as the picture to edit: with the reference frame there, the original actor's hood, hair and build survive on some seeds. Other models take faces from such frames too. |
| Framing, light and expression written in words | Lets the model follow "cold stare" or "roaring" instead of copying the photo's expression. |
| References encoded at 1536 px instead of 1024 | Slightly crisper faces. |
| Qwen-Image 2.1's prompt enhancer | No likeness gain, a colour cast, ~25× slower. Not used. |
| A second pass redrawing the detected face against the crop | Visible seams, and on a pose that didn't match it pasted a frontal face. Not used: generate it right the first time. |
| Emptying the reference frame (person removed) and using it as a plate | Natural with Boogu; with Qwen-Image 2.1 the person looks pasted in. |

### Models, with the face crop and no reference frame

| Model | Result |
|---|---|
| **Qwen-Image 2.1** (25 steps, default) | Strongest likeness and expression control, and the most natural, photographic results. Runs on Comfy Cloud, which loads its weights on demand. Non-commercial licence (see below). |
| Qwen-Image 2.1 Turbo (8 steps, lite default) | The same likeness at a third of the steps, but punchier, more plasticky renders (flat "helmet" hair, glossy fabric, blown backgrounds) and occasional green or magenta blobs. Good for drafts. |
| Boogu Image Edit | Strong likeness but tends to copy the photo's expression (a slightly open, talking mouth); blends a hero into a plate best. |
| Qwen-Image-Edit 2511 + Lightning | Consistent but slims the face. |
| FireRed-Image-Edit 1.1 | Varies by seed; occasional tattoos and face paint. |
| Mage-Flow-Edit Turbo | Copies text and logos from its inputs. |
| Boogu Image Edit Turbo (lite default) | Close to Boogu on faces; ignores large scene changes. |

Qwen-Image 2.1 and its Turbo are under the
[Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE): in summary,
research and evaluation only, no commercial use. Qwen-Image 2.1 stays the default because it gives
the best keyframes; with `commercial: true` keyframes use Boogu Image Edit or Qwen-Image-Edit 2511
(both Apache-2.0) instead. FLUX.2 [klein] 9B is under the
[FLUX Non-Commercial License](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md)
and runs only when named. Mage-Flow-Edit Turbo's licence could not be verified on its model card,
so it also runs only when named.

FLUX 3 Image Klein is wired in (`flux3-klein-edit`) but not yet served by Comfy Cloud, so it is
untested. It is under the
[FLUX Kommunity License](https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md)
(in summary, commercial output only for organisations under US$5M gross annual revenue) and runs
only when named.

A second comparison ran both Qwen-Image 2.1 variants on nine shots from the three new presets
(night stare, glare, wide scope; temple tap, nose-bridge push, bird's-eye; arena stare, window profile,
trophy celebration), two seeds each: likeness was the same, the full model looked real in every
shot, and Turbo produced the artifacts listed above in three of them.

## Location plates (`still.generate`)

Krea 2 Turbo, ERNIE-Image Turbo and Lens Turbo all beat Z-Image Turbo slightly on photographic
depth and wet-surface detail for an empty night walkway, Krea 2 most of all. Z-Image Turbo stays
the default because it is Apache-2.0. Krea 2 is under the
[Krea 2 Community License](https://cdn.jsdelivr.net/gh/krea-ai/krea-2@db3984fbc6e13b34c0064990fc2d95ac64d00058/assets/hf_samples/LICENSE.pdf): in
summary, commercial use only for organisations under US$1M total annual revenue, plus
content-filtering and pass-through obligations. Read the licence before commercial use. Krea 2 and
Lens Turbo (whose licence could not be verified) run only when named (`katana_backend` profiles
`{"still.generate": "krea2-turbo"}`).

## Krea 2 style reference

Krea 2 Turbo has no editing or identity reference; its style-reference LoRA takes an image's look.
Given the subject photo it produced a different person, so it is never used for keyframes. Given a
reference frame and an empty-place prompt, it made the plate that best matched the reference's grade
and light of everything tested, so the guide uses `krea2-style-reference` for plates and inserts
that must match a reference frame (same licence terms).

## Comfy Cloud and unlisted weights

Comfy Cloud fetches some model files on demand that its `object_info` does not list (Qwen-Image 2.1
was one). The comfy CLI's pre-check rejects such workflows, so the `comfy-cli` backend submits them
straight to the Cloud API with the CLI's stored credentials (or `COMFY_CLOUD_API_KEY`), and Cloud
backends treat unlisted weights as on demand rather than missing.
