import { describe, expect, it } from "vitest";
import { testConfig } from "../content/fixtures.ts";
import type { Post } from "../content/post.ts";
import { captionFor } from "./caption.ts";

const config = testConfig();
const base = {
  date: "2026-10-12", accounts: ["a", "b"], times: { a: "11:00", b: "15:00" }, pillar: "seasonal",
  caption: { a: "Legenda.", b: "Legenda b.", en: "Caption." }, cta: { a: "Link na bio.", b: "Link na bio!", en: "Link in bio." },
  link: { a: "https://example.com/a/", b: "https://example.com/b/", en: "https://example.com/en/" },
} as const;
const reelOf = (segments: unknown[]) => ({ ...base, id: "r", type: "reel", reel: { segments, narration: {} } }) as unknown as Post;

describe("captionFor", () => {
  it("carousels and Reels end with the illustrative notice, after the CTA", () => {
    const carousel = { ...base, id: "c", type: "carousel", slides: [] } as unknown as Post;
    expect(captionFor(carousel, "a", config)).toBe("Legenda.\n\nLink na bio.\n\nImagens ilustrativas.");
    expect(captionFor(reelOf([]), "b", config)).toBe("Legenda b.\n\nLink na bio!\n\nImagens ilustrativas.");
  });

  it("an English account gets the notice in English", () => {
    expect(captionFor(reelOf([]), "en", config)).toBe("Caption.\n\nLink in bio.\n\nIllustrative images.");
  });

  it("a Reel with a real first photo says the first image is real", () => {
    const reel = reelOf([{ text: {}, image_file: "a.jpg", seconds: 3 }]);
    expect(captionFor(reel, "a", config)).toBe("Legenda.\n\nLink na bio.\n\nA primeira imagem é real. As outras são ilustrativas.");
    expect(captionFor(reel, "en", config)).toBe("Caption.\n\nLink in bio.\n\nThe first image is real. The others are illustrative.");
  });

  it("a Story gets no notice (Instagram Stories have no caption)", () => {
    const story = { ...base, id: "x", type: "story", story: { text: {}, link_utm_content: "s" } } as unknown as Post;
    expect(captionFor(story, "b", config)).toBe("Legenda b.\n\nLink na bio!");
  });
});
