import { describe, expect, it } from "vitest";
import { testConfig } from "../content/fixtures.ts";
import type { Post } from "../content/post.ts";
import { illustrativeNotice } from "./caption.ts";
import { lintPost as lint } from "./core.ts";

const NOTE = "Informational content.";
const config = testConfig();
const lintPost = (p: Post, cfg = config) => lint(p, cfg);

type Carousel = Extract<Post, { type: "carousel" }>;

// Reel tests reuse the carousel base, swapping type and blocks.
function post(over: Record<string, unknown> = {}): Carousel {
  return {
    id: "2026-10-12-carousel-test",
    date: "2026-10-12",
    type: "carousel",
    accounts: ["a", "b"],
    times: { a: "11:00", b: "15:00" },
    pillar: "myth",
    slides: [
      { kicker: { a: "Mito", b: "Mito" }, title: { a: "Isso resolve?", b: "Isso resolve?" }, sub: { a: "Não.", b: "Não." }, dark: true, image_prompt: "x" },
      { kicker: { a: "Ponto 1", b: "Ponto 1" }, title: { a: "A causa", b: "A causa" }, sub: { a: "Primeiro.", b: "Primeiro." }, dark: false, image_prompt: "y" },
    ],
    caption: { a: `Descubra a causa. ${NOTE}`, b: `Descubra a causa. ${NOTE}` },
    cta: { a: "Veja no link na bio.", b: "Veja no link na bio." },
    link: { a: "https://example.com/a/?utm_source=ig", b: "https://example.com/b/?utm_source=ig" },
    ...over,
  } as Carousel;
}

const errors = (p: Post, cfg = config) => lintPost(p, cfg).filter((i) => i.level === "error");
const warnings = (p: Post) => lintPost(p).filter((i) => i.level === "warn");

describe("lintPost", () => {
  it("accepts a correct post", () => {
    expect(lintPost(post())).toEqual([]);
  });

  it("limits the published caption to 2,200 characters", () => {
    const issues = errors(post({ caption: { a: `${"a".repeat(2200)} ${NOTE}`, b: `ok ${NOTE}` } }));
    expect(issues).toHaveLength(1);
    expect(issues[0].where).toBe("2026-10-12-carousel-test a caption");
  });

  it("counts the illustrative-images notice towards the 2,200 limit", () => {
    const cta = "Veja no link na bio.";
    const notice = illustrativeNotice("pt-PT", false);
    // caption + "\n\n" + cta + "\n\n" + notice is exactly 2,200 characters, so one more character breaks it.
    const fill = 2200 - cta.length - notice.length - 4;
    const exact = post({ accounts: ["a"], times: { a: "11:00" }, caption: { a: "a".repeat(fill) } });
    expect(errors(exact)).toEqual([]);
    const over = post({ accounts: ["a"], times: { a: "11:00" }, caption: { a: "a".repeat(fill + 1) } });
    expect(errors(over).some((i) => /2200/.test(i.message))).toBe(true);
  });

  it("limits hashtags to 5", () => {
    const tags = "#a #b #c #d #e #f";
    expect(errors(post({ caption: { a: `${tags} ${NOTE}`, b: `ok ${NOTE}` } })).some((i) => /6 hashtags/.test(i.message))).toBe(true);
  });

  it("forbids a link in the caption or CTA", () => {
    expect(errors(post({ cta: { a: "Veja https://example.com/a/ no link na bio", b: "link na bio" } })).some((i) => /link in the caption/.test(i.message))).toBe(true);
  });

  it("warns when a slide title is too long for the template", () => {
    const p = post();
    p.slides[0].title = { a: "Um título muito comprido que não cabe em quatro linhas no painel do slide", b: "Curto" };
    expect(warnings(p)).toHaveLength(1);
  });

  describe("CTA words from the config", () => {
    it("requires a configured word in carousel and Reel CTAs, whole word and case-insensitive", () => {
      const issues = errors(post({ cta: { a: "Saiba mais.", b: "Veja no LINK NA BIO." } }));
      expect(issues).toHaveLength(1);
      expect(issues[0].where).toBe("2026-10-12-carousel-test a cta");
      expect(issues[0].message).toBe('CTA must contain one of: "link na bio"');
    });

    it("does not match inside a longer word (so the CTA is missing)", () => {
      expect(errors(post({ accounts: ["en"], times: { en: "12:00" }, caption: { en: "Fine." }, cta: { en: "Follow the link in biography." } })).some((i) => i.where.endsWith("en cta"))).toBe(true);
    });

    it("skips the check with cta: null", () => {
      const off = testConfig({ ctaEn: null });
      expect(errors(post({ accounts: ["en"], times: { en: "12:00" }, caption: { en: "Fine." }, cta: { en: "Anything." } }), off)).toEqual([]);
    });

    it("does not apply to Stories", () => {
      const story = post({ type: "story", slides: undefined, story: { text: { a: "Vagas.", b: "Vagas." }, link_utm_content: "s" }, cta: { a: "Saiba mais.", b: "Saiba mais." } });
      expect(errors(story)).toEqual([]);
    });
  });

  describe("en account", () => {
    const EN_NOTE = "Informational content only.";
    const en = (over: Record<string, unknown> = {}) => post({
      accounts: ["en"], times: { en: "12:00" },
      slides: [
        { kicker: { en: "Myth" }, title: { en: "Does it fix it?" }, sub: { en: "No." }, dark: true, image_prompt: "x" },
        { kicker: { en: "Point 1" }, title: { en: "The cause" }, sub: { en: "First." }, dark: false, image_prompt: "y" },
      ],
      caption: { en: `Find the cause. ${EN_NOTE}` }, cta: { en: "Details at the link in bio." },
      link: { en: "https://example.com/en/?utm_source=instagram" }, ...over,
    });

    it("forbids a URL in the caption and limits hashtags", () => {
      expect(errors(en({ cta: { en: "See https://example.com, link in bio" } }))).toHaveLength(1);
      expect(errors(en({ caption: { en: `#a #b #c #d #e #f ${EN_NOTE}` } })).some((i) => /hashtags/.test(i.message))).toBe(true);
    });
  });

  describe("season words without `season`", () => {
    const seasonal = (over: Record<string, unknown> = {}) => lintPost(post(over)).filter((i) => i.message.includes("season"));

    it("warns when the text mentions a season and the post has no `season`", () => {
      const w = seasonal({ caption: { a: `Antes do verão, regue as ervas. ${NOTE}`, b: `Antes do verão, regue as ervas. ${NOTE}` } });
      expect(w.length).toBeGreaterThan(0);
      expect(w[0].level).toBe("warn");
    });

    it("warns for a hashtag and for an image_prompt", () => {
      expect(seasonal({ caption: { a: `Herbs. #verão ${NOTE}`, b: `Herbs. #verão ${NOTE}` } })).toHaveLength(1);
      const p = post();
      p.slides[0].image_prompt = "Quintal com folhas de verão";
      expect(lintPost(p).filter((i) => i.message.includes("season"))).toHaveLength(1);
    });

    it("does not warn with `season` declared or with no season word", () => {
      expect(seasonal({ season: "autumn", accounts: ["a"], times: { a: "11:00" }, caption: { a: `Antes do verão. ${NOTE}` } })).toEqual([]);
      expect(seasonal()).toEqual([]);
    });

    it("b only: «outono» in October warns because in the south it is spring", () => {
      const w = seasonal({ accounts: ["b"], times: { b: "15:00" }, caption: { b: `Ervas fortes no outono. ${NOTE}` } });
      expect(w).toHaveLength(1);
      expect(w[0].where).toContain(" b ");
    });

    it("en only: «before winter» in October passes, the next season is legitimate anticipation", () => {
      const cta = { en: "Notify me at launch: link in bio." };
      expect(seasonal({ accounts: ["en"], times: { en: "14:00" }, caption: { en: `Herbs before winter. ${NOTE}` }, cta })).toEqual([]);
    });

    it("a only: the current (autumn) and next (winter) seasons pass; the previous (summer) warns", () => {
      const only = (w: string) => seasonal({ accounts: ["a"], times: { a: "11:00" }, caption: { a: `Ervas no ${w}. ${NOTE}` } });
      expect(only("outono")).toEqual([]);
      expect(only("inverno")).toEqual([]);
      expect(only("verão")).toHaveLength(1);
    });

    it("a + b: «outono» warns because of b; each account's text counts for its own season", () => {
      expect(seasonal({ caption: { a: `Ervas no outono. ${NOTE}`, b: `Ervas fortes. ${NOTE}` } })).toEqual([]);
      expect(seasonal({ caption: { a: `Ervas. ${NOTE}`, b: `Ervas no outono. ${NOTE}` } })).toHaveLength(1);
      expect(seasonal({ caption: { a: `Ervas no outono. ${NOTE}`, b: `Ervas na primavera. ${NOTE}` } })).toEqual([]);
    });

    it("does not confuse words that only contain a season", () => {
      expect(seasonal({ caption: { a: `Primaveras? Não: verdadeiro. ${NOTE}`, b: `ok ${NOTE}` } })).toEqual([]);
    });

    it("image_prompt is checked against every season dictionary, not only the account's language", () => {
      const p = post({ accounts: ["a"], times: { a: "11:00" } });
      p.slides[1].image_prompt = "Backyard in the summer heat";
      const w = lintPost(p).filter((i) => i.message.includes("season"));
      expect(w).toHaveLength(1);
      expect(w[0].where).toBe(`${p.id} a slides[1].image_prompt`);
      expect(w[0].message).toContain("mentions summer");
    });

    it("visible text is still checked only in the account's language", () => {
      expect(seasonal({ accounts: ["a"], times: { a: "11:00" }, caption: { a: `Herbs in the summer heat. ${NOTE}` } })).toEqual([]);
    });

    it("does not check languages without a season dictionary", () => {
      const de = testConfig();
      de.accounts.en.lang = "de";
      expect(lint(post({ accounts: ["en"], times: { en: "12:00" }, caption: { en: "Im Sommer." }, cta: { en: "link in bio" } }), de).filter((i) => i.message.includes("season"))).toEqual([]);
    });
  });
});

describe("illustrativeNotice", () => {
  it("uses the language of the account and falls back to English", () => {
    expect(illustrativeNotice("pt-BR", false)).toBe("Imagens ilustrativas.");
    expect(illustrativeNotice("en", false)).toBe("Illustrative images.");
    expect(illustrativeNotice("de", false)).toBe("Illustrative images.");
    expect(illustrativeNotice("en-GB", true)).toBe("The first image is real. The others are illustrative.");
  });
});
