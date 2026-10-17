import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/proc.js";

/**
 * Built-in procedural sound effects, synthesized once with ffmpeg. Recorded effects (user audio
 * assets) sound better; these are a dependable fallback that needs no downloads or licences.
 */
export const BUILTIN_SFX: Record<string, { description: string; source: string; filters: string }> = {
  whoosh: { description: "air swish for whip pans and transitions", source: "anoisesrc=d=0.7:color=pink:seed=7", filters: "bandpass=f=1400:width_type=o:w=2.5,afade=t=in:d=0.35:curve=exp,afade=t=out:st=0.35:d=0.35,volume=1.6" },
  hit: { description: "punchy bass thump for drops and punch-ins", source: "aevalsrc='0.95*sin(2*PI*(55+140*exp(-28*t))*t)*exp(-7*t)':d=0.7:s=44100", filters: "volume=1.2" },
  boom: { description: "long cinematic low boom", source: "aevalsrc='0.9*sin(2*PI*(38+40*exp(-6*t))*t)*exp(-2.6*t)':d=1.8:s=44100", filters: "lowpass=f=180,volume=1.4" },
  riser: { description: "rising tension into a drop", source: "aevalsrc='0.35*sin(2*PI*(180+1500*t*t/2.25)*t)*(t/1.5)':d=1.5:s=44100", filters: "afade=t=out:st=1.42:d=0.08,volume=1.2" },
  tick: { description: "short click for typewriter text and cuts", source: "aevalsrc='0.8*sin(2*PI*2400*t)*exp(-260*t)':d=0.06:s=44100", filters: "volume=1" },
  glitch: { description: "digital stutter for glitch inserts", source: "anoisesrc=d=0.3:color=white:seed=3", filters: "tremolo=f=38:d=1,highpass=f=900,afade=t=out:st=0.2:d=0.1,volume=0.9" },
};

/** Returns a WAV path for a built-in effect, synthesizing it on first use. */
export async function builtinSfx(name: string, cacheDir: string): Promise<string> {
  const def = BUILTIN_SFX[name];
  if (!def) throw new Error(`Unknown sound effect "${name}". Built-ins: ${Object.keys(BUILTIN_SFX).join(", ")}; or give an audio asset id.`);
  await mkdir(cacheDir, { recursive: true });
  const out = join(cacheDir, `sfx-${name}.wav`);
  if (!existsSync(out)) {
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", def.source, "-af", `${def.filters},aformat=sample_rates=44100:channel_layouts=stereo`, out]);
  }
  return out;
}
