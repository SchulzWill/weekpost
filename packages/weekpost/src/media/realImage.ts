// Real photo kept in the week folder for the first Reel segment (`image_file`): checked before generating.
// Privacy: the photo goes to a public profile, so it must carry no EXIF (where GPS lives), XMP or IPTC.
// The cover sent to the Graph API is a Reel frame rendered by us (JPEG 1080x1920, sRGB, well under 8 MB);
// the 8 MB limit and the JPEG format apply here so the source photo follows the same contract as `cover_url`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Issue, Post } from "../content/post.ts";

export const REAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
// The shorter side is scaled up to 1080 px in the Reel; below 720 px the photo gets pixelated.
const MIN_SIDE = 720;

// APPn markers that carry camera or authorship metadata. APP0 (JFIF) and APP2 (ICC profile) stay: they identify nobody.
const METADATA: { marker: number; prefix: string; name: string }[] = [
  { marker: 0xe1, prefix: "Exif\0", name: "EXIF" },
  { marker: 0xe1, prefix: "http://ns.adobe.com/xap/1.0/", name: "XMP" },
  { marker: 0xed, prefix: "Photoshop 3.0", name: "IPTC" },
];

export function inspectJpeg(buf: Buffer): { width: number; height: number; metadata: string[] } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("the file is not a JPEG");
  const metadata: string[] = [];
  let width = 0;
  let height = 0;
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // end of image or start of compressed data
    const len = buf.readUInt16BE(i + 2);
    const body = buf.subarray(i + 4, i + 2 + len);
    const hit = METADATA.find((m) => m.marker === marker && body.subarray(0, m.prefix.length).toString("latin1") === m.prefix);
    if (hit) metadata.push(hit.name);
    else if (marker >= 0xe3 && marker <= 0xef && marker !== 0xee) metadata.push(`APP${marker - 0xe0}`);
    // SOF0..SOF15, except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      height = body.readUInt16BE(1);
      width = body.readUInt16BE(3);
    }
    i += 2 + len;
  }
  return { width, height, metadata };
}

// Checks the real photo of a Reel: inside the week folder, .jpg, up to 8 MB, readable JPEG, no metadata, enough resolution.
export function checkRealImages(post: Post, weekDir: string): Issue[] {
  if (post.type !== "reel") return [];
  const issues: Issue[] = [];
  post.reel.segments.forEach((s, i) => {
    if (!s.image_file) return;
    const err = (message: string) => issues.push({ level: "error", where: `${post.id} reel.segments[${i}].image_file`, message });
    const file = resolve(weekDir, s.image_file);
    const rel = relative(resolve(weekDir), file);
    if (isAbsolute(s.image_file) || rel.startsWith("..") || isAbsolute(rel)) return err(`${s.image_file}: the path must stay inside the week folder`);
    if (!/\.jpe?g$/i.test(s.image_file)) return err(`${s.image_file}: use .jpg (JPEG, the Reel cover format of the Graph API)`);
    if (!existsSync(file)) return err(`${s.image_file} does not exist in the week folder`);
    if (statSync(file).size > REAL_IMAGE_MAX_BYTES) return err(`${s.image_file} is over 8 MB`);
    let info: ReturnType<typeof inspectJpeg>;
    try {
      info = inspectJpeg(readFileSync(file));
    } catch (e) {
      return err(`${s.image_file}: ${(e as Error).message}`);
    }
    if (info.metadata.length) {
      const what = info.metadata.map((m) => (m === "EXIF" ? "EXIF (may contain GPS)" : m)).join(", ");
      return err(`${s.image_file} has metadata: ${what}. Re-save it without metadata (ffmpeg -map_metadata -1)`);
    }
    if (Math.min(info.width, info.height) < MIN_SIDE) err(`${s.image_file} is ${info.width}x${info.height}: the shorter side needs at least ${MIN_SIDE} px`);
  });
  return issues;
}
