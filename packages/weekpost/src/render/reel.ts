// Reel 1080x1920 at 30 fps: each segment's image full screen with a slow zoom and one text at a time (the voiced
// version shows the narration captions; the silent one, each segment's title), always outside the strips the
// Instagram UI covers. Pure functions (timings, captions, ffmpeg arguments) + the edges (layer HTML, ffmpeg-static).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { esc, rgba, type Brand } from "./brand.ts";

type Account = string; // account id from the config

export const SIZE = { width: 1080, height: 1920 } as const;
export const FPS = 30;
// Strips the Instagram UI covers on a Reel: ~14% at the top and ~20% at the bottom (and the buttons on the right).
export const SAFE = { top: Math.round(SIZE.height * 0.14), bottom: Math.round(SIZE.height * 0.2), right: 140 } as const;
// Left inset of the text and the logo (~9.3% of 1080). On the right, SAFE.right (140) is larger and protects the buttons.
export const SIDE = 100;
const ZOOM = 0.1; // +10% ao longo do segmento
// Crop scale before zoompan (margin so the zoom does not pixelate): 1.5x instead of 2x cuts ~44% of the pixels.
export const ZOOM_SCALE = 1.5;
const FADE = 0.4;
// Closing CTA card after the segments (2.5 to 3 s): the narration does not change, the music covers the total.
export const CTA_CARD_SECONDS = 3;

const num = (n: number) => String(Math.round(n * 1000) / 1000);

export function timeline(seconds: number[]): { start: number; end: number }[] {
  let t = 0;
  return seconds.map((s) => ({ start: t, end: (t += s) }));
}

// Narration sentences timed proportionally to their character count over the real audio duration.
// A long sentence (> 60 characters) is split after ":" or ";" so it fits on two lines.
export function captionCues(narration: string, durationSec: number): { text: string; start: number; end: number }[] {
  const parts = narration
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .flatMap((s) => (s.length > 60 ? s.split(/(?<=[:;])\s+/) : [s]))
    .filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0);
  let t = 0;
  return parts.map((text, i) => {
    const start = t;
    t = i === parts.length - 1 ? durationSec : t + (text.length / total) * durationSec;
    return { text, start, end: t };
  });
}

// Cover frame time: the 1st segment's title has faded in (0.4 s) and the 2nd has not started; at most 1 s.
export function coverSecond(seconds: number[]): string {
  return num(Math.min(1, Math.max(FADE + 0.2, seconds[0] / 2)));
}

export function parseDuration(ffmpegStderr: string): number | null {
  const m = ffmpegStderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export type Overlay = { file: string; start: number; end: number; fade: boolean };

export type BackgroundInput = {
  images: string[];
  seconds: number[];
  chrome: string; // transparent 1080x1920 PNG with the logo and the reading gradients (same for all accounts)
  out: string;
};

export type ReelInput = {
  background: string; // silent video from `backgroundArgs` (photos + zoom + frame), same for all accounts and versions
  seconds: number[];
  overlays: Overlay[]; // text layers (transparent PNG), one at a time
  audio?: string;
  ctaCard?: { file: string; seconds: number }; // opaque 1080x1920 PNG shown after the segments, extends the video
  music?: string; // track (looped if shorter), under the voice or alone in the silent version
  out: string;
};

// One text at a time: with voice, the narration captions; without, each segment's title.
export function reelOverlays(
  variant: "voice" | "silent",
  input: { titles: string[]; cues: { file: string; start: number; end: number }[]; seconds: number[] },
): Overlay[] {
  if (variant === "voice") return input.cues.map((c) => ({ ...c, fade: false }));
  return timeline(input.seconds).map(({ start, end }, i) => ({ file: input.titles[i], start, end, fade: true }));
}

// Full-screen photos with a slow zoom, joined and with the frame on top, in a silent MP4. This is the expensive part
// of the Reel (zoompan over the enlarged image and the frame on every frame), so it is built once per Reel and
// `reelArgs` only adds the texts and audio of each version.
// Near-lossless quality (crf 12): the final version re-encodes, and the fast preset saves minutes.
export function backgroundArgs(input: BackgroundInput): string[] {
  const total = input.seconds.reduce((a, b) => a + b, 0);
  const { width: W, height: H } = SIZE;
  const [bigW, bigH] = [Math.round(W * ZOOM_SCALE), Math.round(H * ZOOM_SCALE)];
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const img of input.images) args.push("-i", img);
  args.push("-loop", "1", "-framerate", String(FPS), "-t", num(total), "-i", input.chrome);
  const f = input.images.map((_, i) => {
    const frames = Math.round(input.seconds[i] * FPS);
    // "Cover" crop (enlarged so the zoom does not pixelate) and a linear zoom from 1 to 1+ZOOM.
    return (
      `[${i}:v]scale=${bigW}:${bigH}:force_original_aspect_ratio=increase,crop=${bigW}:${bigH},` +
      `zoompan=z='1+${ZOOM}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1[z${i}]`
    );
  });
  f.push(`${input.images.map((_, i) => `[z${i}]`).join("")}concat=n=${input.images.length}:v=1:a=0[photos]`);
  f.push(`[photos][${input.images.length}:v]overlay=0:0,format=yuv420p[v]`);
  args.push("-filter_complex", f.join(";"), "-map", "[v]", "-an");
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-r", String(FPS), "-t", num(total), input.out);
  return args;
}

export function reelArgs(input: ReelInput): string[] {
  const segmentsEnd = input.seconds.reduce((a, b) => a + b, 0);
  const total = segmentsEnd + (input.ctaCard?.seconds ?? 0);
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", input.background];
  // Each layer only exists in its window (-itsoffset + -t): decoding the 1080x1920 PNG over all 600 frames of every
  // layer was most of the cost.
  for (const o of input.overlays) args.push("-loop", "1", "-framerate", String(FPS), "-itsoffset", num(o.start), "-t", num(o.end - o.start), "-i", o.file);
  if (input.ctaCard) args.push("-loop", "1", "-framerate", String(FPS), "-itsoffset", num(segmentsEnd), "-t", num(input.ctaCard.seconds), "-i", input.ctaCard.file);
  if (input.audio) args.push("-i", input.audio);
  if (input.music) args.push("-stream_loop", "-1", "-i", input.music);

  const f: string[] = [];
  let last = "0:v";
  // The closing card is an opaque layer fading in after the segments; the background freezes its last frame below.
  const overlays = input.ctaCard ? [...input.overlays, { file: input.ctaCard.file, start: segmentsEnd, end: total, fade: true }] : input.overlays;
  if (input.ctaCard) {
    f.push(`[0:v]tpad=stop_mode=clone:stop_duration=${num(input.ctaCard.seconds)}[bg]`);
    last = "bg";
  }
  overlays.forEach((o, i) => {
    let src = `${1 + i}:v`;
    if (o.fade) {
      f.push(`[${src}]format=rgba,fade=t=in:st=${num(o.start)}:d=${FADE}:alpha=1[o${i}]`);
      src = `o${i}`;
    }
    f.push(`[${last}][${src}]overlay=0:0:eof_action=pass:enable='between(t,${num(o.start)},${num(o.end)})'[b${i}]`);
    last = `b${i}`;
  });
  f.push(`[${last}]format=yuv420p[v]`);
  const audioIdx = 1 + overlays.length;
  const musicIdx = audioIdx + (input.audio ? 1 : 0);
  const fades = `afade=t=in:d=0.8,afade=t=out:st=${num(Math.max(total - 1.5, 0))}:d=1.5`;
  // Final volume at the Instagram standard (~-16 LUFS); with voice, the music sits at -30 LUFS underneath.
  // loudnorm returns 192 kHz audio with no channel layout: aformat pins 48 kHz stereo again.
  const pin = "aformat=sample_rates=48000:channel_layouts=stereo";
  const final = `loudnorm=I=-16:TP=-1.5:LRA=11,${pin}`;
  if (input.audio && input.music) {
    f.push(`[${musicIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${num(total)},loudnorm=I=-30:TP=-2,${pin},${fades}[m]`);
    f.push(`[${audioIdx}:a]apad[n]`);
    f.push(`[n][m]amix=inputs=2:duration=longest:normalize=0,atrim=0:${num(total)},${final}[a]`);
  } else if (input.music) {
    f.push(`[${musicIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${num(total)},${fades},${final}[a]`);
  } else if (input.audio) {
    f.push(`[${audioIdx}:a]apad[a]`);
  }
  const hasAudio = Boolean(input.audio || input.music);

  args.push("-filter_complex", f.join(";"), "-map", "[v]");
  if (hasAudio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "160k");
  else args.push("-an");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", "-t", num(total), input.out);
  return args;
}

// --- HTML layers (transparent), rendered to PNG by Playwright ---

const base = (brand: Brand, body: string, account: Account, css = "") => `<!doctype html><html lang="${brand.lang(account)}"><head><meta charset="utf-8"><style>
${brand.fontFaces}
*{box-sizing:border-box;margin:0}html,body{width:${SIZE.width}px;height:${SIZE.height}px;background:transparent;overflow:hidden}
body{font-family:${brand.fontStack};position:relative;-webkit-font-smoothing:antialiased}${css}</style></head><body>${body}</body></html>`;

// Text always anchored above the bottom strip and away from the buttons on the right.
const TEXT_BOTTOM = SAFE.bottom + 40;

// Frame: logo below the top strip and dark gradients at the top and bottom so the text reads over the photo.
export function chromeHtml(brand: Brand, account: Account): string {
  const shade = brand.colors.dark;
  return base(
    brand,
    `<div class="top"></div><div class="bottom"></div><div class="brand">${brand.lockup(true)}</div>`,
    account,
    `.top{position:absolute;left:0;right:0;top:0;height:520px;background:linear-gradient(${rgba(shade, 0.55)},${rgba(shade, 0)})}
.bottom{position:absolute;left:0;right:0;bottom:0;height:1000px;background:linear-gradient(${rgba(shade, 0)},${rgba(shade, 0.88)} 62%)}
.brand{position:absolute;left:${SIDE}px;top:${SAFE.top + 20}px}.brand svg,.brand img{height:52px;width:auto;display:block}`,
  );
}

export function segmentTextHtml(brand: Brand, text: string, account: Account): string {
  return base(
    brand,
    `<h1>${esc(text)}</h1>`,
    account,
    `h1{position:absolute;left:${SIDE}px;right:${SAFE.right}px;bottom:${TEXT_BOTTOM}px;font-size:84px;font-weight:800;line-height:1.05;letter-spacing:-.03em;color:#fff;text-wrap:balance}`,
  );
}

// Burned-in caption (a narration sentence), in the same place as the title: one text at a time.
export function cueHtml(brand: Brand, text: string, account: Account): string {
  return base(
    brand,
    `<p>${esc(text)}</p>`,
    account,
    `p{position:absolute;left:${SIDE}px;right:${SAFE.right}px;bottom:${TEXT_BOTTOM}px;font-size:58px;font-weight:800;line-height:1.15;letter-spacing:-.015em;color:#fff;text-wrap:balance}`,
  );
}

// Closing card: opaque dark background, logo and the account's CTA in light text, outside the Instagram UI strips.
export function ctaCardHtml(brand: Brand, text: string, account: Account): string {
  const T = brand.colors;
  return base(
    brand,
    `<div class="brand">${brand.lockup(true)}</div><p>${esc(text)}</p>`,
    account,
    `html,body{background:${T.dark}}
.brand{position:absolute;left:${SIDE}px;top:${SAFE.top + 20}px}.brand svg,.brand img{height:52px;width:auto;display:block}
p{position:absolute;left:${SIDE}px;right:${SAFE.right}px;top:${SAFE.top + 260}px;bottom:${SAFE.bottom}px;display:flex;align-items:center;font-size:76px;font-weight:800;line-height:1.1;letter-spacing:-.025em;color:#fff;text-wrap:balance}`,
  );
}

// --- ffmpeg-static ---

export const ffmpegBin = (): string => {
  const path = createRequire(import.meta.url)("ffmpeg-static") as string | null;
  if (!path) throw new Error("ffmpeg-static has no binary: run `npm install-scripts approve ffmpeg-static` and `npm rebuild ffmpeg-static`");
  return path;
};

export function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin(), args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-600)}`))));
  });
}

// Duration of an audio/video file: `ffmpeg -i` with no output exits with 1 but prints the duration.
export async function mediaDuration(file: string): Promise<number> {
  const stderr = await new Promise<string>((resolve, reject) => {
    const proc = spawn(ffmpegBin(), ["-hide_banner", "-i", file]);
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", () => resolve(err));
  });
  const d = parseDuration(stderr);
  if (d == null) throw new Error(`could not read the duration of ${file}`);
  return d;
}
