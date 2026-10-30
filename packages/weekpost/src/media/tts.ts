// Narration with ElevenLabs v4 through OpenRouter. Catalog voices only (a name such as "george", or a voice
// library ID); cloned voices are not supported through this client.
import { join } from "node:path";
import { cacheKey, cached, store } from "./cache.ts";
import { paid, type MediaDeps } from "./openrouter.ts";

export const TTS_MODEL = "elevenlabs/eleven-v4";
// Estimate used when the generation returns no cost: pricing.prompt (USD per input character) of the
// elevenlabs/eleven-v4 endpoint, 2026-10-29.
// Source: https://openrouter.ai/api/v1/models/elevenlabs/eleven-v4/endpoints
export const TTS_PRICE_PER_CHAR = 0.00008;

// The voice of a post for one account: the one written in the post YAML (`reel.voice.<account>`) wins over
// `config.accounts.<account>.voice`.
export function resolveVoice(
  accounts: Record<string, { voice: string }>,
  account: string,
  yamlVoices: Record<string, string> | undefined,
): string {
  const voice = yamlVoices?.[account] ?? accounts[account]?.voice;
  if (!voice) throw new Error(`no voice for account "${account}": set accounts.${account}.voice in weekpost.config.ts`);
  return voice;
}

export async function narrate(req: { text: string; voice: string; item: string }, deps: MediaDeps): Promise<string> {
  const dir = join(deps.cacheDir, "tts");
  const key = cacheKey([TTS_MODEL, req.voice, req.text]);
  const hit = cached(dir, key);
  if (hit) return hit;
  const result = await paid(deps, { kind: "tts", model: TTS_MODEL, item: req.item, estimateUsd: req.text.length * TTS_PRICE_PER_CHAR }, () =>
    deps.client.speech({ model: TTS_MODEL, input: req.text, voice: req.voice, response_format: "mp3" }),
  );
  return store(dir, key, "mp3", result.bytes);
}
