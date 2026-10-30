// Content cache: the key is the sha256 of the parts (model, prompt, aspect, voice...), joined by \0
// so that ["ab", ""] and ["a", "b"] do not collide.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function cacheKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function cached(dir: string, key: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const hit = readdirSync(dir).find((f) => f.startsWith(`${key}.`));
  return hit ? join(dir, hit) : undefined;
}

export function store(dir: string, key: string, ext: string, bytes: Buffer | string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${key}.${ext}`);
  writeFileSync(file, bytes);
  return file;
}
