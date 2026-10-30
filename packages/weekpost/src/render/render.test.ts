import { describe, expect, it } from "vitest";
import { carouselSlideHtml } from "./carousel.ts";
import { testBrand } from "../../test/fixtures/brand.ts";
import type { Manifest } from "./manifest.ts";
import { previewHtml } from "./preview.ts";
import { storyHtml } from "./story.ts";

const brand = testBrand();
const slide = {
  kicker: { a: "Ponto 3", b: "Ponto 3" },
  title: { a: "Ervas e vasos", b: "Ervas e vasos" },
  sub: { a: "Vaso sem furo deixa a raiz encharcada.", b: "Vaso sem furo deixa a raiz encharcada." },
  dark: false,
  image_prompt: "Vaso",
};

describe("carouselSlideHtml", () => {
  it("builds kicker, title, sub and the n/N page of the requested account", () => {
    const html = carouselSlideHtml(brand, slide, "b", { index: 3, total: 9, imageUrl: "file:///img.png" });
    expect(html).toContain(">Ponto 3<");
    expect(html).toContain("<h1>Ervas e vasos</h1>");
    expect(html).toContain(">4/9<");
    expect(html).toContain('url("file:///img.png")');
  });

  it("leaves no empty tip box when the slide has no tip", () => {
    expect(carouselSlideHtml(brand, slide, "a", { index: 0, total: 2, imageUrl: "x" })).not.toContain('class="tip"');
  });

  it("shows the tip when there is one", () => {
    const html = carouselSlideHtml(brand, { ...slide, tip: { a: "Passe o dedo.", b: "Passe o dedo." } }, "a", { index: 0, total: 2, imageUrl: "x" });
    expect(html).toContain('<div class="tip">Passe o dedo.</div>');
  });

  it("escapes the content text", () => {
    const html = carouselSlideHtml(brand, { ...slide, title: { a: "1 < 2 & <script>", b: "x" } }, "a", { index: 0, total: 2, imageUrl: "x" });
    expect(html).toContain("1 &lt; 2 &amp; &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("uses the dark panel with light text on a dark slide", () => {
    const html = carouselSlideHtml(brand, { ...slide, dark: true }, "a", { index: 0, total: 2, imageUrl: "x" });
    expect(html).toContain('data-surface="dark"');
  });

  it("uses text legible on a phone: label >= 24 px, subtitle 34-36 px and tip >= 28 px", () => {
    const html = carouselSlideHtml(brand, { ...slide, tip: { a: "Dica.", b: "Dica." } }, "a", { index: 0, total: 2, imageUrl: "x" });
    const size = (cls: string) => Number(html.match(new RegExp(`\\.${cls}\\{[^}]*font-size:(\\d+)px`))![1]);
    expect(size("kicker")).toBeGreaterThanOrEqual(24);
    expect(size("sub")).toBeGreaterThanOrEqual(34);
    expect(size("sub")).toBeLessThanOrEqual(36);
    expect(size("tip")).toBeGreaterThanOrEqual(28);
  });

  it("vertically centers the text block in the panel", () => {
    const html = carouselSlideHtml(brand, slide, "a", { index: 0, total: 2, imageUrl: "x" });
    expect(html).toMatch(/\.panel\{[^}]*justify-content:center/);
    expect(html).toMatch(/\.lockup\{[^}]*position:absolute/);
    expect(html).toMatch(/\.foot\{[^}]*position:absolute/);
  });

  it("uses the account lang", () => {
    expect(carouselSlideHtml(brand, slide, "b", { index: 0, total: 2, imageUrl: "x" })).toContain('lang="pt-BR"');
    expect(carouselSlideHtml(brand, slide, "a", { index: 0, total: 2, imageUrl: "x" })).toContain('lang="pt-PT"');
  });
});

describe("brand in the slide and the Story", () => {
  it("the slide uses the brand colors, font and logo", () => {
    const html = carouselSlideHtml(brand, slide, "b", { index: 0, total: 2, imageUrl: "x" });
    expect(html).toContain("background:#F7F4EA");
    expect(html).toContain('font-family:"Test Sans",sans-serif');
    expect(html).toContain('aria-label="Horta Viva"');
  });

  it("the Story uses the dark logo, the brand dark background and the account language", () => {
    const html = storyHtml(brand, { text: { b: "Oi." }, link_utm_content: "s" }, "b");
    expect(html).toContain("background:#173A20");
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain('fill="#E6F2E3"');
  });

  it("a PNG logo is placed with an <img> in the slide", () => {
    const png = Buffer.from("placeholder png bytes");
    const pngBrand = testBrand({ logo: { file: "assets/l.png", fileOnDark: "assets/d.png" } }, { "assets/l.png": png, "assets/d.png": png });
    expect(carouselSlideHtml(pngBrand, slide, "b", { index: 0, total: 2, imageUrl: "x" })).toMatch(/<div class="lockup"><img src="data:image\/png/);
  });
});

describe("storyHtml", () => {
  it("builds text and image with no label on the media and reserves the sticker strip", () => {
    const html = storyHtml(brand, { text: { a: "Vagas no beta.", b: "Vagas." }, link_utm_content: "s" }, "a", "file:///i.png");
    expect(html).toContain("Vagas no beta.");
    expect(html).toContain('class="photo"');
    expect(html).not.toContain('class="tag"');
    expect(html).toContain('class="sticker-zone"');
  });

  it("works without an image", () => {
    const html = storyHtml(brand, { text: { a: "Vagas.", b: "Vagas." }, link_utm_content: "s" }, "a");
    expect(html).not.toContain('class="photo"');
  });
});

describe("previewHtml", () => {
  const HASH = "b".repeat(64);
  const accounts = { en: { handle: "shop.en", lang: "en" }, a: { handle: "shop.a", lang: "pt-PT" } };
  const manifest: Manifest = {
    version: 1,
    generator: "weekpost@0.1.0",
    week: "2026-W42",
    spentUsd: 0.4321,
    budgetUsd: 5,
    warnings: [{ level: "warn", where: "p1 a caption", message: "a lint warning" }],
    posts: [
      {
        id: "2026-10-12-carousel",
        type: "carousel",
        date: "2026-10-12",
        times: { en: "11:00", a: "15:00" },
        timeZones: { en: "Europe/London", a: "Europe/Lisbon" },
        contentHash: HASH,
        accounts: {
          en: { files: ["2026-10-12-carousel/en/01.jpg"], publish: ["2026-10-12-carousel/en/01.jpg"], caption: "Caption <en>", sha256: { "2026-10-12-carousel/en/01.jpg": HASH } },
          a: { files: ["2026-10-12-carousel/a/01.jpg"], publish: ["2026-10-12-carousel/a/01.jpg"], caption: "Legenda a", sha256: { "2026-10-12-carousel/a/01.jpg": HASH } },
        },
        coherence: [{ index: 0, shows: false, reason: "does not show a pot" }],
      },
    ],
  };
  const reel = (account: Manifest["posts"][number]["accounts"][string]): Manifest => ({ ...manifest, posts: [{ ...manifest.posts[0], accounts: { en: account } }] });

  it("lists the files per account with relative paths and escapes the caption", () => {
    const html = previewHtml(manifest, accounts);
    expect(html).toContain('src="2026-10-12-carousel/en/01.jpg"');
    expect(html).toContain("Caption &lt;en&gt;");
  });

  it("labels each account with its @handle, time zone and language", () => {
    const html = previewHtml(manifest, accounts);
    expect(html).toContain("@shop.en · 11:00 (Europe/London)");
    expect(html).toContain('<div class="acc" lang="pt-PT">');
  });

  it("falls back to the account id when the handle is unknown", () => {
    expect(previewHtml(manifest)).toContain("@en · 11:00");
  });

  it("marks the Reel version that will be published, and the music", () => {
    const html = previewHtml(reel({ files: ["r/en/voice.mp4", "r/en/silent.mp4"], publish: ["r/en/silent.mp4"], music: "light", caption: "", sha256: { "r/en/silent.mp4": HASH } }), accounts);
    expect(html).toMatch(/silent · publishes/);
    expect(html).not.toMatch(/voice · publishes/);
    expect(html).toContain("Music: light");
  });

  it("shows the video with the extracted poster", () => {
    const html = previewHtml(reel({ files: ["r/en/voice.mp4"], publish: ["r/en/voice.mp4"], caption: "", sha256: { "r/en/voice.mp4": HASH } }), accounts);
    expect(html).toContain('poster="r/en/voice.jpg"');
  });

  it("flags an image that does not show its text", () => {
    expect(previewHtml(manifest, accounts)).toMatch(/Review.*does not show a pot/s);
  });

  it("shows the week cost and the lint warnings in English", () => {
    const html = previewHtml(manifest, accounts);
    expect(html).toContain("US$0.43 of US$5");
    expect(html).toContain("a lint warning");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Lint warnings");
  });

  it("uses neutral colors, not a brand palette", () => {
    expect(previewHtml(manifest, accounts)).not.toMatch(/#2F6B3A|#7FC48B/i);
  });
});
