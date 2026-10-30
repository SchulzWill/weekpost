// Planning of what to generate for a post (no network, no render).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Post } from "../content/post.ts";
import type { ImageModelName } from "../media/images.ts";

export type ImageJob = { index: number; prompt: string; model: ImageModelName };

// One image per slide or segment; the same prompt and model hit the same cache file (accounts share it).
export function imageJobs(post: Post): ImageJob[] {
  const fallback = post.image_model ?? "seedream-4.5";
  if (post.type === "carousel") return post.slides.map((s, index) => ({ index, prompt: s.image_prompt, model: s.image_model ?? fallback }));
  // A real photo (image_file) is never generated.
  if (post.type === "reel") return post.reel.segments.flatMap((s, index) => (s.image_prompt ? [{ index, prompt: s.image_prompt, model: fallback }] : []));
  return post.story.image_prompt ? [{ index: 0, prompt: post.story.image_prompt, model: fallback }] : [];
}

// Path of the Reel real photo (relative to content/<week>/), or null.
export function realImageFile(post: Post): string | null {
  return post.type === "reel" ? (post.reel?.segments[0]?.image_file ?? null) : null;
}

// Music file name under assets/music/, or null (no field, or "none"). No default track ships with weekpost.
export function musicFor(post: Post): string | null {
  if (post.type !== "reel") return null;
  const m = post.reel.music;
  return !m || m === "none" ? null : m;
}

export function publishVariant(post: Post, account: string): "voice" | "silent" {
  if (post.type !== "reel" || !post.reel.variant) return "voice";
  const v = post.reel.variant;
  return typeof v === "string" ? v : (v[account] ?? "voice");
}

// Text of the Reel closing card (the account CTA), or null when the card is off (`reel.cta_card: false`) or the post is not a Reel.
export function ctaCardFor(post: Post, account: string): string | null {
  if (post.type !== "reel" || post.reel.cta_card === false) return null;
  return post.cta[account] ?? null;
}

// Absolute path of the music track in <project>/assets/music/: the exact file name, or the name without extension.
// Music comes only from the user's folder; nothing ships with weekpost.
export function musicPath(projectRoot: string, name: string): string {
  const dir = join(projectRoot, "assets", "music");
  const file = readdirSync(dir).find((f) => f === name) ?? readdirSync(dir).find((f) => f.replace(/\.[^.]+$/, "") === name);
  if (!file) throw new Error(`no file named "${name}" in assets/music/`);
  return join(dir, file);
}
