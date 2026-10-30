import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkContent } from "../content/load.ts";
import { testConfig } from "../content/fixtures.ts";
import type { Issue, Post } from "../content/post.ts";
import { captionFor } from "./caption.ts";
import { lintPost } from "./core.ts";
import type { LintContext, LintPlugin } from "./plugin.ts";

// A brand-free plugin used only by these tests: no shouting, a required tag per pillar, a fixed caption suffix.
const calm: LintPlugin = {
  name: "calm",
  lintText(text, field, ctx) {
    return /\b[A-Z]{4,}\b/.test(text) ? [{ level: "warn", where: "", message: `shouting in ${ctx.account} ${field}` }] : [];
  },
  lintPost(post) {
    return post.pillar === "myth" && !post.notes ? [{ level: "error", where: "", message: "myth posts need notes" }] : [];
  },
  captionSuffix(post, account) {
    return post.type === "story" ? undefined : `(${account})`;
  },
};

const NOTE = "Informational content.";
function post(over: Record<string, unknown> = {}): Post {
  return {
    id: "2026-10-12-carousel-test", date: "2026-10-12", type: "carousel", accounts: ["en"], times: { en: "12:00" }, pillar: "tip",
    slides: [
      { kicker: { en: "Tip" }, title: { en: "First" }, sub: { en: "One." }, dark: true, image_prompt: "x" },
      { kicker: { en: "Tip" }, title: { en: "Second" }, sub: { en: "Two." }, dark: false, image_prompt: "y" },
    ],
    caption: { en: `Caption. ${NOTE}` }, cta: { en: "See the link in bio." },
    link: { en: "https://example.com/en/?utm_source=instagram" },
    ...over,
  } as Post;
}

describe("lint plugins", () => {
  const config = testConfig({ plugins: [calm] });

  it("runs lintText for each text field and account with the account language", () => {
    const calls: [string, string, string][] = [];
    const spy: LintPlugin = { name: "spy", lintText: (_t, field, ctx: LintContext) => (calls.push([ctx.account, ctx.lang, field]), []) };
    lintPost(post({ accounts: ["a", "en"], times: { a: "11:00", en: "12:00" }, caption: { a: "C.", en: "C." }, cta: { a: "Link na bio.", en: "Link in bio." },
      slides: [
        { kicker: { a: "K", en: "K" }, title: { a: "T", en: "T" }, sub: { a: "S", en: "S" }, dark: true, image_prompt: "x" },
        { kicker: { a: "K", en: "K" }, title: { a: "T", en: "T" }, sub: { a: "S", en: "S" }, dark: false, image_prompt: "y" },
      ] }), testConfig({ plugins: [spy] }));
    expect(calls).toContainEqual(["a", "pt-PT", "slides[0].title"]);
    expect(calls).toContainEqual(["en", "en", "caption"]);
    expect(calls.some(([, , field]) => field === "link")).toBe(false);
  });

  it("fills an empty `where` with the post, account and field", () => {
    const issues = lintPost(post({ caption: { en: "WARNING about it. Informational." } }), config);
    expect(issues).toContainEqual({ level: "warn", where: "2026-10-12-carousel-test en caption", message: "shouting in en caption" });
  });

  it("fills an empty `where` of lintPost with the post id and keeps explicit ones", () => {
    const loud: LintPlugin = { name: "x", lintPost: () => [{ level: "warn", where: "", message: "a" }, { level: "warn", where: "custom", message: "b" }] };
    const issues = lintPost(post(), testConfig({ plugins: [loud] }));
    expect(issues.map((i) => i.where)).toEqual(["2026-10-12-carousel-test", "custom"]);
  });

  it("an error from a plugin blocks the check", () => {
    const root = mkdtempSync(join(tmpdir(), "weekpost-"));
    mkdirSync(join(root, "content/2026-W42"), { recursive: true });
    writeFileSync(join(root, "content/2026-W42/posts.yaml"), `version: 1
posts:
  - id: 2026-10-12-carousel-test
    date: 2026-10-12
    type: carousel
    accounts: [en]
    times: { en: "12:00" }
    pillar: myth
    slides:
      - { kicker: { en: K }, title: { en: A }, sub: { en: S }, dark: true, image_prompt: x }
      - { kicker: { en: K }, title: { en: B }, sub: { en: S }, dark: false, image_prompt: y }
    caption: { en: "Caption." }
    cta: { en: "See the link in bio." }
    link: { en: "https://example.com/en/?utm_source=instagram&utm_medium=social&utm_campaign=en&utm_content=carousel-test" }
`);
    const { issues } = checkContent(join(root, "content"), config);
    expect(issues.filter((i) => i.level === "error").map((i) => i.message)).toEqual(["myth posts need notes"]);
  });

  it("turns a plugin that throws into an error issue", () => {
    const boom: LintPlugin = { name: "boom", lintText: () => { throw new Error("bad regex"); }, lintPost: () => { throw new Error("nope"); } };
    const issues: Issue[] = lintPost(post(), testConfig({ plugins: [boom] }));
    expect(issues.some((i) => i.level === "error" && i.message === 'plugin "boom" failed: nope')).toBe(true);
    expect(issues.some((i) => i.level === "error" && i.message === 'plugin "boom" failed: bad regex')).toBe(true);
  });

  it("appends captionSuffix to the published caption, after the notice, and not on Stories", () => {
    const p = post();
    expect(captionFor(p, "en", config)).toBe(`Caption. ${NOTE}\n\nSee the link in bio.\n\nIllustrative images.\n\n(en)`);
    const story = post({ type: "story", slides: undefined, story: { text: { en: "T" }, link_utm_content: "s" } });
    expect(captionFor(story, "en", config)).toBe(`Caption. ${NOTE}\n\nSee the link in bio.`);
  });

  it("passes { config } as the third argument to captionSuffix, so a plugin can pick text by account language", () => {
    const byLang: LintPlugin = {
      name: "by-lang",
      captionSuffix: (_post, account, ctx) => (ctx?.config.accounts[account].lang === "en" ? "Fixed line." : "Linha fixa."),
    };
    const cfg = testConfig({ plugins: [byLang] });
    expect(captionFor(post(), "en", cfg).endsWith("\n\nFixed line.")).toBe(true);
    cfg.accounts.en.lang = "pt-BR";
    expect(captionFor(post(), "en", cfg).endsWith("\n\nLinha fixa.")).toBe(true);
  });

  it("counts captionSuffix towards the 2,200 limit", () => {
    const fill = 2200 - "See the link in bio.".length - "Illustrative images.".length - "(en)".length - 6;
    const at = post({ caption: { en: "a".repeat(fill) } });
    expect(lintPost(at, config).filter((i) => i.level === "error")).toEqual([]);
    const over = post({ caption: { en: "a".repeat(fill + 1) } });
    expect(lintPost(over, config).some((i) => /2200/.test(i.message))).toBe(true);
  });

  it("reports a captionSuffix that throws instead of crashing", () => {
    const boom: LintPlugin = { name: "boom", captionSuffix: () => { throw new Error("no suffix"); } };
    expect(lintPost(post(), testConfig({ plugins: [boom] })).some((i) => /captionSuffix failed: no suffix/.test(i.message))).toBe(true);
  });
});
