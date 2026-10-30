import { describe, expect, it } from "vitest";
import { contentHash } from "./hash.ts";
import type { Post } from "./post.ts";

const post = (over: Record<string, unknown> = {}) =>
  ({ id: "p", type: "story", date: "2026-10-12", accounts: ["en"], story: { text: { en: "Hi" }, link_utm_content: "s" }, ...over }) as unknown as Post;

describe("contentHash", () => {
  it("is a sha-256 hex digest that does not depend on key order or undefined fields", () => {
    const a = contentHash(post());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({ story: { link_utm_content: "s", text: { en: "Hi" } }, accounts: ["en"], date: "2026-10-12", type: "story", id: "p", notes: undefined } as unknown as Post)).toBe(a);
  });

  it("changes when any text changes", () => {
    expect(contentHash(post({ story: { text: { en: "Hello" }, link_utm_content: "s" } }))).not.toBe(contentHash(post()));
  });
});
