import { describe, expect, it } from "vitest";
import { testBrand } from "../../test/fixtures/brand.ts";
import { storyHtml } from "./story.ts";

const brand = testBrand();
// Font URLs point into a per-run temp dir; the rest of the markup is what the snapshot pins.
const stable = (html: string): string => html.replace(/url\("file:\/\/[^"]*weekpost-brand-[^"]*"\)/g, 'url("file:///brand-assets")');
const story = { text: { a: "Vagas no beta.", b: "Vagas." }, link_utm_content: "s" };

describe("storyHtml without a CTA", () => {
  it("keeps the exact markup, with the free sticker strip", () => {
    expect(stable(storyHtml(brand, story, "a", "file:///i.png"))).toMatchSnapshot();
    expect(stable(storyHtml(brand, story, "a"))).toMatchSnapshot();
  });

  it("is identical when opts is empty or the cta is empty", () => {
    const base = storyHtml(brand, story, "a", "file:///i.png");
    expect(storyHtml(brand, story, "a", "file:///i.png", {})).toBe(base);
    expect(storyHtml(brand, story, "a", "file:///i.png", { cta: "" })).toBe(base);
  });
});

describe("storyHtml with a CTA", () => {
  it("replaces the free strip with a card holding the escaped text", () => {
    const html = storyHtml(brand, story, "a", "file:///i.png", { cta: `Book <b>now</b> & "save"` });
    expect(html).toContain('class="cta"');
    expect(html).not.toContain('class="sticker-zone"');
    expect(html).toContain("Book &lt;b&gt;now&lt;/b&gt; &amp; &quot;save&quot;");
    expect(html).not.toContain("<b>now</b>");
  });

  it("uses the brand colors and font and shows no URL", () => {
    const html = storyHtml(brand, story, "a", undefined, { cta: "Link in the bio" });
    expect(html).toContain("Link in the bio");
    expect(html).toContain(brand.colors.primary);
    expect(html).toContain(brand.fontStack);
    expect(html.replace(/xmlns="[^"]*"/g, "")).not.toMatch(/https?:\/\//);
  });
});
