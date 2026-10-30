import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/index.ts";
import { COLORS, testBrand, testConfig, testProject } from "../../test/fixtures/brand.ts";
import { brandFrom, esc, rgba } from "./brand.ts";

describe("brandFrom: colors, language and name", () => {
  it("exposes the 8 color tokens of the config", () => {
    expect(testBrand().colors).toEqual(COLORS);
  });

  it("returns the language of each account and fails for an unknown one", () => {
    const brand = testBrand();
    expect(brand.lang("b")).toBe("pt-BR");
    expect(brand.lang("a")).toBe("pt-PT");
    expect(() => brand.lang("zz")).toThrow(/account "zz"/);
  });
});

describe("brandFrom: font", () => {
  it("emits one @font-face per file, with the family, weight, format and file URL", () => {
    const brand = testBrand();
    expect(brand.fontFaces).toContain('font-family:"Test Sans"');
    expect(brand.fontFaces).toContain("font-weight:400");
    expect(brand.fontFaces).toContain("font-weight:800");
    expect(brand.fontFaces).toContain('format("woff2")');
    expect(brand.fontFaces).toMatch(/url\("file:\/\/[^"]*test-800\.woff2"\)/);
    expect(brand.fontStack).toBe('"Test Sans",sans-serif');
  });

  it("maps .ttf and .woff to their CSS formats", () => {
    const { config } = parseConfig({ ...testConfig(), brand: { ...testConfig().brand, font: { family: "X", files: { 400: "a.ttf", 800: "b.woff" } } } });
    const faces = brandFrom(config, testProject()).fontFaces;
    expect(faces).toContain('format("truetype")');
    expect(faces).toContain('format("woff")');
  });

  it("keeps a quote in the family name from breaking out of the CSS string", () => {
    const { config } = parseConfig({ ...testConfig(), brand: { ...testConfig().brand, font: { family: 'A"};x{', files: { 400: "a.woff2", 800: "b.woff2" } } } });
    const brand = brandFrom(config, testProject());
    expect(brand.fontStack).toBe('"A\\"};x{",sans-serif');
  });
});

describe("brandFrom: SVG logo", () => {
  it("recolors the symbol and the wordmark on a light background", () => {
    const svg = testBrand().lockup(false);
    expect(svg).toContain('fill="#2F6B3A"');
    expect(svg).toContain('fill="#141A14"');
  });

  it("recolors to onDark and white on a dark background", () => {
    const svg = testBrand().lockup(true);
    expect(svg).toContain('fill="#E6F2E3"');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).not.toContain("#2F6B3A");
    expect(svg).not.toContain("#141A14");
  });

  it("does not chain replacements when a target color equals another source color", () => {
    // The file's #141A14 plays the primary role and its #2F6B3A the fg role: both swap, a sequential replace would collapse them.
    const brand = testBrand({ logo: { file: "assets/logo.svg", recolor: { primary: "#141A14", fg: "#2F6B3A" } } });
    const svg = brand.lockup(false);
    expect(svg).toContain('<circle cx="20" cy="20" r="16" fill="#141A14"');
    expect(svg).toContain('fill="#2F6B3A">Horta Viva');
  });

  it("names the logo after the brand, escaped, and drops the XML prolog", () => {
    const { config } = parseConfig({ ...testConfig(), brand: { ...testConfig().brand, name: 'Horta "Viva" <1>' } });
    const svg = brandFrom(config, testProject()).lockup(false);
    expect(svg).toMatch(/^<svg role="img" aria-label="Horta &quot;Viva&quot; &lt;1&gt;"/);
    expect(svg).not.toContain("<?xml");
  });

  it("replaces a role and aria-label already on the file instead of duplicating them", () => {
    const project = testProject({ "assets/logo.svg": '<svg role="presentation" aria-label="Old" viewBox="0 0 1 1"><path fill="#2F6B3A" d="M0 0"/></svg>' });
    const svg = brandFrom(parseConfig(testConfig({ logo: { file: "assets/logo.svg", recolor: { primary: "#2F6B3A" } } })).config, project).lockup(false);
    expect(svg.match(/aria-label=/g)).toHaveLength(1);
    expect(svg.match(/role=/g)).toHaveLength(1);
    expect(svg).toContain('aria-label="Horta Viva"');
  });

  it("without recolor, uses the file as is on both backgrounds", () => {
    const brand = testBrand({ logo: { file: "assets/logo.svg" } });
    expect(brand.lockup(true)).toContain('fill="#2F6B3A"');
    expect(brand.lockup(false)).toBe(brand.lockup(true));
  });

  it("uses fileOnDark for dark backgrounds when given", () => {
    const dark = '<svg viewBox="0 0 1 1"><path fill="#FFFFFF" d="M0 0"/></svg>';
    const brand = testBrand({ logo: { file: "assets/logo.svg", fileOnDark: "assets/logo-dark.svg" } }, { "assets/logo-dark.svg": dark });
    expect(brand.lockup(true)).toContain('fill="#FFFFFF"');
    expect(brand.lockup(false)).toContain('fill="#2F6B3A"');
  });

  it("fails with a clear message when a recolor source color is not in the file", () => {
    const { config } = parseConfig(testConfig({ logo: { file: "assets/logo.svg", recolor: { primary: "#ABCDEF" } } }));
    expect(() => brandFrom(config, testProject())).toThrow(/recolor\.primary #ABCDEF.*assets\/logo\.svg/);
  });
});

describe("brandFrom: PNG logo", () => {
  const png = Buffer.from("placeholder png bytes");
  const brand = () => testBrand({ logo: { file: "assets/logo.png", fileOnDark: "assets/logo-dark.png" } }, { "assets/logo.png": png, "assets/logo-dark.png": png });

  it("embeds the PNG as a data URL image named after the brand", () => {
    const html = brand().lockup(false);
    expect(html).toMatch(/^<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="Horta Viva">$/);
  });

  it("uses fileOnDark on dark backgrounds", () => {
    const b = testBrand({ logo: { file: "assets/logo.png", fileOnDark: "assets/logo-dark.png" } }, { "assets/logo.png": png, "assets/logo-dark.png": Buffer.from("DARK") });
    expect(b.lockup(true)).toContain(Buffer.from("DARK").toString("base64"));
    expect(b.lockup(false)).not.toContain(Buffer.from("DARK").toString("base64"));
  });
});

describe("brandFrom: missing logo file", () => {
  it("names the field and the path", () => {
    const { config } = parseConfig(testConfig({ logo: { file: "assets/nope.svg" } }));
    expect(() => brandFrom(config, testProject())).toThrow(/brand\.logo\.file.*assets\/nope\.svg/);
  });
});

describe("rgba and esc", () => {
  it("converts #RRGGBB to rgba()", () => {
    expect(rgba("#173A20", 0.55)).toBe("rgba(23,58,32,0.55)");
  });
  it("escapes HTML", () => {
    expect(esc(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
  });
});
