import { Graph, h3Frames, type Link, sizeForAspect, snap, wanFrames } from "./graph.js";

export const OPERATIONS = ["still.compose", "still.generate", "still.face", "clip.i2v", "clip.r2v", "clip.motion", "clip.flf", "matte", "upscale"] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface ModelFile {
  name: string;
  folder: string;
  url: string;
}

const HF = "https://huggingface.co";
const M = {
  qwenEdit: { name: "qwen_image_edit_2511_fp8mixed.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors` },
  qwenEditLightning: { name: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", folder: "loras", url: `${HF}/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` },
  qwenVl: { name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors` },
  qwenVae: { name: "qwen_image_vae.safetensors", folder: "vae", url: `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors` },
  klein9b: { name: "flux-2-klein-9b-fp8.safetensors", folder: "diffusion_models", url: `${HF}/black-forest-labs/FLUX.2-klein-9b-fp8/resolve/main/flux-2-klein-9b-fp8.safetensors` },
  qwen3_8b: { name: "qwen_3_8b_fp8mixed.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors` },
  flux2Vae: { name: "full_encoder_small_decoder.safetensors", folder: "vae", url: `${HF}/black-forest-labs/FLUX.2-small-decoder/resolve/main/full_encoder_small_decoder.safetensors` },
  zImage: { name: "z_image_turbo_bf16.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors` },
  qwen3_4b: { name: "qwen_3_4b.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors` },
  aeVae: { name: "ae.safetensors", folder: "vae", url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors` },
  umt5: { name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` },
  wan21Vae: { name: "wan_2.1_vae.safetensors", folder: "vae", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors` },
  wan22Vae: { name: "wan2.2_vae.safetensors", folder: "vae", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors` },
  i2vHigh: { name: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` },
  i2vLow: { name: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` },
  i2vLoraHigh: { name: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", folder: "loras", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` },
  i2vLoraLow: { name: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", folder: "loras", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` },
  ti2v5b: { name: "wan2.2_ti2v_5B_fp16.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors` },
  funHigh: { name: "wan2.2_fun_control_high_noise_14B_fp8_scaled.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_fun_control_high_noise_14B_fp8_scaled.safetensors` },
  funLow: { name: "wan2.2_fun_control_low_noise_14B_fp8_scaled.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_fun_control_low_noise_14B_fp8_scaled.safetensors` },
  fun5b: { name: "wan2.2_fun_control_5B_bf16.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_fun_control_5B_bf16.safetensors` },
  seedvr2_7bSharp: { name: "seedvr2_7b_sharp_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_7b_sharp_int8_convrot.safetensors` },
  seedvr2_7b: { name: "seedvr2_7b_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_7b_int8_convrot.safetensors` },
  seedvr2_3b: { name: "seedvr2_3b_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors` },
  seedvr2Vae: { name: "seedvr2_ema_vae_fp16.safetensors", folder: "vae", url: `${HF}/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors` },
  birefnet: { name: "birefnet.safetensors", folder: "background_removal", url: `${HF}/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors` },
  sdpose: { name: "sdpose_wholebody_fp16.safetensors", folder: "checkpoints", url: `${HF}/Comfy-Org/SDPose/resolve/main/checkpoints/sdpose_wholebody_fp16.safetensors` },
  marigold: { name: "qwen_image_edit_2509_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/marigold-v2-0/resolve/main/diffusion_models/qwen_image_edit_2509_int8_convrot.safetensors` },
  marigoldDepth: { name: "marigold_v2_depth_log_stage2.safetensors", folder: "loras", url: `${HF}/Comfy-Org/marigold-v2-0/resolve/main/loras/marigold_v2_depth_log_stage2.safetensors` },
  marigoldDepthVae: { name: "marigold_v2_depth_log_stage2_vae.safetensors", folder: "vae", url: `${HF}/Comfy-Org/marigold-v2-0/resolve/main/vae/marigold_v2_depth_log_stage2_vae.safetensors` },
  marigoldDepthCond: { name: "marigold_v2_depth_conditioning.safetensors", folder: "embeddings", url: `${HF}/Comfy-Org/marigold-v2-0/resolve/main/embeddings/marigold_v2_depth_conditioning.safetensors` },
  da3: { name: "depth_anything_3_mono_large.safetensors", folder: "geometry_estimation", url: `${HF}/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_mono_large.safetensors` },
  flux3Klein: { name: "flux3_image_klein_sd_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Flux-3-Image/resolve/main/diffusion_models/flux3_image_klein_sd_int8_convrot.safetensors` },
  qwen3vl4b: { name: "qwen3vl_4b_int8_convrot.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/Flux-3-Image/resolve/main/text_encoders/qwen3vl_4b_int8_convrot.safetensors` },
  flux2DevVae: { name: "flux2-vae.safetensors", folder: "vae", url: `${HF}/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors` },
  qwen21: { name: "qwen_image_2.1_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors` },
  qwen21Turbo: { name: "qwen_image_2.1_turbo_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors` },
  qwen3vl8b: { name: "qwen3vl_8b_int8_convrot.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors` },
  qwen21Vae: { name: "qwen_image_2.1_vae_bf16.safetensors", folder: "vae", url: `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors` },
  fireRed: { name: "FireRed-Image-Edit-1.1-transformer.safetensors", folder: "diffusion_models", url: `${HF}/FireRedTeam/FireRed-Image-Edit-1.1-ComfyUI/resolve/main/FireRed-Image-Edit-1.1-transformer.safetensors` },
  fireRedLightning: { name: "FireRed-Image-Edit-1.0-Lightning-8steps-v1.0.safetensors", folder: "loras", url: `${HF}/FireRedTeam/FireRed-Image-Edit-1.0-Lightning/resolve/main/FireRed-Image-Edit-1.0-Lightning-8steps-v1.0.safetensors` },
  booguEdit: { name: "boogu_image_edit_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Boogu-Image/resolve/main/diffusion_models/boogu_image_edit_int8_convrot.safetensors` },
  qwen3vl8bFp8: { name: "qwen3vl_8b_fp8_scaled.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_fp8_scaled.safetensors` },
  booguEditTurbo: { name: "boogu_image_edit_turbo_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Boogu-Image/resolve/main/diffusion_models/boogu_image_edit_turbo_int8_convrot.safetensors` },
  krea2Style: { name: "krea2_style_reference.safetensors", folder: "loras", url: `${HF}/Comfy-Org/Krea-2/resolve/main/loras/krea2_style_reference.safetensors` },
  mageEditTurbo: { name: "mage_flow_edit_turbo_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Mage-Flow/resolve/main/diffusion_models/mage_flow_edit_turbo_int8_convrot.safetensors` },
  qwen3vl4bBf16: { name: "qwen3vl_4b_bf16.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors` },
  mageVae: { name: "mage_flow_vae_bf16.safetensors", folder: "vae", url: `${HF}/Comfy-Org/Mage-Flow/resolve/main/vae/mage_flow_vae_bf16.safetensors` },
  krea2Turbo: { name: "krea2_turbo_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors` },
  qwen3vl4bFp8: { name: "qwen3vl_4b_fp8_scaled.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors` },
  ernieTurbo: { name: "ernie-image-turbo.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/ERNIE-Image/resolve/main/diffusion_models/ernie-image-turbo.safetensors` },
  ministral3b: { name: "ministral-3-3b.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors` },
  lensTurbo: { name: "lens_turbo_bf16.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Lens/resolve/main/diffusion_models/lens_turbo_bf16.safetensors` },
  gptOss20b: { name: "gpt_oss_20b_nvfp4.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/Lens/resolve/main/text_encoders/gpt_oss_20b_nvfp4.safetensors` },
  h3Fl2v: { name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` },
  h3Fl2vTurbo: { name: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", folder: "loras", url: `${HF}/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` },
  h3Ref2v: { name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` },
  h3Ref2vTurbo: { name: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", folder: "loras", url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` },
  h3Text: { name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", folder: "text_encoders", url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` },
  h3Vae: { name: "minimax_h3_video_vae_int8_convrot.safetensors", folder: "vae", url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors` },
  h3AudioVae: { name: "minimax_h3_audio_vae_fp32.safetensors", folder: "vae", url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors` },
  h3FunControl: { name: "minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors", folder: "model_patches", url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/model_patches/minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors` },
  rtDetr: { name: "rt_detr_v4-x-hgnet_fp16.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/SDPose/resolve/main/diffusion_models/rt_detr_v4-x-hgnet_fp16.safetensors` },
  wanAnimate2: { name: "wan_animate_2_int8_convrot.safetensors", folder: "diffusion_models", url: `${HF}/Comfy-Org/Wan-Animate-2/resolve/main/diffusion_models/wan_animate_2_int8_convrot.safetensors` },
  wanAnimate2Lora: { name: "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", folder: "loras", url: `${HF}/Comfy-Org/Wan-Animate-2/resolve/main/loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors` },
  clipVisionH: { name: "clip_vision_h.safetensors", folder: "clip_vision", url: `${HF}/Comfy-Org/Wan-Animate-2/resolve/main/clip_vision/clip_vision_h.safetensors` },
} satisfies Record<string, ModelFile>;

/** Wan's standard negative prompt (from the official templates), with an English tail for aura edits. */
export const WAN_NEGATIVE =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走, text, subtitles, watermark, logo, extra people, morphing face, identity change";

/**
 * The licence of a profile's main weights, summarised from its model card (not legal advice).
 * commercial: "yes" (permissive), "no" (non-commercial only) or "restricted" (commercial use with
 * conditions such as revenue caps, excluded territories or attribution, or a licence we could not verify).
 */
export interface License {
  name: string;
  url?: string;
  commercial: "yes" | "no" | "restricted";
  note?: string;
}

const LICENSES = {
  apache: { name: "Apache-2.0", commercial: "yes" },
  mit: { name: "MIT", commercial: "yes" },
  qwenResearch: {
    name: "Qwen Research License",
    url: `${HF}/Qwen/Qwen-Image-2.1/blob/main/LICENSE`,
    commercial: "no",
    note: "Research and evaluation use only.",
  },
  minimaxH3: {
    name: "MiniMax H3 Community License",
    url: `${HF}/MiniMaxAI/MiniMax-H3/blob/main/LICENSE`,
    commercial: "restricted",
    note: "Use of the open weights and their outputs in the United States, European Union, United Kingdom and South Korea is not licensed, whether on your own GPU or on a hosted service such as Comfy Cloud; a product that uses it must show “MiniMax H3” in its interface; separate authorisation above US$20M annual revenue; outputs may not be used to train other models. Comfy states that Comfy Cloud generations include commercial rights: check that this covers your territory. MiniMax's own API is under separate terms.",
  },
  fluxNonCommercial: {
    name: "FLUX Non-Commercial License",
    url: `${HF}/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md`,
    commercial: "no",
    note: "The 4B klein models are Apache-2.0; this 9B is not.",
  },
  fluxKommunity: {
    name: "FLUX Kommunity License v1.0",
    url: `${HF}/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md`,
    commercial: "restricted",
    note: "Commercial output only for organisations under US$5M gross annual revenue (affiliates included); otherwise a licence from Black Forest Labs.",
  },
  krea2: {
    name: "Krea 2 Community License",
    // The model card's licence link; the repo copy is behind the gate.
    url: "https://cdn.jsdelivr.net/gh/krea-ai/krea-2@db3984fbc6e13b34c0064990fc2d95ac64d00058/assets/hf_samples/LICENSE.pdf",
    commercial: "restricted",
    note: "Commercial use only for organisations under US$1M total annual revenue, plus content-filtering and pass-through obligations.",
  },
} satisfies Record<string, License>;

/** A licence the repackaged card names but the original model card no longer shows publicly. */
const unverified = (name: string, repo: string): License => ({ name, url: `${HF}/${repo}`, commercial: "restricted", note: "unverified: see model card" });

export interface Profile {
  id: string;
  operation: Operation;
  title: string;
  tier: "quality" | "lite";
  license: License;
  /** Used only when named (a profile override or a job's profile): never picked as a default or fallback. */
  /**
   * The control frames this clip.motion profile can follow (any when unset). Wan Animate 2 reads
   * people's motion straight from the frames, so it can't follow depth or a camera move.
   */
  controls?: readonly ("pose" | "depth" | "edges" | "camera")[];
  optIn?: boolean;
  /** Native output frame rate for clip operations. */
  fps?: number;
  /** Default long side of generated media, in pixels. */
  longSide: number;
  models: ModelFile[];
  /** Core node classes the graph needs; checked against /object_info. */
  nodes: string[];
  /** Rough seconds of GPU time on a datacenter GPU, per unit (image, or per 81 frames for clips). */
  baseSeconds: number;
  /** Frame-count rule for clips: Wan models need 4n+1 frames, MiniMax H3 needs 17n+5. */
  frames?: "wan" | "h3";
  /** Pixel step that width and height must be multiples of (default 16). */
  sizeStep?: number;
  notes: string;
}

export const PROFILES: Profile[] = [
  {
    id: "qwen-edit-2511",
    operation: "still.compose",
    title: "Qwen-Image-Edit 2511 + Lightning (multi-reference keyframe)",
    tier: "quality",
    license: LICENSES.apache,
    longSide: 1344,
    models: [M.qwenEdit, M.qwenEditLightning, M.qwenVl, M.qwenVae],
    nodes: ["TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "CFGNorm", "ModelSamplingAuraFlow", "ImageScale"],
    baseSeconds: 12,
    notes: "Up to 3 images. image1 sets the canvas and look (use the reference style frame); later images supply identity and location.",
  },
  {
    id: "flux3-klein-edit",
    operation: "still.compose",
    title: "FLUX 3 Image Klein, distilled (multi-reference keyframe, Oct 2026)",
    tier: "quality",
    license: LICENSES.fluxKommunity,
    optIn: true,
    longSide: 1536,
    models: [M.flux3Klein, M.qwen3vl4b, M.flux2DevVae],
    nodes: ["ReferenceMultiLatent", "EmptyFlux2LatentImage", "ConditioningZeroOut"],
    baseSeconds: 10,
    notes: "Up to 10 images; prompts can say image 1, image 2… (sent as <ref_image_0>…). Strong identity across inputs; output size is free. FLUX Kommunity License (commercial output only under US$5M revenue): used only when named.",
  },
  {
    id: "qwen21-turbo-edit",
    operation: "still.compose",
    title: "Qwen-Image 2.1 Turbo (identity keyframes, 8 steps)",
    tier: "lite",
    license: LICENSES.qwenResearch,
    longSide: 1536,
    models: [M.qwen21Turbo, M.qwen3vl8b, M.qwen21Vae],
    nodes: ["TextEncodeQwenImage21", "QwenImage21Cache", "ManualSigmas", "CFGGuider", "SamplerCustomAdvanced"],
    baseSeconds: 6,
    sizeStep: 32,
    notes: "Same likeness as qwen21-edit at a third of the steps, but punchier, more plasticky renders and occasional colour blobs: good for drafts. Identity-first recipe: image 1 = the subject photo, image 2 = its face crop (still.face), the shot described in words; never pass a frame with a person in it. Qwen Research License: non-commercial, so commercial: true skips it.",
  },
  {
    id: "qwen21-edit",
    operation: "still.compose",
    title: "Qwen-Image 2.1 (identity keyframes, 25 steps)",
    tier: "quality",
    license: LICENSES.qwenResearch,
    longSide: 1536,
    models: [M.qwen21, M.qwen3vl8b, M.qwen21Vae],
    nodes: ["TextEncodeQwenImage21", "QwenImage21Cache"],
    baseSeconds: 20,
    sizeStep: 32,
    notes: "The default for keyframes: the most natural, photographic results with the strongest likeness in our tests. Identity-first recipe: image 1 = the subject photo, image 2 = its face crop (still.face), the shot described in words (framing, lens, pose, expression, place, light). Never pass a frame with a person in it: image 1 is treated as the picture to edit. Qwen Research License: non-commercial (research and evaluation only); with commercial: true the default moves to boogu-edit.",
  },
  {
    id: "face-crop",
    operation: "still.face",
    title: "Face crop (YOLOv8 face detector)",
    tier: "quality",
    license: { name: "Apache-2.0 (face_yolov8m weights)", url: `${HF}/Bingsu/adetailer`, commercial: "yes", note: "The detector runs through Ultralytics YOLOv8 code (AGPL-3.0) inside the ComfyUI FaceParsing node." },
    longSide: 1024,
    models: [],
    nodes: ["BBoxDetectorLoader(FaceParsing)", "BBoxDetect(FaceParsing)", "BBoxListItemSelect(FaceParsing)", "ImageCropWithBBox(FaceParsing)"],
    baseSeconds: 2,
    notes: "Crops the largest face of image 1 with hair, ears and collar. Give it to every keyframe as an extra identity image: likeness improves markedly.",
  },
  {
    id: "flux3-klein",
    operation: "still.generate",
    title: "FLUX 3 Image Klein, distilled (text to image)",
    tier: "quality",
    license: LICENSES.fluxKommunity,
    optIn: true,
    longSide: 1536,
    models: [M.flux3Klein, M.qwen3vl4b, M.flux2DevVae],
    nodes: ["EmptyFlux2LatentImage", "ConditioningZeroOut"],
    baseSeconds: 8,
    notes: "Location plates and inserts; strong prompt following and text rendering. FLUX Kommunity License (commercial output only under US$5M revenue): used only when named.",
  },
  {
    id: "qwen21",
    operation: "still.generate",
    title: "Qwen-Image 2.1 (text to image, full model)",
    tier: "quality",
    license: LICENSES.qwenResearch,
    longSide: 1536,
    models: [M.qwen21, M.qwen3vl8b, M.qwen21Vae],
    nodes: ["TextEncodeQwenImage21", "QwenImage21Cache"],
    baseSeconds: 20,
    sizeStep: 32,
    notes: "Location plates (no people) from the same weights as the qwen21-edit keyframes, so plates cost no extra download and match the keyframes' look. Qwen Research License: non-commercial; commercial: true falls back to Z-Image Turbo (Apache-2.0).",
  },
  {
    id: "qwen21-turbo",
    operation: "still.generate",
    title: "Qwen-Image 2.1 Turbo (text to image)",
    tier: "quality",
    license: LICENSES.qwenResearch,
    longSide: 1536,
    models: [M.qwen21Turbo, M.qwen3vl8b, M.qwen21Vae],
    nodes: ["TextEncodeQwenImage21", "QwenImage21Cache", "ManualSigmas"],
    baseSeconds: 10,
    sizeStep: 32,
    notes: "Location plates; native 2K. Qwen Research License: non-commercial.",
  },
  {
    id: "firered-edit-1.1",
    operation: "still.compose",
    title: "FireRed-Image-Edit 1.1 + Lightning 8-step (identity-focused multi-reference keyframe)",
    tier: "quality",
    license: LICENSES.apache,
    longSide: 1344,
    models: [M.fireRed, M.fireRedLightning, M.qwenVl, M.qwenVae],
    nodes: ["TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "CFGNorm", "ModelSamplingAuraFlow", "ImageScale"],
    baseSeconds: 16,
    notes: "Up to 3 images, same conventions as Qwen-Edit 2511 (image1 sets the canvas). Tuned for portrait consistency.",
  },
  {
    id: "mage-flow-edit-turbo",
    operation: "still.compose",
    title: "Mage-Flow-Edit Turbo 4B (fast multi-reference edit)",
    tier: "lite",
    license: unverified("MIT (per the Comfy-Org repackage)", "Comfy-Org/Mage-Flow"),
    optIn: true,
    longSide: 1344,
    models: [M.mageEditTurbo, M.qwen3vl4bBf16, M.mageVae],
    nodes: ["TextEncodeMageFlowEdit"],
    baseSeconds: 4,
    notes: "4 steps. References are resized to the output size. Licence unverified (the original model card is not public): used only when named.",
  },
  {
    id: "boogu-edit",
    operation: "still.compose",
    title: "Boogu Image Edit 0.1 (multi-reference keyframe, best likeness in tests)",
    tier: "quality",
    license: LICENSES.apache,
    longSide: 1344,
    models: [M.booguEdit, M.qwen3vl8bFp8, M.aeVae],
    nodes: ["TextEncodeBooguEdit", "SamplerCustom", "BasicScheduler"],
    baseSeconds: 14,
    notes: "Best likeness and instruction following in our tests (docs/models.md). Image 1 sets framing and light, image 2 the identity; for face close-ups pass only the identity image and describe the framing.",
  },
  {
    id: "boogu-edit-turbo",
    operation: "still.compose",
    title: "Boogu Image Edit 0.1 Turbo (4-step multi-reference keyframe)",
    tier: "lite",
    license: LICENSES.apache,
    longSide: 1344,
    models: [M.booguEditTurbo, M.qwen3vl8bFp8, M.aeVae],
    nodes: ["TextEncodeBooguEdit"],
    baseSeconds: 4,
    notes: "Distilled Boogu Edit: 4 steps. Same image conventions as boogu-edit.",
  },
  {
    id: "krea2-style-reference",
    operation: "still.compose",
    title: "Krea 2 Turbo + style reference (a new picture in an image's look; not identity)",
    tier: "quality",
    license: LICENSES.krea2,
    optIn: true,
    longSide: 1536,
    models: [M.krea2Turbo, M.krea2Style, M.qwen3vl4bFp8, M.qwenVae],
    nodes: ["TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "ModelSamplingFlux", "CFGGuider", "SamplerCustomAdvanced"],
    baseSeconds: 7,
    notes: "Takes the look (light, grade, texture) of image 1, never the person: for plates and inserts that must match a reference frame. Krea 2 Community License: commercial use only for organisations under US$1M total annual revenue, with content-filtering and pass-through obligations; used only when named.",
  },
  {
    id: "krea2-turbo",
    operation: "still.generate",
    title: "Krea 2 Turbo (text to image, photographic plates)",
    tier: "quality",
    license: LICENSES.krea2,
    optIn: true,
    longSide: 1536,
    models: [M.krea2Turbo, M.qwen3vl4bFp8, M.qwenVae],
    nodes: ["EmptyLatentImage", "ConditioningZeroOut"],
    baseSeconds: 6,
    notes: "8 steps; the most photographic plates in our tests. Krea 2 Community License: commercial use only for organisations under US$1M total annual revenue, with content-filtering and pass-through obligations; used only when named.",
  },
  {
    id: "ernie-image-turbo",
    operation: "still.generate",
    title: "ERNIE-Image Turbo (text to image)",
    tier: "lite",
    license: LICENSES.apache,
    longSide: 1536,
    models: [M.ernieTurbo, M.ministral3b, M.flux2DevVae],
    nodes: ["EmptyFlux2LatentImage", "ConditioningZeroOut"],
    baseSeconds: 6,
    notes: "8 steps.",
  },
  {
    id: "lens-turbo",
    operation: "still.generate",
    title: "Lens Turbo (text to image, 4 steps)",
    tier: "lite",
    license: unverified("MIT (per the Comfy-Org repackage)", "Comfy-Org/Lens"),
    optIn: true,
    longSide: 1536,
    models: [M.lensTurbo, M.gptOss20b, M.flux2DevVae],
    nodes: ["ModelSamplingFlux", "CFGNorm", "SamplerCustom", "BasicScheduler"],
    baseSeconds: 5,
    notes: "4 steps; good text rendering. Licence unverified (the original model card is not public): used only when named.",
  },
  {
    id: "flux2-klein-9b",
    operation: "still.compose",
    title: "FLUX.2 klein 9B (fast multi-reference edit)",
    tier: "lite",
    license: LICENSES.fluxNonCommercial,
    optIn: true,
    longSide: 1024,
    models: [M.klein9b, M.qwen3_8b, M.flux2Vae],
    nodes: ["ReferenceLatent", "EmptyFlux2LatentImage", "Flux2Scheduler", "CFGGuider", "SamplerCustomAdvanced", "ImageScaleToTotalPixels"],
    baseSeconds: 5,
    notes: "Fits 24–48 GB machines, including Apple Silicon. Weaker identity than Qwen 2511. FLUX Non-Commercial License: used only when named.",
  },
  {
    id: "z-image-turbo",
    operation: "still.generate",
    title: "Z-Image Turbo (text to image, location plates)",
    tier: "lite",
    license: LICENSES.apache,
    longSide: 1344,
    models: [M.zImage, M.qwen3_4b, M.aeVae],
    nodes: ["EmptySD3LatentImage", "ModelSamplingAuraFlow"],
    baseSeconds: 4,
    notes: "8 steps, Apache-2.0: the plate model in commercial mode (the default plates come from Qwen-Image 2.1). Use for empty environment plates; never ask it for the hero.",
  },
  {
    id: "wan22-14b-i2v",
    operation: "clip.i2v",
    title: "Wan 2.2 I2V A14B + lightx2v 4-step",
    tier: "quality",
    license: LICENSES.apache,
    fps: 16,
    longSide: 832,
    models: [M.i2vHigh, M.i2vLow, M.i2vLoraHigh, M.i2vLoraLow, M.umt5, M.wan21Vae],
    nodes: ["WanImageToVideo", "KSamplerAdvanced", "ModelSamplingSD3", "CreateVideo", "SaveVideo"],
    baseSeconds: 75,
    notes: "16 fps native. Best for slow-motion hero moments: hair, cloth, a head turn, a push-in.",
  },
  {
    id: "wan22-5b-ti2v",
    operation: "clip.i2v",
    title: "Wan 2.2 TI2V 5B",
    tier: "lite",
    license: LICENSES.apache,
    fps: 24,
    longSide: 1280,
    models: [M.ti2v5b, M.umt5, M.wan22Vae],
    nodes: ["Wan22ImageToVideoLatent", "ModelSamplingSD3", "CreateVideo", "SaveVideo"],
    baseSeconds: 90,
    notes: "24 fps, runs on 24 GB GPUs and Apple Silicon (slowly). Weaker motion and identity than A14B.",
  },
  {
    id: "wan22-14b-fun-control",
    operation: "clip.motion",
    title: "Wan 2.2 Fun Control A14B (motion from the reference shot)",
    tier: "quality",
    license: LICENSES.apache,
    fps: 16,
    longSide: 832,
    models: [M.funHigh, M.funLow, M.umt5, M.wan21Vae],
    nodes: ["Wan22FunControlToVideo", "KSamplerAdvanced", "ModelSamplingSD3", "CreateVideo", "SaveVideo"],
    baseSeconds: 300,
    notes: "Re-performs the reference shot's motion and camera path (edge or depth control) with the keyframe as the start image.",
  },
  {
    id: "wan22-5b-fun-control",
    operation: "clip.motion",
    title: "Wan 2.2 Fun Control 5B",
    tier: "lite",
    license: LICENSES.apache,
    fps: 24,
    longSide: 832,
    models: [M.fun5b, M.umt5, M.wan22Vae],
    nodes: ["Wan22FunControlToVideo", "ModelSamplingSD3", "CreateVideo", "SaveVideo"],
    baseSeconds: 120,
    notes: "Lighter motion transfer for 24 GB GPUs and Apple Silicon.",
  },
  {
    id: "wan22-14b-flf",
    operation: "clip.flf",
    title: "Wan 2.2 A14B first/last frame + lightx2v 4-step",
    tier: "quality",
    license: LICENSES.apache,
    fps: 16,
    longSide: 832,
    models: [M.i2vHigh, M.i2vLow, M.i2vLoraHigh, M.i2vLoraLow, M.umt5, M.wan21Vae],
    nodes: ["WanFirstLastFrameToVideo", "KSamplerAdvanced", "ModelSamplingSD3", "CreateVideo", "SaveVideo"],
    baseSeconds: 80,
    notes: "Morphs and transitions between two accepted stills.",
  },
  {
    id: "minimax-h3-i2v",
    operation: "clip.i2v",
    title: "MiniMax H3 image-to-video (full model, 20 steps)",
    tier: "quality",
    license: LICENSES.minimaxH3,
    fps: 24,
    longSide: 1344,
    models: [M.h3Fl2v, M.h3Text, M.h3Vae, M.h3AudioVae],
    nodes: ["MiniMaxH3ImageToVideo", "SamplerCustomAdvanced", "BasicGuider", "CreateVideo", "SaveVideo"],
    baseSeconds: 115,
    frames: "h3",
    sizeStep: 32,
    notes: "The default for clips: 24 fps native, real body motion (full spins, runs), locked close-ups that hold the likeness, and camera work. Renders on H3's native canvas (768×1344 vertical, 1024×768 for 4:3); frames come in steps of 17. A big move where the face turns away (a spin, a turn) belongs on minimax-h3-flf with an end frame, so the face comes back right. Its native audio is not used. MiniMax H3 Community License: no use of the open weights in the US, EU, UK or South Korea, Comfy Cloud included; show “MiniMax H3” in the interface of a product that uses it (see license). Wan 2.2 is the Apache-2.0 alternative.",
  },
  {
    id: "minimax-h3-i2v-turbo",
    operation: "clip.i2v",
    title: "MiniMax H3 image-to-video + 8-step turbo",
    tier: "lite",
    license: LICENSES.minimaxH3,
    fps: 24,
    longSide: 960,
    models: [M.h3Fl2v, M.h3Fl2vTurbo, M.h3Text, M.h3Vae, M.h3AudioVae],
    nodes: ["MiniMaxH3ImageToVideo", "SamplerCustomAdvanced", "BasicGuider", "CreateVideo", "SaveVideo"],
    baseSeconds: 28,
    frames: "h3",
    sizeStep: 32,
    notes: "About 4× faster than the full model with the same motion; small push-ins creep into locked shots and faces are slightly less exact. For drafts and the lite tier. MiniMax H3 Community License: no use of the open weights in the US, EU, UK or South Korea, Comfy Cloud included; show “MiniMax H3” in the interface of a product that uses it (see license). Wan 2.2 is the Apache-2.0 alternative.",
  },
  {
    id: "minimax-h3-flf",
    operation: "clip.flf",
    title: "MiniMax H3 first/last frame (full model, 20 steps)",
    tier: "quality",
    license: LICENSES.minimaxH3,
    fps: 24,
    longSide: 1344,
    models: [M.h3Fl2v, M.h3Text, M.h3Vae, M.h3AudioVae],
    nodes: ["MiniMaxH3ImageToVideo", "SamplerCustomAdvanced", "BasicGuider", "CreateVideo", "SaveVideo"],
    baseSeconds: 120,
    frames: "h3",
    sizeStep: 32,
    notes: "Two accepted stills as the first and last frame: spins and turns that end on the right face, morphs and transitions. The turbo variant tends to take a shortcut (a quarter turn) on big moves, so use this one for them. MiniMax H3 Community License: no use of the open weights in the US, EU, UK or South Korea, Comfy Cloud included; show “MiniMax H3” in the interface of a product that uses it (see license). Wan 2.2 is the Apache-2.0 alternative.",
  },
  {
    id: "minimax-h3-flf-turbo",
    operation: "clip.flf",
    title: "MiniMax H3 first/last frame + 8-step turbo",
    tier: "lite",
    license: LICENSES.minimaxH3,
    fps: 24,
    longSide: 960,
    models: [M.h3Fl2v, M.h3Fl2vTurbo, M.h3Text, M.h3Vae, M.h3AudioVae],
    nodes: ["MiniMaxH3ImageToVideo", "SamplerCustomAdvanced", "BasicGuider", "CreateVideo", "SaveVideo"],
    baseSeconds: 22,
    frames: "h3",
    sizeStep: 32,
    notes: "Fast first/last-frame transitions for drafts; shortcuts big body moves. MiniMax H3 Community License: no use of the open weights in the US, EU, UK or South Korea, Comfy Cloud included; show “MiniMax H3” in the interface of a product that uses it (see license). Wan 2.2 is the Apache-2.0 alternative.",
  },
  {
    id: "minimax-h3-r2v",
    operation: "clip.r2v",
    title: "MiniMax H3 reference-to-video (up to 9 references, full model)",
    tier: "quality",
    license: LICENSES.minimaxH3,
    fps: 24,
    longSide: 1344,
    models: [M.h3Ref2v, M.h3Text, M.h3Vae, M.h3AudioVae],
    nodes: ["MiniMaxH3ReferenceToVideo", "MiniMaxH3AddGuide", "SamplerCustomAdvanced", "BasicGuider", "CreateVideo", "SaveVideo"],
    baseSeconds: 106,
    frames: "h3",
    sizeStep: 32,
    notes: "New shots from reference images (identity, outfit, location) with optional accepted keyframes pinned as the first and last frame. Refer to references as <Picture 1>…<Picture n> in the prompt. Holds identity through turns when given start and end guides. MiniMax H3 Community License: no use of the open weights in the US, EU, UK or South Korea, Comfy Cloud included; show “MiniMax H3” in the interface of a product that uses it (see license). Wan 2.2 is the Apache-2.0 alternative.",
  },
  {
    id: "minimax-h3-r2v-turbo",
    operation: "clip.r2v",
    title: "MiniMax H3 reference-to-video + 4-step turbo",
    tier: "lite",
    license: LICENSES.minimaxH3,
    fps: 24,
    longSide: 960,
    models: [M.h3Ref2v, M.h3Ref2vTurbo, M.h3Text, M.h3Vae, M.h3AudioVae],
    nodes: ["MiniMaxH3ReferenceToVideo", "MiniMaxH3AddGuide", "SamplerCustomAdvanced", "BasicGuider", "CreateVideo", "SaveVideo"],
    baseSeconds: 16,
    frames: "h3",
    sizeStep: 32,
    notes: "Fast reference-to-video for drafts. MiniMax H3 Community License: no use of the open weights in the US, EU, UK or South Korea, Comfy Cloud included; show “MiniMax H3” in the interface of a product that uses it (see license). Wan 2.2 is the Apache-2.0 alternative.",
  },
  {
    id: "minimax-h3-motion",
    operation: "clip.motion",
    title: "MiniMax H3 + Fun ControlNet Union (motion from the reference shot)",
    tier: "quality",
    license: LICENSES.minimaxH3,
    fps: 24,
    longSide: 1024,
    models: [M.h3Fl2v, M.h3Fl2vTurbo, M.h3FunControl, M.h3Text, M.h3Vae, M.h3AudioVae],
    nodes: ["MiniMaxH3FunControlNetApply", "ModelPatchLoader", "MiniMaxH3ImageToVideo", "SamplerCustomAdvanced", "BasicGuider", "CreateVideo", "SaveVideo"],
    baseSeconds: 30,
    frames: "h3",
    sizeStep: 32,
    notes: "Re-performs a reference shot's body motion at its real speed from pose skeletons, opening exactly on the start keyframe (which should already stand in the reference's first pose and framing), with fuller reach than wan-animate2 but a looser copy of the move. Turbo LoRA at 6 steps (tested best for this). Weak spots: the face softens when the body turns away, and the light can flare mid-clip. MiniMax H3 Community License: no use of the open weights in the US, EU, UK or South Korea, Comfy Cloud included; show “MiniMax H3” in the interface of a product that uses it (see license). Wan 2.2 is the Apache-2.0 alternative.",
  },
  {
    id: "minimax-h3-motion-ref",
    operation: "clip.motion",
    title: "MiniMax H3 reference-to-video + Fun ControlNet Union (camera and motion from the reference shot)",
    tier: "quality",
    license: LICENSES.minimaxH3,
    fps: 24,
    longSide: 1024,
    models: [M.h3Ref2v, M.h3FunControl, M.h3Text, M.h3Vae, M.h3AudioVae],
    nodes: ["MiniMaxH3FunControlNetApply", "ModelPatchLoader", "MiniMaxH3ReferenceToVideo", "MiniMaxH3AddGuide", "SamplerCustomAdvanced", "BasicGuider", "CreateVideo", "SaveVideo"],
    baseSeconds: 90,
    frames: "h3",
    sizeStep: 32,
    notes: "For a subject that isn't a person (a car, a product) and for camera moves a still can't fake (orbits, arcs, parallax): the subject's photos as references, the accepted keyframe pinned at frame 0, and the reference shot's depth (`control: \"depth\"`) driving the camera. Lower the control `strength` (about 0.6) when the reference's subject has a different shape, so its geometry doesn't carry over. MiniMax H3 Community License: no use of the open weights in the US, EU, UK or South Korea, Comfy Cloud included; show “MiniMax H3” in the interface of a product that uses it (see license). Wan 2.2 is the Apache-2.0 alternative.",
  },
  {
    id: "wan-animate2",
    operation: "clip.motion",
    title: "Wan Animate 2 motion transfer + lightx2v",
    tier: "quality",
    license: LICENSES.apache,
    fps: 24,
    longSide: 832,
    models: [M.wanAnimate2, M.wanAnimate2Lora, M.umt5, M.clipVisionH, M.wan21Vae],
    nodes: ["WanAnimate2ToVideo", "WanAnimate2Cache", "CLIPVisionEncode", "TrimVideoLatent", "SamplerCustom", "CreateVideo", "SaveVideo"],
    controls: ["pose"],
    baseSeconds: 55,
    frames: "wan",
    notes: "The default for re-performing a reference shot's move (fights, dance, sport): motion straight from the reference frames, no skeleton, the most faithful frame-for-frame copy with clean limbs. The hero image sets identity and outfit; the background comes from the prompt, not the image, so describe the place and light. It can borrow the performer's build (bulkier body) and lighten the clothes. Apache-2.0.",
  },
  {
    id: "birefnet",
    operation: "matte",
    title: "BiRefNet background removal",
    tier: "lite",
    license: LICENSES.mit,
    longSide: 1024,
    models: [M.birefnet],
    nodes: ["LoadBackgroundRemovalModel", "RemoveBackground"],
    baseSeconds: 2,
    notes: "Subject alpha for text-behind-subject and cut-outs: an RGBA still for an image, or a white-on-black mask clip for a video.",
  },
  ...(
    [
      // GPU seconds for 81 frames at 1920×1080 (stills count as one frame's share).
      ["seedvr2-7b-sharp", "SeedVR2 7B sharp (one-step video and image upscale, crisp detail)", "quality", "seedvr2_7bSharp", 90],
      ["seedvr2-7b", "SeedVR2 7B (one-step video and image upscale, softer than sharp)", "quality", "seedvr2_7b", 90],
      ["seedvr2-3b", "SeedVR2 3B (one-step video and image upscale, lighter)", "lite", "seedvr2_3b", 45],
    ] as const
  ).map(([id, title, tier, model, baseSeconds]) => ({
    id,
    operation: "upscale" as const,
    title,
    tier,
    license: LICENSES.apache,
    longSide: 1920,
    // The output keeps the source's shape (even sides), not a 16-pixel grid.
    sizeStep: 2,
    models: [M[model], M.seedvr2Vae],
    nodes: ["SeedVR2Preprocess", "SeedVR2Conditioning", "SeedVR2PostProcessing", "VAEEncodeTiled", "VAEDecodeTiled", "KSampler"],
    baseSeconds,
    notes: "The finishing pass: an accepted clip or still made sharp at the delivery size (long side 1920 by default), same frames and timing, colours matched to the source. Apache-2.0.",
  })),
];

/** Valid clip length for a profile, at or above `frames`. */
export function clipFrames(prof: Profile, frames: number): number {
  return prof.frames === "h3" ? h3Frames(frames) : wanFrames(frames);
}

export function profile(id: string): Profile {
  const p = PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown profile "${id}". Known: ${PROFILES.map((x) => x.id).join(", ")}`);
  return p;
}

/**
 * Which profile each operation uses by default, best first. Picked from head-to-head tests
 * (docs/models.md). Opt-in profiles (newer and untested, or with restricted or unverified
 * licences) never appear here: they are used only by name.
 */
export const PREFERENCE: Partial<Record<Operation, { quality: string[]; lite: string[] }>> = {
  // Qwen-Image 2.1 gives the best keyframes but is non-commercial; commercial: true skips it for Boogu.
  "still.compose": { quality: ["qwen21-edit", "qwen21-turbo-edit", "boogu-edit", "qwen-edit-2511"], lite: ["qwen21-turbo-edit", "boogu-edit-turbo"] },
  "still.face": { quality: ["face-crop"], lite: ["face-crop"] },
  // Plates from the keyframe model's own weights: no extra download, the same look. Non-commercial, so
  // commercial: true moves plates to Z-Image Turbo (Apache-2.0), as it moves keyframes to Boogu.
  "still.generate": { quality: ["qwen21", "z-image-turbo", "ernie-image-turbo"], lite: ["qwen21-turbo", "z-image-turbo"] },
  // MiniMax H3 beat Wan 2.2 on body motion, locked close-ups and spins in our tests (docs/models.md); Wan stays as the Apache-2.0 fallback.
  "clip.i2v": { quality: ["minimax-h3-i2v", "wan22-14b-i2v"], lite: ["minimax-h3-i2v-turbo", "wan22-5b-ti2v"] },
  "clip.flf": { quality: ["minimax-h3-flf", "wan22-14b-flf"], lite: ["minimax-h3-flf-turbo", "wan22-14b-flf"] },
  "clip.r2v": { quality: ["minimax-h3-r2v"], lite: ["minimax-h3-r2v-turbo"] },
  // Wan Animate 2 copied the reference's moves most faithfully in our motion tests; H3 pose control is the alternative.
  "clip.motion": { quality: ["wan-animate2", "minimax-h3-motion", "wan22-14b-fun-control"], lite: ["wan-animate2", "wan22-5b-fun-control"] },
  // 7B sharp gave the crispest detail on our clips; 3B invents texture (lens fluting) and flickers more.
  upscale: { quality: ["seedvr2-7b-sharp", "seedvr2-7b", "seedvr2-3b"], lite: ["seedvr2-3b"] },
};

export interface ProfileFilter {
  /** Leave out non-commercial profiles (config.commercial). Restricted ones stay and are warned about. */
  commercial?: boolean;
  /** clip.motion: only profiles that can follow this kind of control frames. */
  control?: "pose" | "depth" | "edges" | "camera";
}

/** False when the commercial switch is on and the profile's licence is non-commercial. */
export function licenseAllows(p: Profile, commercial = false): boolean {
  return !commercial || p.license.commercial !== "no";
}

/**
 * The default profile for an operation and tier. With a backend catalog, the first preferred
 * profile the backend can actually run wins, so a ComfyUI without one model falls back cleanly.
 * Opt-in profiles are never a default, not even as the last fallback.
 */
export function defaultProfile(operation: Operation, tier: "quality" | "lite" = "quality", runnable?: (p: Profile) => boolean, filter: ProfileFilter = {}): Profile {
  const preferred = (PREFERENCE[operation]?.[tier] ?? []).map((id) => PROFILES.find((p) => p.id === id)).filter((p): p is Profile => Boolean(p));
  const rest = PROFILES.filter((p) => p.operation === operation && !preferred.includes(p)).sort((a, b) => Number(b.tier === tier) - Number(a.tier === tier));
  const order = [...preferred, ...rest].filter((p) => !p.optIn && licenseAllows(p, filter.commercial) && (!filter.control || !p.controls || p.controls.includes(filter.control)));
  const pick = (runnable && order.find(runnable)) || order[0];
  if (!pick) {
    const named = PROFILES.filter((p) => p.operation === operation).map((p) => `${p.id} (${licenseLabel(p.license)})`);
    throw new Error(`No ${operation} profile can be picked by default${filter.commercial ? " with commercial: true" : ""}. Name one in the job or with katana_backend profiles: ${named.join(", ") || "none exist"}.`);
  }
  return pick;
}

/** "Apache-2.0", "Qwen Research License, non-commercial", "MiniMax H3 Community License, restricted". */
export function licenseLabel(l: License): string {
  if (l.commercial === "yes") return l.name;
  if (l.note?.startsWith("unverified")) return `${l.name}, unverified`;
  return `${l.name}, ${l.commercial === "no" ? "non-commercial" : "restricted"}`;
}

/**
 * One warning per profile whose licence limits use: non-commercial, territory-restricted,
 * revenue-capped or unverified. With the commercial switch on, a non-commercial profile can only
 * be there because it was named, and the warning says so.
 */
export function licenseWarnings(ids: Iterable<string>, commercial = false): string[] {
  const out: string[] = [];
  for (const id of new Set(ids)) {
    const p = profile(id);
    const l = p.license;
    if (l.commercial === "yes") continue;
    const conflict = commercial && l.commercial === "no" ? " Commercial mode is on, but this profile was named explicitly: choose another before commercial use." : "";
    out.push(`${p.id}: ${licenseLabel(l)}.${l.note && !l.note.startsWith("unverified") ? ` ${l.note}` : ""}${conflict}${l.url ? ` ${l.url}` : ""}`);
  }
  return out;
}

/** Parameters common to every build call. Image fields are server-side input filenames. */
export interface BuildParams {
  prompt: string;
  negative?: string;
  seed: number;
  /** Output aspect ratio (width / height). */
  aspect: number;
  longSide?: number;
  images?: string[];
  /** For clip operations: the first frame. */
  startImage?: string;
  endImage?: string;
  /** Animated image (WebP) holding the driving frames, already at the model fps. */
  controlImage?: string;
  /**
   * How the driving frames steer motion: "edges" (frames are already edge maps; camera and layout,
   * shots without people), "pose" (skeletons extracted in-graph; people, keeps the hero's identity)
   * or "depth" (depth maps in-graph; shape and parallax).
   */
  controlMode?: ControlMode;
  /** Which model reads depth from the control frames: Marigold V2 (sharper edges, finer surfaces) or Depth Anything 3 (lighter). */
  depthModel?: DepthModel;
  /** How hard the control frames steer (1 = fully; depth on a different subject wants about 0.5–0.7). */
  controlStrength?: number;
  frames?: number;
  /** Frame rate of the output video, for operations that keep their input's rate (video mattes). */
  fps?: number;
  filenamePrefix: string;
}

export const CONTROL_MODES = ["edges", "pose", "depth"] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];
export const DEPTH_MODELS = ["marigold", "da3"] as const;
export type DepthModel = (typeof DEPTH_MODELS)[number];

/** Extra models a clip.motion job needs for in-graph control extraction. */
export function controlModels(mode: ControlMode, depth: DepthModel = "marigold"): ModelFile[] {
  if (mode === "pose") return [M.sdpose, M.rtDetr];
  if (mode === "depth") return depth === "da3" ? [M.da3] : [M.marigold, M.marigoldDepth, M.marigoldDepthVae, M.marigoldDepthCond];
  return [];
}

export interface Built {
  prompt: Record<string, unknown>;
  width: number;
  height: number;
  frames?: number;
  fps?: number;
  outputNode: string;
}

function save(g: Graph, kind: "image" | "video", images: Link, prefix: string, fps?: number): string {
  if (kind === "image") return g.add("SaveImage", { filename_prefix: prefix, images });
  const video = g.link("CreateVideo", { fps: fps ?? 16, images });
  // SaveVideo's format is a dynamic combo: sub-options use flat dotted keys.
  return g.add("SaveVideo", { filename_prefix: prefix, format: "mp4", "format.codec": "h264", video });
}

function loadScaled(g: Graph, image: string, width: number, height: number): Link {
  const loaded = g.link("LoadImage", { image });
  return g.link("ImageScale", { image: loaded, upscale_method: "lanczos", width, height, crop: "center" });
}

function buildQwenCompose(p: BuildParams, prof: Profile, variant: { unet: string; lora: string; steps: number } = { unet: M.qwenEdit.name, lora: M.qwenEditLightning.name, steps: 4 }): Built {
  const imgs = (p.images ?? []).slice(0, 3);
  if (!imgs.length) throw new Error("still.compose needs at least one image");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: variant.unet, weight_dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: M.qwenVl.name, type: "qwen_image", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.qwenVae.name });
  const sampling = g.link("ModelSamplingAuraFlow", { shift: 3.1, sampling: "flow", model: unet });
  const norm = g.link("CFGNorm", { strength: 1, pre_cfg: false, model: sampling });
  const model = g.link("LoraLoaderModelOnly", { lora_name: variant.lora, strength_model: 1, model: norm });
  // image1 is the canvas: scale it to the exact output size so the edit keeps the planned framing.
  const first = loadScaled(g, imgs[0]!, width, height);
  const refs: Record<string, Link> = { image1: first };
  imgs.slice(1).forEach((name, i) => {
    refs[`image${i + 2}`] = g.link("LoadImage", { image: name });
  });
  const pos = g.link("TextEncodeQwenImageEditPlus", { prompt: p.prompt, clip, vae, ...refs });
  const neg = g.link("TextEncodeQwenImageEditPlus", { prompt: p.negative ?? "", clip, vae, ...refs });
  const posRef = g.link("FluxKontextMultiReferenceLatentMethod", { reference_latents_method: "index_timestep_zero", conditioning: pos });
  const negRef = g.link("FluxKontextMultiReferenceLatentMethod", { reference_latents_method: "index_timestep_zero", conditioning: neg });
  const latent = g.link("VAEEncode", { pixels: first, vae });
  const sampled = g.link("KSampler", {
    seed: p.seed, steps: variant.steps, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
    model, positive: posRef, negative: negRef, latent_image: latent,
  });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

function buildKleinCompose(p: BuildParams, prof: Profile): Built {
  const imgs = (p.images ?? []).slice(0, 4);
  if (!imgs.length) throw new Error("still.compose needs at least one image");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: M.klein9b.name, weight_dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: M.qwen3_8b.name, type: "flux2", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.flux2Vae.name });
  let pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  let neg = g.link("ConditioningZeroOut", { conditioning: pos });
  for (const name of imgs) {
    const loaded = g.link("LoadImage", { image: name });
    const scaled = g.link("ImageScaleToTotalPixels", { upscale_method: "lanczos", megapixels: 1, resolution_steps: 1, image: loaded });
    const lat = g.link("VAEEncode", { pixels: scaled, vae });
    pos = g.link("ReferenceLatent", { conditioning: pos, latent: lat });
    neg = g.link("ReferenceLatent", { conditioning: neg, latent: lat });
  }
  const guider = g.link("CFGGuider", { cfg: 1, model: unet, positive: pos, negative: neg });
  const sigmas = g.link("Flux2Scheduler", { steps: 4, width, height });
  const noise = g.link("RandomNoise", { noise_seed: p.seed });
  const sampler = g.link("KSamplerSelect", { sampler_name: "euler" });
  const latent = g.link("EmptyFlux2LatentImage", { width, height, batch_size: 1 });
  const sampled = g.link("SamplerCustomAdvanced", { noise, guider, sampler, sigmas, latent_image: latent });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

/** FLUX 3 names references <ref_image_0>…; prompts written for the other models say "image 1"… */
export function flux3RefTags(prompt: string): string {
  return prompt.replace(/\b(?:image|picture)\s*(\d+)\b/gi, (_, n: string) => `<ref_image_${Number(n) - 1}>`);
}

function buildFlux3(p: BuildParams, prof: Profile, edit: boolean): Built {
  const imgs = (p.images ?? []).slice(0, 10);
  if (edit && !imgs.length) throw new Error("still.compose needs at least one image");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide, prof.sizeStep ?? 16);
  const g = new Graph();
  const model = g.link("UNETLoader", { unet_name: M.flux3Klein.name, weight_dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: M.qwen3vl4b.name, type: "flux3", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.flux2DevVae.name });
  const text = g.link("CLIPTextEncode", { text: edit ? flux3RefTags(p.prompt) : p.prompt, clip });
  let positive: Link = text;
  let negative: Link = g.link("ConditioningZeroOut", { conditioning: text });
  if (edit) {
    const refs: Record<string, Link> = {};
    imgs.forEach((name, i) => (refs[`images.image${i}`] = g.link("LoadImage", { image: name })));
    const multi = g.add("ReferenceMultiLatent", { positive, negative, vae, resolution: "resize", "resolution.megapixels": 1, ...refs });
    positive = [multi, 0];
    negative = [multi, 1];
  }
  // A free-size latent keeps the planned framing whatever the references' shapes.
  const latent = g.link("EmptyFlux2LatentImage", { width, height, batch_size: 1 });
  const sampled = g.link("KSampler", {
    seed: p.seed, steps: edit ? 16 : 15, cfg: 1, sampler_name: edit ? "euler" : "er_sde", scheduler: "simple", denoise: 1,
    model, positive, negative, latent_image: latent,
  });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

/**
 * Qwen-Image 2.1. Turbo: 8 fixed sigmas, edits guide at cfg 8 and text-to-image at cfg 1; the full
 * model: 25 euler steps at cfg 1 (the official templates). References are encoded at 1536 px, which
 * keeps more facial detail than the template's 1024.
 */
function buildQwen21(p: BuildParams, prof: Profile, edit: boolean, turbo = true): Built {
  const imgs = (p.images ?? []).slice(0, 10);
  if (edit && !imgs.length) throw new Error("still.compose needs at least one image");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide, prof.sizeStep ?? 32);
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: turbo ? M.qwen21Turbo.name : M.qwen21.name, weight_dtype: "default" });
  const model = g.link("QwenImage21Cache", { model: unet, device: "auto", dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: M.qwen3vl8b.name, type: "qwen_image", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.qwen21Vae.name });
  const refs: Record<string, Link> = {};
  imgs.forEach((name, i) => (refs[`images.image_${i + 1}`] = g.link("LoadImage", { image: name })));
  const enc = g.add("TextEncodeQwenImage21", { clip, vae, prompt: p.prompt, negative_prompt: p.negative ?? "", resolution: edit ? 1536 : 1024, ...(edit ? refs : {}) });
  const latent = g.link("EmptyLatentImage", { width, height, batch_size: 1 });
  let sampled: Link;
  if (turbo) {
    const guider = g.link("CFGGuider", { cfg: edit ? 8 : 1, model, positive: [enc, 0], negative: [enc, 1] });
    const sigmas = g.link("ManualSigmas", { sigmas: "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0" });
    const noise = g.link("RandomNoise", { noise_seed: p.seed });
    const sampler = g.link("KSamplerSelect", { sampler_name: "euler" });
    sampled = g.link("SamplerCustomAdvanced", { noise, guider, sampler, sigmas, latent_image: latent });
  } else {
    sampled = g.link("KSampler", { seed: p.seed, steps: 25, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model, positive: [enc, 0], negative: [enc, 1], latent_image: latent });
  }
  // The 2.1 VAE decodes RGBA; keyframes feed video models and the editor, so keep them RGB.
  const decoded = g.link("SplitImageWithAlpha", { image: g.link("VAEDecode", { samples: sampled, vae }) });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

function buildMageFlowEdit(p: BuildParams, prof: Profile): Built {
  const imgs = (p.images ?? []).slice(0, 10);
  if (!imgs.length) throw new Error("still.compose needs at least one image");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const g = new Graph();
  const model = g.link("UNETLoader", { unet_name: M.mageEditTurbo.name, weight_dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: M.qwen3vl4bBf16.name, type: "mage", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.mageVae.name });
  const refs: Record<string, Link> = {};
  imgs.forEach((name, i) => (refs[`images.image_${i + 1}`] = g.link("LoadImage", { image: name })));
  const enc = g.add("TextEncodeMageFlowEdit", { clip, vae, prompt: p.prompt, negative_prompt: p.negative ?? "", width, height, batch_size: 1, ...refs });
  const sampled = g.link("KSampler", {
    seed: p.seed, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
    model, positive: [enc, 0], negative: [enc, 1], latent_image: [enc, 2],
  });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

function buildBooguEdit(p: BuildParams, prof: Profile): Built {
  const imgs = (p.images ?? []).slice(0, 4);
  if (!imgs.length) throw new Error("still.compose needs at least one image");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: M.booguEdit.name, weight_dtype: "default" });
  const model = g.link("ModelSamplingAuraFlow", { shift: 3.16, sampling: "flow", model: unet });
  const clip = g.link("CLIPLoader", { clip_name: M.qwen3vl8bFp8.name, type: "boogu", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.aeVae.name });
  const refs: Record<string, Link> = {};
  imgs.forEach((name, i) => (refs[`images.image_${i + 1}`] = g.link("LoadImage", { image: name })));
  const enc = g.add("TextEncodeBooguEdit", { clip, vae, prompt: p.prompt, negative_prompt: p.negative ?? "", ...refs });
  const sigmas = g.link("BasicScheduler", { scheduler: "simple", steps: 25, denoise: 1, model });
  const sampler = g.link("KSamplerSelect", { sampler_name: "dpmpp_2m" });
  const latent = g.link("EmptyLatentImage", { width, height, batch_size: 1 });
  const sampled = g.link("SamplerCustom", { add_noise: true, noise_seed: p.seed, cfg: 3.5, model, positive: [enc, 0], negative: [enc, 1], sampler, sigmas, latent_image: latent });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

function buildBooguEditTurbo(p: BuildParams, prof: Profile): Built {
  const imgs = (p.images ?? []).slice(0, 4);
  if (!imgs.length) throw new Error("still.compose needs at least one image");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const g = new Graph();
  const model = g.link("UNETLoader", { unet_name: M.booguEditTurbo.name, weight_dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: M.qwen3vl8bFp8.name, type: "boogu", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.aeVae.name });
  const refs: Record<string, Link> = {};
  imgs.forEach((name, i) => (refs[`images.image_${i + 1}`] = g.link("LoadImage", { image: name })));
  const enc = g.add("TextEncodeBooguEdit", { clip, vae, prompt: p.prompt, negative_prompt: p.negative ?? "", ...refs });
  const latent = g.link("EmptyLatentImage", { width, height, batch_size: 1 });
  const sampled = g.link("KSampler", { seed: p.seed, steps: 4, cfg: 1, sampler_name: "lcm", scheduler: "sgm_uniform", denoise: 1, model, positive: [enc, 0], negative: [enc, 1], latent_image: latent });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

/** Krea 2 Turbo with the style-reference LoRA: image 1 contributes its look only. */
function buildKrea2Style(p: BuildParams, prof: Profile): Built {
  const style = p.images?.[0];
  if (!style) throw new Error("krea2-style-reference needs a style image");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide, 8);
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: M.krea2Turbo.name, weight_dtype: "default" });
  const lora = g.link("LoraLoaderModelOnly", { lora_name: M.krea2Style.name, strength_model: 1, model: unet });
  const model = g.link("ModelSamplingFlux", { max_shift: 1.15, base_shift: 0.5, width, height, model: lora });
  const clip = g.link("CLIPLoader", { clip_name: M.qwen3vl4bFp8.name, type: "krea2", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.qwenVae.name });
  const image = g.link("LoadImage", { image: style });
  const enc = g.link("TextEncodeQwenImageEditPlus", { clip, prompt: p.prompt, vae, image1: image });
  const positive = g.link("FluxKontextMultiReferenceLatentMethod", { reference_latents_method: "index_timestep_zero", conditioning: enc });
  const negative = g.link("ConditioningZeroOut", { conditioning: positive });
  const guider = g.link("CFGGuider", { cfg: 1, model, positive, negative });
  const sigmas = g.link("BasicScheduler", { scheduler: "simple", steps: 8, denoise: 1, model });
  const sampler = g.link("KSamplerSelect", { sampler_name: "euler" });
  const noise = g.link("RandomNoise", { noise_seed: p.seed });
  const latent = g.link("EmptyLatentImage", { width, height, batch_size: 1 });
  const sampled = g.link("SamplerCustomAdvanced", { noise, guider, sampler, sigmas, latent_image: latent });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

/** Text-to-image models that share the plain CLIPTextEncode → KSampler shape. */
function buildSimpleT2I(p: BuildParams, prof: Profile, m: { unet: string; clip: string; clipType: string; vae: string; latent: "EmptyLatentImage" | "EmptyFlux2LatentImage"; steps: number }): Built {
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const g = new Graph();
  const model = g.link("UNETLoader", { unet_name: m.unet, weight_dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: m.clip, type: m.clipType, device: "default" });
  const vae = g.link("VAELoader", { vae_name: m.vae });
  const pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  const neg = g.link("ConditioningZeroOut", { conditioning: pos });
  const latent = g.link(m.latent, { width, height, batch_size: 1 });
  const sampled = g.link("KSampler", { seed: p.seed, steps: m.steps, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model, positive: pos, negative: neg, latent_image: latent });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

function buildLens(p: BuildParams, prof: Profile): Built {
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide, 8);
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: M.lensTurbo.name, weight_dtype: "default" });
  const shifted = g.link("ModelSamplingFlux", { max_shift: 1.15, base_shift: 0.5, width, height, model: unet });
  const model = g.link("CFGNorm", { strength: 1, pre_cfg: false, model: shifted });
  const clip = g.link("CLIPLoader", { clip_name: M.gptOss20b.name, type: "lens", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.flux2DevVae.name });
  const pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  const neg = g.link("CLIPTextEncode", { text: p.negative ?? "", clip });
  const sigmas = g.link("BasicScheduler", { scheduler: "simple", steps: 4, denoise: 1, model: shifted });
  const sampler = g.link("KSamplerSelect", { sampler_name: "euler" });
  const latent = g.link("EmptyLatentImage", { width, height, batch_size: 1 });
  const sampled = g.link("SamplerCustom", { add_noise: true, noise_seed: p.seed, cfg: 1, model, positive: pos, negative: neg, sampler, sigmas, latent_image: latent });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

/** Largest face of image 1, with generous margins for hair, ears and collar. */
function buildFaceCrop(p: BuildParams): Built {
  const image = p.images?.[0];
  if (!image) throw new Error("still.face needs the photo to crop as image 1");
  const g = new Graph();
  const detector = g.link("BBoxDetectorLoader(FaceParsing)", { model_name: "bbox/face_yolov8m.pt" });
  const img = g.link("LoadImage", { image });
  const list = g.link("BBoxDetect(FaceParsing)", { bbox_detector: detector, image: img, threshold: 0.3, dilation: 0, dilation_ratio: 0.6, by_ratio: true });
  const bbox = g.link("BBoxListItemSelect(FaceParsing)", { bbox_list: list, index: 0 });
  const out = save(g, "image", g.link("ImageCropWithBBox(FaceParsing)", { bbox, image: img }), p.filenamePrefix);
  return { prompt: g.toJSON(), width: 0, height: 0, outputNode: out };
}

function buildZImage(p: BuildParams, prof: Profile): Built {
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: M.zImage.name, weight_dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: M.qwen3_4b.name, type: "lumina2", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.aeVae.name });
  const model = g.link("ModelSamplingAuraFlow", { shift: 3, sampling: "flow", model: unet });
  const pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  const neg = g.link("ConditioningZeroOut", { conditioning: pos });
  const latent = g.link("EmptySD3LatentImage", { width, height, batch_size: 1 });
  const sampled = g.link("KSampler", {
    seed: p.seed, steps: 8, cfg: 1, sampler_name: "res_multistep", scheduler: "simple", denoise: 1,
    model, positive: pos, negative: neg, latent_image: latent,
  });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "image", decoded, p.filenamePrefix);
  return { prompt: g.toJSON(), width, height, outputNode: out };
}

/** Wan 2.2 A14B two-expert sampling with the lightx2v 4-step LoRAs: high noise for steps 0–2, low noise for 2–4. */
function wanTwoStage(g: Graph, conditioned: { positive: Link; negative: Link; latent: Link }, seed: number, high: string, low: string, fast: boolean): Link {
  const hi = g.link("UNETLoader", { unet_name: high, weight_dtype: "default" });
  const lo = g.link("UNETLoader", { unet_name: low, weight_dtype: "default" });
  const hiModel = fast ? g.link("LoraLoaderModelOnly", { lora_name: M.i2vLoraHigh.name, strength_model: 1, model: hi }) : hi;
  const loModel = fast ? g.link("LoraLoaderModelOnly", { lora_name: M.i2vLoraLow.name, strength_model: 1, model: lo }) : lo;
  const shift = fast ? 5 : 8;
  const hiS = g.link("ModelSamplingSD3", { shift, model: hiModel });
  const loS = g.link("ModelSamplingSD3", { shift, model: loModel });
  const steps = fast ? 4 : 20;
  const split = fast ? 2 : 10;
  const cfg = fast ? 1 : 3.5;
  const first = g.link("KSamplerAdvanced", {
    add_noise: "enable", noise_seed: seed, steps, cfg, sampler_name: "euler", scheduler: "simple",
    start_at_step: 0, end_at_step: split, return_with_leftover_noise: "enable",
    model: hiS, positive: conditioned.positive, negative: conditioned.negative, latent_image: conditioned.latent,
  });
  return g.link("KSamplerAdvanced", {
    add_noise: "disable", noise_seed: 0, steps, cfg, sampler_name: "euler", scheduler: "simple",
    start_at_step: split, end_at_step: 10000, return_with_leftover_noise: "disable",
    model: loS, positive: conditioned.positive, negative: conditioned.negative, latent_image: first,
  });
}

function buildWanI2V(p: BuildParams, prof: Profile): Built {
  if (!p.startImage) throw new Error("clip.i2v needs startImage");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const frames = wanFrames(p.frames ?? 33);
  const g = new Graph();
  const clip = g.link("CLIPLoader", { clip_name: M.umt5.name, type: "wan", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.wan21Vae.name });
  const pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  const neg = g.link("CLIPTextEncode", { text: p.negative ?? WAN_NEGATIVE, clip });
  const start = loadScaled(g, p.startImage, width, height);
  const cond = g.add("WanImageToVideo", { width, height, length: frames, batch_size: 1, positive: pos, negative: neg, vae, start_image: start });
  const samples = wanTwoStage(g, { positive: [cond, 0], negative: [cond, 1], latent: [cond, 2] }, p.seed, M.i2vHigh.name, M.i2vLow.name, true);
  const decoded = g.link("VAEDecode", { samples, vae });
  const out = save(g, "video", decoded, p.filenamePrefix, prof.fps);
  return { prompt: g.toJSON(), width, height, frames, fps: prof.fps, outputNode: out };
}

function buildWanFLF(p: BuildParams, prof: Profile): Built {
  if (!p.startImage || !p.endImage) throw new Error("clip.flf needs startImage and endImage");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const frames = wanFrames(p.frames ?? 33);
  const g = new Graph();
  const clip = g.link("CLIPLoader", { clip_name: M.umt5.name, type: "wan", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.wan21Vae.name });
  const pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  const neg = g.link("CLIPTextEncode", { text: p.negative ?? WAN_NEGATIVE, clip });
  const start = loadScaled(g, p.startImage, width, height);
  const end = loadScaled(g, p.endImage, width, height);
  const cond = g.add("WanFirstLastFrameToVideo", { width, height, length: frames, batch_size: 1, positive: pos, negative: neg, vae, start_image: start, end_image: end });
  const samples = wanTwoStage(g, { positive: [cond, 0], negative: [cond, 1], latent: [cond, 2] }, p.seed, M.i2vHigh.name, M.i2vLow.name, true);
  const decoded = g.link("VAEDecode", { samples, vae });
  const out = save(g, "video", decoded, p.filenamePrefix, prof.fps);
  return { prompt: g.toJSON(), width, height, frames, fps: prof.fps, outputNode: out };
}

function buildWanTI2V5B(p: BuildParams, prof: Profile): Built {
  if (!p.startImage) throw new Error("clip.i2v needs startImage");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const frames = wanFrames(p.frames ?? 49);
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: M.ti2v5b.name, weight_dtype: "default" });
  const clip = g.link("CLIPLoader", { clip_name: M.umt5.name, type: "wan", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.wan22Vae.name });
  const model = g.link("ModelSamplingSD3", { shift: 8, model: unet });
  const pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  const neg = g.link("CLIPTextEncode", { text: p.negative ?? WAN_NEGATIVE, clip });
  const start = loadScaled(g, p.startImage, width, height);
  const latent = g.link("Wan22ImageToVideoLatent", { width, height, length: frames, batch_size: 1, vae, start_image: start });
  const sampled = g.link("KSampler", {
    seed: p.seed, steps: 20, cfg: 5, sampler_name: "uni_pc", scheduler: "simple", denoise: 1,
    model, positive: pos, negative: neg, latent_image: latent,
  });
  const decoded = g.link("VAEDecode", { samples: sampled, vae });
  const out = save(g, "video", decoded, p.filenamePrefix, prof.fps);
  return { prompt: g.toJSON(), width, height, frames, fps: prof.fps, outputNode: out };
}

/**
 * The control frames for a motion job. LoadImage decodes every frame of an animated WebP into one
 * IMAGE batch, which works on Comfy Cloud where uploaded videos are not available to LoadVideo.
 * pose: people are found with RT-DETR first and SDPose reads the skeleton inside each box, so the
 * driving performer's face, hair and clothes never reach the model. depth: Marigold V2 maps (one
 * deterministic step of its LoRA on Qwen-Image-Edit 2509, near is bright), or Depth Anything 3 maps.
 * edges: the frames are already edge maps.
 */
function drivingFrames(g: Graph, p: BuildParams): Link {
  const frames0 = g.link("LoadImage", { image: p.controlImage! });
  if (p.controlMode === "pose") {
    const ckpt = g.add("CheckpointLoaderSimple", { ckpt_name: M.sdpose.name });
    const sized = g.link("ResizeImageMaskNode", { resize_type: "scale longer dimension", scale_method: "lanczos", input: frames0, "resize_type.longer_size": 1024 });
    const detector = g.link("UNETLoader", { unet_name: M.rtDetr.name, weight_dtype: "default" });
    const bboxes = g.link("RTDETR_detect", { model: detector, image: sized, threshold: 0.5, class_name: "person", max_detections: 2 });
    const keypoints = g.link("SDPoseKeypointExtractor", { batch_size: 16, model: [ckpt, 0], vae: [ckpt, 2], image: sized, bboxes });
    return g.link("SDPoseDrawKeypoints", {
      draw_body: true, draw_hands: true, draw_face: true, draw_feet: true, draw_head: true,
      stick_width: 4, face_point_size: 2, score_threshold: 0.5, keypoints,
    });
  }
  if (p.controlMode === "depth" && (p.depthModel ?? "marigold") === "marigold") {
    const sized = g.link("ResizeImageMaskNode", { resize_type: "scale longer dimension", scale_method: "lanczos", input: frames0, "resize_type.longer_size": 768 });
    const unet = g.link("UNETLoader", { unet_name: M.marigold.name, weight_dtype: "default" });
    const lora = g.link("LoraLoaderModelOnly", { lora_name: M.marigoldDepth.name, strength_model: 1, model: unet });
    const model = g.link("ModelSamplingAuraFlow", { shift: 1.73, sampling: "img_to_img_velocity", model: lora });
    const vae = g.link("VAELoader", { vae_name: M.marigoldDepthVae.name });
    const guider = g.link("BasicGuider", { model, conditioning: g.link("ConditioningLoader", { conditioning_name: M.marigoldDepthCond.name }) });
    const sampled = g.link("SamplerCustomAdvanced", {
      noise: g.link("DisableNoise", {}), guider, sampler: g.link("KSamplerSelect", { sampler_name: "euler" }),
      sigmas: g.link("ManualSigmas", { sigmas: "0.5, 0" }), latent_image: g.link("VAEEncode", { pixels: sized, vae }),
    });
    return g.link("MarigoldV2PostProcess", { prediction: "depth", image: g.link("VAEDecode", { samples: sampled, vae }) });
  }
  if (p.controlMode === "depth") {
    const model = g.link("LoadDA3Model", { model_name: M.da3.name, weight_dtype: "default" });
    const geometry = g.link("DA3Inference", { resolution: 504, resize_method: "lower_bound_resize", mode: "mono", da3_model: model, image: frames0 });
    return g.link("DA3Render", { output: "depth", da3_geometry: geometry, "output.normalization": "v2_style", "output.apply_sky_clip": false });
  }
  return frames0;
}

/** Just the control frames a motion job would see (pose skeletons or depth maps), saved as a video to check them. */
export function buildControlPreview(p: Pick<BuildParams, "controlImage" | "controlMode" | "depthModel" | "filenamePrefix"> & { fps?: number; kind?: "image" | "video" }): Built {
  if (!p.controlImage) throw new Error("a control preview needs controlImage");
  const g = new Graph();
  const out = save(g, p.kind ?? "video", drivingFrames(g, p as BuildParams), p.filenamePrefix, p.fps ?? 24);
  return { prompt: g.toJSON(), width: 0, height: 0, frames: 0, fps: p.fps ?? 24, outputNode: out };
}

function buildFunControl(p: BuildParams, prof: Profile): Built {
  if (!p.startImage) throw new Error("clip.motion needs startImage");
  if (!p.controlImage) throw new Error("clip.motion needs controlImage (animated WebP of control frames)");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const frames = wanFrames(p.frames ?? 33);
  const g = new Graph();
  const clip = g.link("CLIPLoader", { clip_name: M.umt5.name, type: "wan", device: "default" });
  const vae = g.link("VAELoader", { vae_name: prof.id === "wan22-5b-fun-control" ? M.wan22Vae.name : M.wan21Vae.name });
  const pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  const neg = g.link("CLIPTextEncode", { text: p.negative ?? WAN_NEGATIVE, clip });
  const start = loadScaled(g, p.startImage, width, height);
  const driving = drivingFrames(g, p);
  const control = g.link("ImageScale", { image: driving, upscale_method: "lanczos", width, height, crop: "center" });
  const cond = g.add("Wan22FunControlToVideo", {
    width, height, length: frames, batch_size: 1, positive: pos, negative: neg, vae, ref_image: start, control_video: control,
  });
  let samples: Link;
  if (prof.id === "wan22-5b-fun-control") {
    const unet = g.link("UNETLoader", { unet_name: M.fun5b.name, weight_dtype: "default" });
    const model = g.link("ModelSamplingSD3", { shift: 8, model: unet });
    samples = g.link("KSampler", {
      seed: p.seed, steps: 20, cfg: 5, sampler_name: "uni_pc", scheduler: "simple", denoise: 1,
      model, positive: [cond, 0], negative: [cond, 1], latent_image: [cond, 2],
    });
  } else {
    samples = wanTwoStage(g, { positive: [cond, 0], negative: [cond, 1], latent: [cond, 2] }, p.seed, M.funHigh.name, M.funLow.name, false);
  }
  const decoded = g.link("VAEDecode", { samples, vae });
  const out = save(g, "video", decoded, p.filenamePrefix, prof.fps);
  return { prompt: g.toJSON(), width, height, frames, fps: prof.fps, outputNode: out };
}

interface H3Base {
  g: Graph;
  clip: Link;
  vae: Link;
  audioVae: Link;
  width: number;
  height: number;
  frames: number;
}

/**
 * H3's native canvas holds about 1 MP: 768×1344 for 9:16 and 16:9, 1024×768 for 4:3 and squarer
 * shapes. Profiles with a smaller long side (the turbo LoRAs were trained near 544–768p) keep theirs.
 */
export function h3LongSide(aspect: number, profileLong: number): number {
  const native = aspect >= 1.5 || aspect <= 1 / 1.5 ? 1344 : 1024;
  return Math.min(native, profileLong);
}

function h3Base(p: BuildParams, prof: Profile, defaultSeconds: number): H3Base {
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? h3LongSide(p.aspect, prof.longSide), 32);
  const frames = h3Frames(p.frames ?? Math.round(defaultSeconds * 24));
  const g = new Graph();
  const clip = g.link("CLIPLoader", { clip_name: M.h3Text.name, type: "minimax", device: "default" });
  const vae = g.link("VAELoader", { vae_name: M.h3Vae.name });
  const audioVae = g.link("VAELoader", { vae_name: M.h3AudioVae.name });
  return { g, clip, vae, audioVae, width, height, frames };
}

/** Samples an H3 audio-video latent and saves only the picture (the edit supplies its own music). */
function h3Sample(b: H3Base, model: Link, conditioning: Link, latent: Link, seed: number, steps: number, prefix: string): string {
  const { g } = b;
  const sigmas = g.link("BasicScheduler", { scheduler: "simple", steps, denoise: 1, model });
  const guider = g.link("BasicGuider", { model, conditioning });
  const sampler = g.link("KSamplerSelect", { sampler_name: "res_multistep" });
  const noise = g.link("RandomNoise", { noise_seed: seed });
  const sampled = g.link("SamplerCustomAdvanced", { noise, guider, sampler, sigmas, latent_image: latent });
  const decoded = g.link("VAEDecode", { samples: sampled, vae: b.vae });
  return save(g, "video", decoded, prefix, 24);
}

/** True for the profiles that run H3 with a turbo LoRA. */
function h3Turbo(prof: Profile): boolean {
  return prof.models.includes(M.h3Fl2vTurbo) || prof.models.includes(M.h3Ref2vTurbo);
}

/** H3 first-frame (and optional last-frame) to video: the full model at 20 steps, or the 8-step turbo LoRA at 8. */
function buildH3Frames(p: BuildParams, prof: Profile, needEnd: boolean): Built {
  if (!p.startImage) throw new Error(`${prof.operation} needs startImage`);
  if (needEnd && !p.endImage) throw new Error("clip.flf needs endImage");
  const b = h3Base(p, prof, 2);
  const { g } = b;
  const unet = g.link("UNETLoader", { unet_name: M.h3Fl2v.name, weight_dtype: "default" });
  const turbo = h3Turbo(prof);
  const model = turbo ? g.link("LoraLoaderModelOnly", { lora_name: M.h3Fl2vTurbo.name, strength_model: 1, model: unet }) : unet;
  const first = loadScaled(g, p.startImage, b.width, b.height);
  const last = p.endImage ? loadScaled(g, p.endImage, b.width, b.height) : undefined;
  const cond = g.add("MiniMaxH3ImageToVideo", {
    clip: b.clip, vae: b.vae, prompt: p.prompt, width: b.width, height: b.height, length: b.frames,
    first_frame: first, ...(last ? { last_frame: last } : {}),
  });
  const out = h3Sample(b, model, [cond, 0], [cond, 1], p.seed, turbo ? 8 : 20, p.filenamePrefix);
  return { prompt: g.toJSON(), width: b.width, height: b.height, frames: b.frames, fps: 24, outputNode: out };
}

/**
 * H3 motion transfer: the Fun ControlNet Union patch steers the first-frame model with control
 * frames from the reference shot (pose skeletons by default), so the hero re-performs that exact
 * move at its real speed. Turbo LoRA at 6 steps: as good as 20 steps here, with crisper hands.
 */
function buildH3Motion(p: BuildParams, prof: Profile): Built {
  if (!p.startImage) throw new Error("clip.motion needs startImage");
  if (!p.controlImage) throw new Error("clip.motion needs controlImage (animated WebP of control frames)");
  const b = h3Base(p, prof, 2);
  const { g } = b;
  const unet = g.link("UNETLoader", { unet_name: M.h3Fl2v.name, weight_dtype: "default" });
  const turbo = g.link("LoraLoaderModelOnly", { lora_name: M.h3Fl2vTurbo.name, strength_model: 1, model: unet });
  const patch = g.link("ModelPatchLoader", { name: M.h3FunControl.name });
  const control = g.link("ImageScale", { image: drivingFrames(g, p), upscale_method: "lanczos", width: b.width, height: b.height, crop: "center" });
  const model = g.link("MiniMaxH3FunControlNetApply", { model: turbo, model_patch: patch, vae: b.vae, strength: p.controlStrength ?? 1, start_percent: 0, end_percent: 1, control_video: control });
  const first = loadScaled(g, p.startImage, b.width, b.height);
  const cond = g.add("MiniMaxH3ImageToVideo", {
    clip: b.clip, vae: b.vae, prompt: p.prompt, width: b.width, height: b.height, length: b.frames, first_frame: first,
  });
  const out = h3Sample(b, model, [cond, 0], [cond, 1], p.seed, 6, p.filenamePrefix);
  return { prompt: g.toJSON(), width: b.width, height: b.height, frames: b.frames, fps: 24, outputNode: out };
}

/**
 * H3 reference-to-video steered by control frames: the subject's reference photos (a car from every
 * angle, a product) keep its shape and details, the start keyframe is pinned at frame 0, and the
 * reference shot's depth (or pose) drives the camera, so orbits and arcs come out with real parallax.
 */
function buildH3MotionRef(p: BuildParams, prof: Profile): Built {
  const refs = (p.images ?? []).slice(0, 9);
  if (!refs.length && !p.startImage) throw new Error("clip.motion with references needs reference images (and/or a startImage)");
  if (!p.controlImage) throw new Error("clip.motion needs controlImage (animated WebP of control frames)");
  const b = h3Base(p, prof, 2);
  const { g } = b;
  const unet = g.link("UNETLoader", { unet_name: M.h3Ref2v.name, weight_dtype: "default" });
  const patch = g.link("ModelPatchLoader", { name: M.h3FunControl.name });
  const control = g.link("ImageScale", { image: drivingFrames(g, p), upscale_method: "lanczos", width: b.width, height: b.height, crop: "center" });
  const model = g.link("MiniMaxH3FunControlNetApply", { model: unet, model_patch: patch, vae: b.vae, strength: p.controlStrength ?? 1, start_percent: 0, end_percent: 1, control_video: control });
  const refInputs: Record<string, Link> = {};
  refs.forEach((name, i) => {
    refInputs[`ref_images.ref_image_${i}`] = g.link("LoadImage", { image: name });
  });
  const cond = g.add("MiniMaxH3ReferenceToVideo", {
    clip: b.clip, prompt: p.prompt, width: b.width, height: b.height, length: b.frames, ref_image_size: "match", vae: b.vae, audio_vae: b.audioVae, ...refInputs,
  });
  let positive: Link = [cond, 0];
  if (p.startImage) positive = g.link("MiniMaxH3AddGuide", { positive, latent: [cond, 1], frame_idx: 0, vae: b.vae, audio_vae: b.audioVae, image: loadScaled(g, p.startImage, b.width, b.height) });
  if (p.endImage) positive = g.link("MiniMaxH3AddGuide", { positive, latent: [cond, 1], frame_idx: b.frames - 1, vae: b.vae, audio_vae: b.audioVae, image: loadScaled(g, p.endImage, b.width, b.height) });
  const out = h3Sample(b, model, positive, [cond, 1], p.seed, 20, p.filenamePrefix);
  return { prompt: g.toJSON(), width: b.width, height: b.height, frames: b.frames, fps: 24, outputNode: out };
}

/**
 * Wan Animate 2: motion straight from the reference frames (no skeleton) onto the hero image, in one
 * pass for clips up to 81 frames. The prompt describes the hero and the place; the same text steers
 * the motion branch. The hero image is the identity reference, not a first frame.
 */
function buildWanAnimate2(p: BuildParams, prof: Profile): Built {
  const hero = p.startImage ?? p.images?.[0];
  if (!hero) throw new Error("clip.motion needs startImage (the hero image)");
  if (!p.controlImage) throw new Error("clip.motion needs controlImage (animated WebP of the reference frames)");
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide);
  const frames = wanFrames(Math.min(81, p.frames ?? 33));
  const g = new Graph();
  const unet = g.link("UNETLoader", { unet_name: M.wanAnimate2.name, weight_dtype: "default" });
  const lora = g.link("LoraLoaderModelOnly", { lora_name: M.wanAnimate2Lora.name, strength_model: 1, model: unet });
  const cached = g.link("WanAnimate2Cache", { device: "gpu", dtype: "int8", model: lora });
  const clip = g.link("CLIPLoader", { clip_name: M.umt5.name, type: "wan", device: "default" });
  const vision = g.link("CLIPVisionLoader", { clip_name: M.clipVisionH.name });
  const vae = g.link("VAELoader", { vae_name: M.wan21Vae.name });
  const pos = g.link("CLIPTextEncode", { text: p.prompt, clip });
  const neg = g.link("CLIPTextEncode", { text: p.negative ?? WAN_NEGATIVE, clip });
  const heroImg = loadScaled(g, hero, width, height);
  const driving = g.link("ImageScale", { image: g.link("LoadImage", { image: p.controlImage }), upscale_method: "lanczos", width, height, crop: "center" });
  const firstDriving = g.link("ImageFromBatch", { batch_index: 0, length: 1, image: driving });
  const heroVision = g.link("CLIPVisionEncode", { crop: "none", clip_vision: vision, image: heroImg });
  const poseVision = g.link("CLIPVisionEncode", { crop: "none", clip_vision: vision, image: firstDriving });
  const cond = g.add("WanAnimate2ToVideo", {
    batch_size: 1, pose_strength: 1, pose_start_percent: 0, pose_end_percent: 1, reference_image_strength: 1,
    positive: pos, negative: neg, vae, width, height, length: frames, video_frame_offset: 0,
    reference_image: heroImg, pose_video: driving, clip_vision_output: heroVision, positive_pose: pos, clip_vision_output_pose: poseVision,
  });
  const sigmas = g.link("BasicScheduler", { scheduler: "simple", steps: 6, denoise: 1, model: cached });
  const model = g.link("ModelSamplingSD3", { shift: 5, model: cached });
  const sampler = g.link("KSamplerSelect", { sampler_name: "lcm" });
  const sampled = g.link("SamplerCustom", {
    add_noise: true, noise_seed: p.seed, cfg: 1, model, positive: [cond, 0], negative: [cond, 1], sampler, sigmas, latent_image: [cond, 2],
  });
  const trimmed = g.link("TrimVideoLatent", { samples: sampled, trim_amount: [cond, 3] });
  const decoded = g.link("VAEDecode", { samples: trimmed, vae });
  const out = save(g, "video", decoded, p.filenamePrefix, prof.fps);
  return { prompt: g.toJSON(), width, height, frames, fps: prof.fps, outputNode: out };
}

/**
 * H3 reference-to-video: up to nine reference images (identity, outfit, location, style) and an
 * optional start image pinned at frame 0, so the shot opens exactly on an accepted keyframe.
 */
function buildH3Reference(p: BuildParams, prof: Profile): Built {
  const refs = (p.images ?? []).slice(0, 9);
  if (!refs.length && !p.startImage) throw new Error("clip.r2v needs reference images (and/or a startImage)");
  const b = h3Base(p, prof, 2);
  const { g } = b;
  const unet = g.link("UNETLoader", { unet_name: M.h3Ref2v.name, weight_dtype: "default" });
  const turbo = h3Turbo(prof);
  const model = turbo ? g.link("LoraLoaderModelOnly", { lora_name: M.h3Ref2vTurbo.name, strength_model: 1, model: unet }) : unet;
  const refInputs: Record<string, Link> = {};
  refs.forEach((name, i) => {
    refInputs[`ref_images.ref_image_${i}`] = g.link("LoadImage", { image: name });
  });
  const cond = g.add("MiniMaxH3ReferenceToVideo", {
    clip: b.clip, prompt: p.prompt, width: b.width, height: b.height, length: b.frames, ref_image_size: "match",
    vae: b.vae, audio_vae: b.audioVae, ...refInputs,
  });
  let positive: Link = [cond, 0];
  if (p.startImage) {
    const start = loadScaled(g, p.startImage, b.width, b.height);
    positive = g.link("MiniMaxH3AddGuide", { positive, latent: [cond, 1], frame_idx: 0, vae: b.vae, audio_vae: b.audioVae, image: start });
  }
  if (p.endImage) {
    const end = loadScaled(g, p.endImage, b.width, b.height);
    positive = g.link("MiniMaxH3AddGuide", { positive, latent: [cond, 1], frame_idx: b.frames - 1, vae: b.vae, audio_vae: b.audioVae, image: end });
  }
  const out = h3Sample(b, model, positive, [cond, 1], p.seed, turbo ? 4 : 20, p.filenamePrefix);
  return { prompt: g.toJSON(), width: b.width, height: b.height, frames: b.frames, fps: 24, outputNode: out };
}

/**
 * SeedVR2 upscale (the core-node graph of Comfy's SeedVR2 template): the source scaled to the target
 * size, one diffusion step that restores detail, then colour matched back to the scaled source (lab).
 * A clip arrives as an animated WebP of all its frames (controlImage) and leaves at its own rate.
 */
function buildUpscale(p: BuildParams, prof: Profile): Built {
  const source = p.controlImage ?? p.startImage ?? p.images?.[0];
  if (!source) throw new Error("upscale needs a clip or an image");
  const model = prof.models[0]!.name;
  const g = new Graph();
  const loaded = g.link("LoadImage", { image: source });
  const resized = g.link("ResizeImageMaskNode", { resize_type: "scale longer dimension", scale_method: "lanczos", input: loaded, "resize_type.longer_size": p.longSide ?? prof.longSide });
  const vae = g.link("VAELoader", { vae_name: M.seedvr2Vae.name });
  const unet = g.link("UNETLoader", { unet_name: model, weight_dtype: "default" });
  const tiles = { tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 };
  const latent = g.link("VAEEncodeTiled", { pixels: g.link("SeedVR2Preprocess", { resized_images: resized }), vae, ...tiles });
  const cond = g.add("SeedVR2Conditioning", { model: unet, vae_conditioning: latent });
  const sampled = g.link("KSampler", {
    model: unet, positive: [cond, 0], negative: [cond, 1], latent_image: latent,
    seed: p.seed, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
  });
  const decoded = g.link("VAEDecodeTiled", { samples: sampled, vae, ...tiles });
  const out = g.link("SeedVR2PostProcessing", { images: decoded, original_resized_images: resized, color_correction_method: "lab" });
  // The long side is exact; the short side follows the source's shape.
  const { width, height } = sizeForAspect(p.aspect, p.longSide ?? prof.longSide, 2);
  if (p.controlImage) return { prompt: g.toJSON(), width, height, frames: p.frames, fps: p.fps, outputNode: save(g, "video", out, p.filenamePrefix, p.fps ?? 24) };
  return { prompt: g.toJSON(), width, height, outputNode: save(g, "image", out, p.filenamePrefix) };
}

function buildMatte(p: BuildParams): Built {
  if (p.controlImage) {
    // Video matte: every frame of the clip (animated WebP) → white-subject-on-black mask video.
    const g = new Graph();
    const frames = g.link("LoadImage", { image: p.controlImage });
    const model = g.link("LoadBackgroundRemovalModel", { bg_removal_name: M.birefnet.name });
    const mask = g.link("RemoveBackground", { bg_removal_model: model, image: frames });
    const images = g.link("MaskToImage", { mask });
    const out = save(g, "video", images, p.filenamePrefix, p.fps ?? 16);
    return { prompt: g.toJSON(), width: 0, height: 0, frames: p.frames, fps: p.fps, outputNode: out };
  }
  const image = p.images?.[0] ?? p.startImage;
  if (!image) throw new Error("matte needs an image");
  const g = new Graph();
  const loaded = g.link("LoadImage", { image });
  const model = g.link("LoadBackgroundRemovalModel", { bg_removal_name: M.birefnet.name });
  const mask = g.link("RemoveBackground", { bg_removal_model: model, image: loaded });
  const alpha = g.link("InvertMask", { mask });
  const joined = g.link("JoinImageWithAlpha", { image: loaded, alpha });
  const out = save(g, "image", joined, p.filenamePrefix);
  return { prompt: g.toJSON(), width: 0, height: 0, outputNode: out };
}

export function build(profileId: string, params: BuildParams): Built {
  const prof = profile(profileId);
  switch (prof.id) {
    case "qwen-edit-2511":
      return buildQwenCompose(params, prof);
    case "flux2-klein-9b":
      return buildKleinCompose(params, prof);
    case "firered-edit-1.1":
      return buildQwenCompose(params, prof, { unet: M.fireRed.name, lora: M.fireRedLightning.name, steps: 8 });
    case "mage-flow-edit-turbo":
      return buildMageFlowEdit(params, prof);
    case "boogu-edit":
      return buildBooguEdit(params, prof);
    case "boogu-edit-turbo":
      return buildBooguEditTurbo(params, prof);
    case "krea2-style-reference":
      return buildKrea2Style(params, prof);
    case "krea2-turbo":
      return buildSimpleT2I(params, prof, { unet: M.krea2Turbo.name, clip: M.qwen3vl4bFp8.name, clipType: "krea2", vae: M.qwenVae.name, latent: "EmptyLatentImage", steps: 8 });
    case "ernie-image-turbo":
      return buildSimpleT2I(params, prof, { unet: M.ernieTurbo.name, clip: M.ministral3b.name, clipType: "flux2", vae: M.flux2DevVae.name, latent: "EmptyFlux2LatentImage", steps: 8 });
    case "lens-turbo":
      return buildLens(params, prof);
    case "flux3-klein-edit":
      return buildFlux3(params, prof, true);
    case "flux3-klein":
      return buildFlux3(params, prof, false);
    case "qwen21-turbo-edit":
      return buildQwen21(params, prof, true);
    case "qwen21-edit":
      return buildQwen21(params, prof, true, false);
    case "face-crop":
      return buildFaceCrop(params);
    case "qwen21-turbo":
      return buildQwen21(params, prof, false);
    case "qwen21":
      return buildQwen21(params, prof, false, false);
    case "z-image-turbo":
      return buildZImage(params, prof);
    case "wan22-14b-i2v":
      return buildWanI2V(params, prof);
    case "wan22-5b-ti2v":
      return buildWanTI2V5B(params, prof);
    case "wan22-14b-fun-control":
    case "wan22-5b-fun-control":
      return buildFunControl(params, prof);
    case "wan22-14b-flf":
      return buildWanFLF(params, prof);
    case "minimax-h3-i2v":
    case "minimax-h3-i2v-turbo":
      return buildH3Frames(params, prof, false);
    case "minimax-h3-flf":
    case "minimax-h3-flf-turbo":
      return buildH3Frames(params, prof, true);
    case "minimax-h3-r2v":
    case "minimax-h3-r2v-turbo":
      return buildH3Reference(params, prof);
    case "minimax-h3-motion":
      return buildH3Motion(params, prof);
    case "minimax-h3-motion-ref":
      return buildH3MotionRef(params, prof);
    case "wan-animate2":
      return buildWanAnimate2(params, prof);
    case "birefnet":
      return buildMatte(params);
    case "seedvr2-7b-sharp":
    case "seedvr2-7b":
    case "seedvr2-3b":
      return buildUpscale(params, prof);
    default:
      throw new Error(`No builder for profile ${prof.id}`);
  }
}

/** Rough GPU-seconds estimate for one job, scaled by pixels and frames relative to each profile's baseline. */
export function estimateSeconds(profileId: string, opts: { width: number; height: number; frames?: number }): number {
  const prof = profile(profileId);
  const pixelScale = (opts.width * opts.height) / (prof.longSide * snap(prof.longSide * 0.5625));
  const frameScale = opts.frames ? opts.frames / 81 : 1;
  const perFrames = prof.operation.startsWith("clip") ? Math.max(0.3, frameScale) : prof.operation === "upscale" ? (opts.frames ? frameScale : 1 / 20) : 1;
  return Math.max(2, Math.round(prof.baseSeconds * Math.max(0.25, pixelScale) * perFrames));
}
