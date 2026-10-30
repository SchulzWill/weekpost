import { describe, expect, it } from "vitest";
import { testConfig } from "./fixtures.ts";
import { isoWeekOf, validateWeek as validate } from "./week.ts";

const config = testConfig();
// Contract v1 files start with `version: 1`.
const validateWeek = (week: string, raw: Record<string, unknown>, cfg = config) => validate(week, { version: 1, ...raw }, cfg);

const NOTE = "Informational content.";

function carousel(overrides: Record<string, unknown> = {}) {
  return {
    id: "2026-10-12-carousel-test",
    date: "2026-10-12",
    type: "carousel",
    accounts: ["a", "b"],
    times: { a: "11:00", b: "15:00" },
    pillar: "seasonal",
    slides: [
      { kicker: { a: "Capa", b: "Capa" }, title: { a: "Título", b: "Título" }, sub: { a: "Sub", b: "Sub" }, dark: true, image_prompt: "Horta" },
      { kicker: { a: "Ponto 1", b: "Ponto 1" }, title: { a: "Manjericão", b: "Hortelã" }, sub: { a: "Sub", b: "Sub" }, dark: false, image_prompt: "Vaso" },
    ],
    caption: { a: `Caption. ${NOTE}`, b: `Caption. ${NOTE}` },
    cta: { a: "Link na bio.", b: "Link na bio." },
    link: {
      a: "https://example.com/a/?utm_source=instagram&utm_medium=social&utm_campaign=a&utm_content=carousel-test",
      b: "https://example.com/b/?utm_source=instagram&utm_medium=social&utm_campaign=b&utm_content=carousel-test",
    },
    ...overrides,
  };
}

describe("isoWeekOf", () => {
  it("returns the ISO week in the YYYY-Www format", () => {
    expect(isoWeekOf("2026-10-12")).toBe("2026-W42");
  });

  it("uses the ISO year at the turn of the year", () => {
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
  });
});

describe("validateWeek", () => {
  it("accepts a valid carousel", () => {
    const result = validateWeek("2026-W42", { posts: [carousel()] });
    expect(result.issues).toEqual([]);
    expect(result.posts).toHaveLength(1);
  });

  it("requires the text of every listed account", () => {
    const post = carousel();
    (post.slides as { title: Record<string, string> }[])[1].title = { a: "Manjericão" };
    const { issues } = validateWeek("2026-W42", { posts: [post] });
    expect(issues.map((i) => i.message)).toContain("missing text for b");
    expect(issues[0].where).toContain("slides[1].title");
  });

  it("rejects a date outside the folder week", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ id: "2026-10-19-carousel-test", date: "2026-10-19" })] });
    expect(issues.some((i) => /outside week 2026-W42/.test(i.message))).toBe(true);
  });

  it("requires the id to start with the date", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ id: "carousel-test" })] });
    expect(issues.some((i) => /id must start with 2026-10-12/.test(i.message))).toBe(true);
  });

  it("rejects repeated ids", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel(), carousel()] });
    expect(issues.some((i) => /repeated id/.test(i.message))).toBe(true);
  });

  it("requires an HH:MM time per account", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ times: { a: "11h" } })] });
    expect(issues.some((i) => i.where.endsWith("times.a"))).toBe(true);
    expect(issues.some((i) => i.message === "missing time for b")).toBe(true);
  });

  it("rejects a link that is not the account base URL with UTM", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ link: { a: "https://example.com/b/?utm_source=x", b: "https://example.com/b/" } })] });
    expect(issues.filter((i) => i.where.includes("link"))).toHaveLength(2);
  });

  it("requires the UTM convention: instagram, social, campaign = account and utm_content", () => {
    const { issues } = validateWeek("2026-W42", {
      posts: [carousel({ link: {
        a: "https://example.com/a/?utm_source=instagram&utm_medium=social&utm_campaign=pilot&utm_content=x",
        b: "https://example.com/b/?utm_source=instagram&utm_medium=story&utm_campaign=b",
      } })],
    });
    const msgs = issues.filter((i) => i.where.includes("link")).map((i) => i.message).join(" | ");
    expect(msgs).toContain("utm_campaign=a");
    expect(msgs).toContain("utm_medium=social");
    expect(msgs).toContain("utm_content");
  });

  it("on a Story, the link utm_content is link_utm_content", () => {
    const story = carousel({
      id: "2026-10-13-story-beta", date: "2026-10-13", type: "story", pillar: "other", slides: undefined,
      story: { text: { a: "Vagas.", b: "Vagas." }, link_utm_content: "story-2026-10-13" },
    });
    expect(validateWeek("2026-W42", { posts: [story] }).issues.some((i) => /utm_content=story-2026-10-13/.test(i.message))).toBe(true);
  });

  it("accepts 2 to 10 slides", () => {
    const one = carousel();
    one.slides = one.slides.slice(0, 1);
    expect(validateWeek("2026-W42", { posts: [one] }).issues.some((i) => /2 to 10 slides/.test(i.message))).toBe(true);
    const eleven = carousel();
    eleven.slides = Array.from({ length: 11 }, () => one.slides[0]);
    expect(validateWeek("2026-W42", { posts: [eleven] }).issues.some((i) => /2 to 10 slides/.test(i.message))).toBe(true);
  });

  it("accepts image_model only seedream-4.5 or gpt-image-2", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ image_model: "flux" })] });
    expect(issues.some((i) => i.where.endsWith("image_model"))).toBe(true);
  });

  it("limits the Reel to config.reel.maxSeconds in total", () => {
    const reel = carousel({
      id: "2026-10-14-reel-teste",
      date: "2026-10-14",
      type: "reel",
      pillar: "myth",
      slides: undefined,
      reel: {
        segments: [
          { text: { a: "A", b: "A" }, image_prompt: "x", seconds: 12 },
          { text: { a: "B", b: "B" }, image_prompt: "y", seconds: 9 },
        ],
        narration: { a: "Texto.", b: "Texto." },
      },
    });
    const { issues } = validateWeek("2026-W42", { posts: [reel] });
    expect(issues.some((i) => /21 s.*20 s/.test(i.message))).toBe(true);
  });

  it("accepts free-form music and a published variant (for all accounts or per account)", () => {
    const reel = (extra: Record<string, unknown>) => carousel({
      id: "2026-10-14-reel-teste", date: "2026-10-14", type: "reel", pillar: "myth", slides: undefined,
      reel: { segments: [{ text: { a: "A", b: "A" }, image_prompt: "x", seconds: 5 }], narration: { a: "T.", b: "T." }, ...extra },
    });
    expect(validateWeek("2026-W42", { posts: [reel({ music: "jazz", variant: "silent" })] }).issues).toEqual([]);
    expect(validateWeek("2026-W42", { posts: [reel({ music: "none", variant: { a: "voice", b: "silent" } })] }).issues).toEqual([]);
    expect(validateWeek("2026-W42", { posts: [reel({ cta_card: false })] }).issues).toEqual([]);
    expect(validateWeek("2026-W42", { posts: [reel({ cta_card: "no" })] }).issues.some((i) => i.where.includes("cta_card"))).toBe(true);
    expect(validateWeek("2026-W42", { posts: [reel({ variant: "muda" })] }).issues.some((i) => i.where.includes("variant"))).toBe(true);
  });

  it("real photo (image_file) only on the 1st segment and instead of image_prompt", () => {
    const seg = (extra: Record<string, unknown>) => ({ text: { a: "A", b: "A" }, seconds: 3, ...extra });
    const reel = (segments: unknown[]) => carousel({
      id: "2026-10-14-reel-teste", date: "2026-10-14", type: "reel", pillar: "tip", slides: undefined,
      reel: { segments, narration: { a: "T.", b: "T." } },
    });
    const issues = (segments: unknown[]) => validateWeek("2026-W42", { posts: [reel(segments)] }).issues.map((i) => `${i.where}: ${i.message}`);
    expect(issues([seg({ image_file: "fotos/a.jpg" }), seg({ image_prompt: "x" })])).toEqual([]);
    expect(issues([seg({ image_file: "fotos/a.jpg", image_prompt: "x" })])).toEqual([expect.stringMatching(/segments\[0\].*exactly one/)]);
    expect(issues([seg({})])).toEqual([expect.stringMatching(/segments\[0\].*exactly one/)]);
    expect(issues([seg({ image_prompt: "x" }), seg({ image_file: "fotos/a.jpg" })])).toEqual([expect.stringMatching(/segments\[1\].*only on the 1st segment/)]);
  });

  it("requires the block of the post type", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ type: "story", slides: undefined })] });
    expect(issues.some((i) => i.where.endsWith("story"))).toBe(true);
  });

  it("accepts a Story with an optional image", () => {
    const story = carousel({
      id: "2026-10-13-story-beta",
      date: "2026-10-13",
      type: "story",
      pillar: "other",
      slides: undefined,
      story: { text: { a: "Vagas no beta.", b: "Vagas no beta." }, link_utm_content: "story-2026-10-13" },
      link: {
        a: "https://example.com/a/?utm_source=instagram&utm_medium=social&utm_campaign=a&utm_content=story-2026-10-13",
        b: "https://example.com/b/?utm_source=instagram&utm_medium=social&utm_campaign=b&utm_content=story-2026-10-13",
      },
    });
    expect(validateWeek("2026-W42", { posts: [story] }).issues).toEqual([]);
  });

  describe("enqueue_accounts", () => {
    it("absent = undefined (all accounts)", () => {
      expect(validateWeek("2026-W42", { posts: [carousel()] }).enqueueAccounts).toBeUndefined();
    });

    it("accepts a list of valid accounts", () => {
      const r = validateWeek("2026-W42", { enqueue_accounts: ["en"], posts: [carousel()] });
      expect(r.issues).toEqual([]);
      expect(r.enqueueAccounts).toEqual(["en"]);
    });

    it("rejects an unknown or repeated account, or an empty list", () => {
      const msgs = (v: unknown) => validateWeek("2026-W42", { enqueue_accounts: v, posts: [carousel()] }).issues.map((i) => `${i.where}: ${i.message}`).join(" | ");
      expect(msgs(["fr"])).toMatch(/enqueue_accounts/);
      expect(msgs(["en", "en"])).toMatch(/repeated/);
      expect(msgs([])).toMatch(/enqueue_accounts/);
      expect(msgs("en")).toMatch(/enqueue_accounts/);
    });
  });

  it("accepts an en-only post with text, /en/ link and en voice", () => {
    const en = carousel({
      id: "2026-10-16-reel-teste", date: "2026-10-16", type: "reel", accounts: ["en"], times: { en: "12:00" }, pillar: "myth", slides: undefined,
      reel: { segments: [{ text: { en: "Cracks" }, image_prompt: "x", seconds: 5 }], narration: { en: "Cracks." }, voice: { en: "abc" } },
      caption: { en: "Caption" }, cta: { en: "Link in bio." },
      link: { en: "https://example.com/en/?utm_source=instagram&utm_medium=social&utm_campaign=en&utm_content=2026-10-16-reel-teste" },
    });
    expect(validateWeek("2026-W42", { posts: [en] }).issues).toEqual([]);
  });
});

describe("season: by hemisphere", () => {
  const post = (over: Record<string, unknown>) => validateWeek("2026-W44", { posts: [carousel({ id: "2026-10-26-carousel-test", date: "2026-10-26", ...over })] });
  const msgs = (r: ReturnType<typeof post>) => r.issues.filter((i) => i.level === "error").map((i) => `${i.where}: ${i.message}`);

  it("rejects autumn on a + b in October and suggests one post per account", () => {
    const r = post({ season: "autumn" });
    expect(msgs(r)).toHaveLength(1);
    expect(msgs(r)[0]).toMatch(/autumn.*b.*spring.*one post per account/s);
  });

  it("accepts autumn on a only", () => {
    expect(msgs(post({ season: "autumn", accounts: ["a"], times: { a: "11:00" } }))).toEqual([]);
  });

  it("accepts spring on b only", () => {
    expect(msgs(post({ season: "spring", accounts: ["b"], times: { b: "15:00" } }))).toEqual([]);
  });

  it("accepts a post with no seasonal theme", () => {
    expect(msgs(post({}))).toEqual([]);
  });

  it("rejects an unknown season", () => {
    expect(msgs(post({ season: "monsoon" }))[0]).toMatch(/season/);
  });
});

describe("contract v1", () => {
  it("requires `version: 1`, with the fix in the message", () => {
    const missing = validate("2026-W42", { posts: [carousel()] }, config).issues;
    expect(missing).toEqual([expect.objectContaining({ where: "2026-W42 version", message: expect.stringContaining("version: 1") })]);
    const wrong = validate("2026-W42", { version: 2, posts: [carousel()] }, config).issues;
    expect(wrong[0].message).toContain("is 2");
  });

  it("rejects an account that is not in the config", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ accounts: ["fr"], times: { fr: "10:00" } })] });
    expect(issues.some((i) => /unknown account "fr".*a, b, en/.test(i.message))).toBe(true);
  });

  it("rejects text keyed by an unknown account", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ caption: { a: "a", b: "b", de: "c" } })] });
    expect(issues.some((i) => i.where.endsWith("caption.de") && /unknown account/.test(i.message))).toBe(true);
  });

  it("rejects a pillar that is not in the config", () => {
    const { issues } = validateWeek("2026-W42", { posts: [carousel({ pillar: "dica" })] });
    expect(issues.some((i) => i.where.endsWith("pillar") && /not a pillar.*tip, seasonal/.test(i.message))).toBe(true);
  });

  it("takes reel.maxSeconds from the config", () => {
    const reel = carousel({
      id: "2026-10-14-reel-teste", date: "2026-10-14", type: "reel", pillar: "myth", slides: undefined,
      reel: { segments: [{ text: { a: "A", b: "A" }, image_prompt: "x", seconds: 25 }], narration: { a: "T.", b: "T." } },
    });
    expect(validateWeek("2026-W42", { posts: [reel] }, testConfig({ reelMax: 30 })).issues).toEqual([]);
    expect(validateWeek("2026-W42", { posts: [reel] }).issues.some((i) => /25 s.*20 s/.test(i.message))).toBe(true);
  });

  it("takes the link base from each account", () => {
    const other = { ...config, accounts: { ...config.accounts, a: { ...config.accounts.a, link: { base: "https://shop.example/a/" } } } };
    const { issues } = validateWeek("2026-W42", { posts: [carousel()] }, other);
    expect(issues.filter((i) => i.where.endsWith("link.a")).map((i) => i.message)).toEqual(["use https://shop.example/a/?utm_..."]);
  });

  it("scopes variant keys to the config accounts", () => {
    const reel = (variant: unknown) => carousel({
      id: "2026-10-14-reel-teste", date: "2026-10-14", type: "reel", pillar: "myth", slides: undefined,
      reel: { segments: [{ text: { a: "A", b: "A" }, image_prompt: "x", seconds: 5 }], narration: { a: "T.", b: "T." }, variant },
    });
    expect(validateWeek("2026-W42", { posts: [reel({ a: "voice", xx: "silent" })] }).issues.some((i) => /unknown account "xx"/.test(i.message))).toBe(true);
  });

  it("uses the hemisphere of the account for season", () => {
    const flipped = { ...config, accounts: { ...config.accounts, a: { ...config.accounts.a, hemisphere: "south" as const } } };
    const post = carousel({ id: "2026-10-26-carousel-test", date: "2026-10-26", season: "spring", accounts: ["a"], times: { a: "11:00" } });
    expect(validateWeek("2026-W44", { posts: [post] }, flipped).issues.filter((i) => i.where.endsWith("season"))).toEqual([]);
    expect(validateWeek("2026-W44", { posts: [post] }).issues.some((i) => i.where.endsWith("season"))).toBe(true);
  });
});
