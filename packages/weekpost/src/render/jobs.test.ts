import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Post } from "../content/post.ts";
import { imageJobs, ctaCardFor, musicFor, musicPath, publishVariant, realImageFile } from "./jobs.ts";

const base = {
  date: "2026-10-12", accounts: ["a", "b"], times: { a: "11:00", b: "15:00" }, pillar: "sazonal",
  caption: { a: "Legenda.", b: "Legenda b." }, cta: { a: "Link na bio.", b: "Link na bio!" },
  link: { a: "https://example.com/a/?utm_a=1", b: "https://example.com/b/?utm_a=1" },
} as const;

describe("imageJobs", () => {
  it("generates one image per prompt, shared across accounts, with the slide or post model", () => {
    const post = {
      ...base, id: "2026-10-12-c", type: "carousel", image_model: "gpt-image-2",
      slides: [
        { kicker: {}, title: {}, sub: {}, dark: true, image_prompt: "A" },
        { kicker: {}, title: {}, sub: {}, dark: false, image_prompt: "B", image_model: "seedream-4.5" },
        { kicker: {}, title: {}, sub: {}, dark: false, image_prompt: "A" },
      ],
    } as unknown as Post;
    expect(imageJobs(post)).toEqual([
      { index: 0, prompt: "A", model: "gpt-image-2" },
      { index: 1, prompt: "B", model: "seedream-4.5" },
      { index: 2, prompt: "A", model: "gpt-image-2" },
    ]);
  });

  it("a Story without image_prompt generates no image", () => {
    const post = { ...base, id: "2026-10-12-s", type: "story", story: { text: { a: "x", b: "x" }, link_utm_content: "s" } } as unknown as Post;
    expect(imageJobs(post)).toEqual([]);
  });

  it("a Reel generates one image per segment", () => {
    const post = { ...base, id: "2026-10-12-r", type: "reel", reel: { segments: [{ text: {}, image_prompt: "X", seconds: 3 }], narration: {} } } as unknown as Post;
    expect(imageJobs(post)).toEqual([{ index: 0, prompt: "X", model: "seedream-4.5" }]);
  });

  it("a Reel with a real photo in segment 1 only generates the others (no image cost for the photo)", () => {
    const post = { ...base, id: "r", type: "reel", reel: { segments: [{ text: {}, image_file: "fotos/a.jpg", seconds: 3 }, { text: {}, image_prompt: "Y", seconds: 3 }], narration: {} } } as unknown as Post;
    expect(imageJobs(post)).toEqual([{ index: 1, prompt: "Y", model: "seedream-4.5" }]);
    expect(realImageFile(post)).toBe("fotos/a.jpg");
  });
});

describe("realImageFile", () => {
  it("null when the Reel has no real photo or the post is not a Reel", () => {
    expect(realImageFile({ ...base, id: "r", type: "reel", reel: { segments: [{ text: {}, image_prompt: "X", seconds: 3 }], narration: {} } } as unknown as Post)).toBeNull();
    expect(realImageFile({ ...base, id: "c", type: "carousel", slides: [] } as unknown as Post)).toBeNull();
  });
});

describe("musicFor / publishVariant", () => {
  const reel = (extra: Record<string, unknown>) =>
    ({ ...base, id: "r", type: "reel", reel: { segments: [], narration: {}, ...extra } }) as unknown as Post;

  it("with no field, there is no music and it publishes with voice", () => {
    expect(musicFor(reel({}))).toBeNull();
    expect(musicFor(reel({ music: "calm.mp3" }))).toBe("calm.mp3");
    expect(publishVariant(reel({}), "a")).toBe("voice");
  });

  it("music: none removes the music", () => {
    expect(musicFor(reel({ music: "none" }))).toBeNull();
  });

  it("variant per account or for all", () => {
    expect(publishVariant(reel({ variant: "silent" }), "b")).toBe("silent");
    expect(publishVariant(reel({ variant: { a: "silent" } }), "a")).toBe("silent");
    expect(publishVariant(reel({ variant: { a: "silent" } }), "b")).toBe("voice");
  });
});

describe("ctaCardFor", () => {
  const reel = (extra: Record<string, unknown> = {}) =>
    ({ ...base, id: "2026-10-12-r", type: "reel", reel: { segments: [{ text: {}, image_prompt: "X", seconds: 3 }], narration: {}, ...extra } }) as unknown as Post;

  it("returns the account CTA when the field is missing (on by default)", () => {
    expect(ctaCardFor(reel(), "b")).toBe("Link na bio!");
    expect(ctaCardFor(reel({ cta_card: true }), "a")).toBe("Link na bio.");
  });

  it("cta_card: false desliga", () => {
    expect(ctaCardFor(reel({ cta_card: false }), "a")).toBeNull();
  });

  it("only a Reel has a card", () => {
    const story = { ...base, id: "2026-10-12-s", type: "story", story: { text: {}, link_utm_content: "s" } } as unknown as Post;
    expect(ctaCardFor(story, "a")).toBeNull();
  });
});

describe("musicPath", () => {
  it("finds the track by exact name or without the extension, only in the project's assets/music", () => {
    const project = mkdtempSync(join(tmpdir(), "weekpost-music-"));
    mkdirSync(join(project, "assets", "music"), { recursive: true });
    writeFileSync(join(project, "assets", "music", "calm.mp3"), "x");
    expect(musicPath(project, "calm")).toBe(join(project, "assets", "music", "calm.mp3"));
    expect(musicPath(project, "calm.mp3")).toBe(join(project, "assets", "music", "calm.mp3"));
    expect(() => musicPath(project, "other")).toThrow(/no file named "other"/);
  });
});
