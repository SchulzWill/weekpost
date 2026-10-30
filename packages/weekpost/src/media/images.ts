// Illustrative image from a prompt (shared by all accounts), with cache and budget.
import { cacheKey, cached, store } from "./cache.ts";
import { join } from "node:path";
import { paid, type MediaDeps } from "./openrouter.ts";

// Seedream 4.5 by default; GPT Image 2 without `quality` as the alternative.
// Seedream accepts 1:2 (right half of the split slide); GPT Image 2 does not and falls back to 9:16 (the template crops).
export const IMAGE_MODELS = {
  "seedream-4.5": { id: "bytedance-seed/seedream-4.5", aspect: "1:2", estimateUsd: 0.04 },
  "gpt-image-2": { id: "openai/gpt-image-2", aspect: "9:16", estimateUsd: 0.005 },
} as const;
export type ImageModelName = keyof typeof IMAGE_MODELS;

const ext = (mediaType: string) => (mediaType.includes("jpeg") ? "jpg" : mediaType.includes("webp") ? "webp" : "png");

export async function generateImage(
  req: { prompt: string; model?: ImageModelName; item: string },
  deps: MediaDeps,
): Promise<string> {
  const m = IMAGE_MODELS[req.model ?? "seedream-4.5"];
  const dir = join(deps.cacheDir, "images");
  const key = cacheKey([m.id, req.prompt, m.aspect]);
  const hit = cached(dir, key);
  if (hit) return hit;
  const result = await paid(deps, { kind: "image", model: m.id, item: req.item, estimateUsd: m.estimateUsd }, () =>
    deps.client.image({ model: m.id, prompt: req.prompt, aspect_ratio: m.aspect, n: 1 }),
  );
  return store(dir, key, ext(result.mediaType), result.bytes);
}
