import { run } from "../util/proc.js";

export interface Rational {
  num: number;
  den: number;
}

export interface MediaInfo {
  path: string;
  container: string;
  durationSec: number;
  sizeBytes: number;
  video?: {
    codec: string;
    width: number;
    height: number;
    /** Display size after rotation and sample aspect ratio. */
    displayWidth: number;
    displayHeight: number;
    rotation: number;
    pixFmt: string;
    fps: Rational;
    /** True when average and nominal frame rates disagree, i.e. likely variable frame rate. */
    variableFrameRate: boolean;
    frameCount: number;
    startTimeSec: number;
  };
  audio?: {
    codec: string;
    sampleRate: number;
    channels: number;
    startTimeSec: number;
    durationSec: number;
  };
}

export function parseRational(value: string | undefined): Rational {
  if (!value) return { num: 0, den: 1 };
  const [n, d] = value.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return { num: 0, den: 1 };
  return { num: n, den: d && Number.isFinite(d) ? d : 1 };
}

export const rationalValue = (r: Rational): number => (r.den ? r.num / r.den : 0);

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  start_time?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  sample_aspect_ratio?: string;
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

/** Probes a media file with ffprobe. Counts packets so frame counts are exact for short clips. */
export async function probe(path: string): Promise<MediaInfo> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-count_packets",
    "-show_streams",
    "-show_format",
    "-of", "json",
    path,
  ]);
  const data = JSON.parse(stdout.toString("utf8")) as {
    streams: FfprobeStream[];
    format: { format_name: string; duration?: string; size?: string };
  };
  const v = data.streams.find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
  const still = data.streams.find((s) => s.codec_type === "video");
  const a = data.streams.find((s) => s.codec_type === "audio");
  const info: MediaInfo = {
    path,
    container: data.format.format_name,
    durationSec: Number(data.format.duration ?? 0),
    sizeBytes: Number(data.format.size ?? 0),
  };
  const vs = v ?? still;
  if (vs) {
    const rotation = Math.round(vs.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? Number(vs.tags?.rotate ?? 0));
    const sar = parseRational(vs.sample_aspect_ratio);
    const sarValue = sar.num && sar.den ? sar.num / sar.den : 1;
    let w = Math.round((vs.width ?? 0) * sarValue);
    let h = vs.height ?? 0;
    if (Math.abs(rotation) % 180 === 90) [w, h] = [h, w];
    const nominal = parseRational(vs.r_frame_rate);
    const average = parseRational(vs.avg_frame_rate);
    const fps = average.num ? average : nominal;
    info.video = {
      codec: vs.codec_name,
      width: vs.width ?? 0,
      height: vs.height ?? 0,
      displayWidth: w,
      displayHeight: h,
      rotation,
      pixFmt: vs.pix_fmt ?? "",
      fps,
      variableFrameRate: average.num > 0 && Math.abs(rationalValue(average) - rationalValue(nominal)) > 0.01,
      frameCount: Number(vs.nb_read_packets ?? vs.nb_frames ?? 0),
      startTimeSec: Number(vs.start_time ?? 0),
    };
  }
  if (a) {
    info.audio = {
      codec: a.codec_name,
      sampleRate: Number(a.sample_rate ?? 0),
      channels: a.channels ?? 0,
      startTimeSec: Number(a.start_time ?? 0),
      durationSec: Number(a.duration ?? info.durationSec),
    };
  }
  return info;
}

/** Presentation timestamps (seconds) of every video frame, in display order. */
export async function framePts(path: string): Promise<number[]> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "packet=pts_time",
    "-of", "csv=p=0",
    path,
  ]);
  return stdout
    .toString("utf8")
    .split("\n")
    .map((l) => Number.parseFloat(l))
    .filter((n) => Number.isFinite(n))
    .sort((x, y) => x - y);
}
