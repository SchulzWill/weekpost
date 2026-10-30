// Fingerprint of a post as written in posts.yaml: sha-256 of its canonical JSON (keys sorted, no whitespace).
// The manifest records it so whoever publishes can check the post it is about to send is the one that was approved.
import { createHash } from "node:crypto";
import type { Post } from "./post.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export const contentHash = (post: Post) => createHash("sha256").update(JSON.stringify(canonical(post))).digest("hex");
