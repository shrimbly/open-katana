# Choosing the models

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

Plates come from Qwen-Image 2.1 by default: the same weights as the keyframes, so they add no
download and share the keyframes' look. On an empty night ramp it followed the brief more closely
than Z-Image Turbo (lamp in the upper left, the railings, the sodium cast), and on an overcast
backyard the two were on par. Qwen-Image 2.1 is non-commercial, so the commercial switch moves
plates to Z-Image Turbo (Apache-2.0), as it moves keyframes to Boogu Image Edit.

Earlier, against Z-Image Turbo:

Krea 2 Turbo, ERNIE-Image Turbo and Lens Turbo all beat Z-Image Turbo slightly on photographic
depth and wet-surface detail for an empty night walkway, Krea 2 most of all. Z-Image Turbo is the
commercial-mode plate model because it is Apache-2.0. Krea 2 is under the
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

## Clips (`clip.i2v`, `clip.flf`, `clip.r2v`), October 2026

MiniMax H3 against Wan 2.2 on three shots from the gallery examples, same keyframe and prompt for
each, on Comfy Cloud:

| Shot | Wan 2.2 (A14B + 4-step) | MiniMax H3, full model, 20 steps |
|---|---|---|
| Night-stare stairs run (fast action, 3 s) | clean, 16 fps | clean, native 24 fps, the runner pulls away (FastH3 follows him up the stairs) |
| Night-stare stare (locked close-up) | opens his mouth mid-clip, ends in a squint | locked camera, a breath and a slight tilt, exact likeness |
| Hype-energy spin (big body move) | a quarter turn; invents a pink crop top | a real full spin; on first/last frame at 768p the end face matches the keyframe |

H3 wins on body motion, locked close-ups and spins, and costs about the same GPU time (the full
model takes 50–130 s per 3–4 s clip on its native canvas). The turbo LoRAs are about 4× faster
with the same motion but creep small push-ins into locked shots and take shortcuts on big moves
(a quarter turn instead of a spin), so they are the lite tier. Moves where the face turns away
belong on first/last frame or reference-to-video with an end guide: on image-to-video alone every
model re-invents the face after the turn. FastH3 (FastVideo's 8-step distill) is lively but
beautifies faces and adds logos; Comfy Cloud runs it but doesn't list it, so it isn't a profile yet.

## Camera moves (`clip.motion` + `camera`), October 2026

A car reel cut from slow gimbal orbits around its details (bonnet, headlight, wheel; about 5–10° in
1.2 s with a slight push-in), recreated with a different car. The first version animated stills
with zooms, which can't show parallax. Each method below started from the same accepted keyframe:

| Method | Result |
|---|---|
| Still + zoom in the edit (the old route) | no orbit: the picture scales, nothing slides behind the subject |
| MiniMax H3 image-to-video, the orbit in the prompt | a small coherent orbit on two shots of three; on the wheel it drifts into a wider shot |
| H3 + Fun ControlNet Union, depth of the reference shot (Depth Anything 3), strength 1.0 | cuts to a wide shot of the whole car in the first frames; swaps in the reference car's wheel |
| Same, strength 0.6, or with H3 reference-to-video and four photos of the car | calmer, but the wheel turns into a round window onto another view, or the shot drifts to the car on the road |
| Same with Marigold V2 depth of the reference | sharper maps (vents, headlight bowl, spokes) and the same failures: the depth carries the other car's shapes |
| **H3 + Fun ControlNet Union, the keyframe's own Marigold depth re-rendered along the orbit** (strength 1.0) | real orbits with parallax on all three shots, no cuts, the car's own wheel, headlight and chrome |

The reference's depth fails because it disagrees with frame 0: a different car, framed
differently, and H3 resolves the conflict by cutting or morphing. Depth taken from the keyframe
itself and moved by a virtual camera always agrees with it. The move is parameterised (`orbit`,
`arc`, `push` in `camera`), so the director names it from the reference instead of copying its
pixels. Marigold V2 maps beat Depth Anything 3 here: DA3's normalisation washes a close-up car out
to near-white, while Marigold keeps the surfaces that make the parallax read.

## Motion transfer (`clip.motion`), October 2026

The fast shadowboxing shot of a reference edit (1.08 s, a small dark figure inside a scope
vignette), re-performed by a fictional hero from a keyframe already in the reference's first pose.
Motion is the mean frame-to-frame change (reference 2.45; the old prompt-only clip 0.22–0.33):

| Method | Motion | Notes |
|---|---|---|
| Wan 2.2 image-to-video, prompt only (the old default) | 0.3 | a guard stance with a twitch; the motion was also stretched over 2 s |
| MiniMax H3 + Fun ControlNet Union, pose, turbo 6 steps (`minimax-h3-motion`) | full-reach jabs on the reference's beats | 8 GPU s; the face softens when he turns away; light flares mid-clip |
| MiniMax H3 + pose, 20 steps / strength 1.5 / depth control | as above / worse / bulkier, back-turned | strength 1.5 copies the performer's back view; depth copies his silhouette |
| **Wan Animate 2** (`wan-animate2`, the default) | 2.36, the tightest frame-for-frame copy | 24 GPU s, clean limbs; borrows the performer's bulk and lightens the hoodie |
| Wan Animate 2 distilled | 1.89 | a melted fist in a few frames |
| Wan 2.2 Animate (move mode) | 2.03 | keeps the keyframe's background; looser poses, smeared fists |
| SCAIL-2 character replacement | highest fidelity | keeps the reference's own background and vignette, so not usable as-is |
| Wan 2.2 Fun Control A14B, pose | 1.99, on time | 75 GPU s; identity holds; frame 0 follows the reference pose, not the keyframe |
| LTX-2 pose / LTX 2.3 IC-LoRA | lags and spins / on time but mushy faces | not usable / drafts only |
| Kling 3.0 Motion Control (closed, for comparison) | 1.91 | polished, but turns him away from the camera; partner credits |

Reviewed side by side, Wan Animate 2's moves were the most faithful, so it is the `clip.motion` default; `minimax-h3-motion` stays for clips that must open exactly on the keyframe. Two pipeline fixes mattered as much as the model: motion jobs now keep the reference's real speed
(`fit: "realtime"`: the clip is as long as the source move, with extra frames replayed backwards
instead of the move being stretched over the clip), and pose extraction finds each person with
RT-DETR before reading the skeleton (it used to read a fixed 512×512 corner). The animated-WebP
control clips also get faint temporal noise, because the encoder merges identical frames and a
held or still source would otherwise lose frames.

