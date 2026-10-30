// Offline stand-in for the OpenRouter client (`weekpost generate --fake-media`): flat placeholder images,
// silent narration and an "everything matches" coherence verdict. No network, no API key, no cost.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { runFfmpeg } from "../render/reel.ts";
import type { OpenRouterClient } from "./openrouter.ts";

const free = { costUsd: 0, latencyMs: 0 };

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// A flat-color RGB PNG.
export function placeholderPng(width: number, height: number, rgb: [number, number, number] = [196, 200, 190]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Silent MP3 that lasts about as long as the text would take to read (~15 characters per second).
export async function silentMp3(text: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "weekpost-silence-"));
  const file = join(dir, "silence.mp3");
  try {
    const seconds = Math.max(1, text.length / 15);
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", seconds.toFixed(2), "-c:a", "libmp3lame", "-q:a", "9", file]);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function fakeClient(): OpenRouterClient {
  return {
    async image(body) {
      const [w, h] = String(body.aspect_ratio ?? "1:2").split(":").map(Number);
      const height = 720;
      return { bytes: placeholderPng(Math.round((height * (w || 1)) / (h || 2)), height), mediaType: "image/png", ...free };
    },
    async speech(body) {
      return { bytes: await silentMp3(String(body.input ?? "")), ...free };
    },
    async chat() {
      const args = JSON.stringify({ shows: true, reason: "placeholder image (--fake-media)" });
      return { json: { choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }] }, ...free };
    },
  };
}
