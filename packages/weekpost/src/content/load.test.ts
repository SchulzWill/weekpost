import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testConfig } from "./fixtures.ts";
import { checkContent as check } from "./load.ts";

const config = testConfig();
const checkContent = (root: string, only?: string) => check(root, config, only);

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "weekpost-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const story = (id: string, date: string) => `
  - id: ${id}
    date: ${date}
    type: story
    accounts: [a]
    times: { a: "11:00" }
    pillar: other
    story: { text: { a: "Open spots." }, link_utm_content: story-${date} }
    caption: { a: "Spots." }
    cta: { a: "Link na bio." }
    link: { a: "https://example.com/a/?utm_source=instagram&utm_medium=social&utm_campaign=a&utm_content=story-${date}" }
`;

describe("checkContent", () => {
  it("reads only week folders and returns the valid posts", () => {
    const root = tree({ "2026-W42/posts.yaml": `version: 1\nposts:${story("2026-10-12-story-a", "2026-10-12")}`, "drafts/posts.yaml": "version: 1\nposts: [" });
    const result = checkContent(root);
    expect(result.weeks.map((w) => w.week)).toEqual(["2026-W42"]);
    expect(result.issues).toEqual([]);
  });

  it("reports invalid YAML with the file", () => {
    const root = tree({ "2026-W42/posts.yaml": "version: 1\nposts: [" });
    const [issue] = checkContent(root).issues;
    expect(issue.where).toBe("2026-W42/posts.yaml");
  });

  it("rejects the same id in different weeks", () => {
    const root = tree({
      "2026-W42/posts.yaml": `version: 1\nposts:${story("2026-10-12-story-a", "2026-10-12")}`,
      "2026-W43/posts.yaml": `version: 1\nposts:${story("2026-10-12-story-a", "2026-10-19")}`,
    });
    expect(checkContent(root).issues.some((i) => /id already used in 2026-W42/.test(i.message))).toBe(true);
  });

  it("filters the requested week", () => {
    const root = tree({
      "2026-W42/posts.yaml": `version: 1\nposts:${story("2026-10-12-story-a", "2026-10-12")}`,
      "2026-W43/posts.yaml": "version: 1\nposts: [",
    });
    expect(checkContent(root, "2026-W42").issues).toEqual([]);
  });

  it("suggests quotes when a comma breaks the inline map", () => {
    const root = tree({ "2026-W42/posts.yaml": "version: 1\nposts:\n  - caption: { a: Fix it. Then, paint., b: Fix it. Then, paint. }\n" });
    expect(checkContent(root).issues[0].message).toMatch(/quote/);
  });

  describe("music", () => {
    const reel = (music: string) => `version: 1
posts:
  - id: 2026-10-14-reel-a
    date: 2026-10-14
    type: reel
    accounts: [a]
    times: { a: "11:00" }
    pillar: tip
    reel:
      segments: [{ text: { a: "A" }, image_prompt: x, seconds: 5 }]
      narration: { a: "T." }
      music: ${music}
    caption: { a: "C." }
    cta: { a: "Link na bio." }
    link: { a: "https://example.com/a/?utm_source=instagram&utm_medium=social&utm_campaign=a&utm_content=2026-10-14-reel-a" }
`;
    const musicIssues = (root: string) => checkContent(root).issues.filter((i) => i.where.endsWith("reel.music"));

    it("errors when the named file is not in assets/music/", () => {
      const root = tree({ "project/content/2026-W42/posts.yaml": reel("sunrise"), "project/assets/music/other.mp3": "x" });
      const [issue] = musicIssues(join(root, "project/content"));
      expect(issue.message).toContain('no file named "sunrise" in assets/music/');
    });

    it("accepts a file name with or without extension, and none", () => {
      const files = { "project/assets/music/sunrise.mp3": "x" };
      expect(musicIssues(join(tree({ ...files, "project/content/2026-W42/posts.yaml": reel("sunrise") }), "project/content"))).toEqual([]);
      expect(musicIssues(join(tree({ ...files, "project/content/2026-W42/posts.yaml": reel("sunrise.mp3") }), "project/content"))).toEqual([]);
      expect(musicIssues(join(tree({ "project/content/2026-W42/posts.yaml": reel("none") }), "project/content"))).toEqual([]);
    });
  });
});
