import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import template from "../../template/weekpost.config.ts";
import { ConfigError, defineConfig, loadConfig, parseConfig } from "./index.ts";

// A fully valid config; every invalid case below changes one thing in a copy of it.
const valid = () => ({
  brand: {
    name: "Horta Viva",
    colors: {
      primary: "#2F6B3A", dark: "#173A20", bg: "#F7F4EA", fg: "#141A14",
      muted: "#5B6157", tint: "#E3EFE0", onDark: "#E6F2E3", onDarkMuted: "#C2D8BD",
    },
    font: { family: "Inter", files: { 400: "assets/fonts/inter-400.woff2", 800: "assets/fonts/inter-800.woff2" } },
    logo: { file: "assets/logo.svg", recolor: { primary: "#2F6B3A", fg: "#141A14" } },
  },
  accounts: {
    b: { handle: "hortaviva.b", lang: "pt-BR", timeZone: "America/Sao_Paulo", hemisphere: "south", voice: "sarah", cta: ["link na bio"], link: { base: "https://hortaviva.example/b/" } },
    en: { handle: "hortaviva.en", lang: "en", timeZone: "Europe/London", hemisphere: "north", voice: "george", cta: ["link in bio"], link: { base: "https://hortaviva.example/en/" } },
  },
  pillars: ["dica", "sazonal", "receita", "outro"],
  reel: { maxSeconds: 20 },
  budget: { weeklyUsd: 5 },
  lint: { plugins: [] },
});

// Applies a mutation to a fresh valid config and returns the issue lines ("path: message").
function issuesFor(mutate: (c: any) => void): string[] {
  const c = valid();
  mutate(c);
  try {
    parseConfig(c);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}

describe("parseConfig: valid input", () => {
  it("accepts the example config and keeps its values", () => {
    const { config, warnings } = parseConfig(valid());
    expect(config.accounts.b.timeZone).toBe("America/Sao_Paulo");
    expect(config.reel.maxSeconds).toBe(20);
    expect(warnings).toEqual([]);
  });

  it("fills neutral defaults for reel, budget and lint", () => {
    const { reel, budget, lint, ...rest } = valid();
    const { config } = parseConfig(rest);
    expect(config.reel.maxSeconds).toBe(20);
    expect(config.budget.weeklyUsd).toBe(5);
    expect(config.lint.plugins).toEqual([]);
  });

  it("leaves sources undefined, and accepts adapters (objects with name and pull)", () => {
    expect(parseConfig(valid()).config.sources).toBeUndefined();
    const adapter = { name: "x", pull: async () => [] };
    expect(parseConfig({ ...valid(), sources: [adapter] }).config.sources).toEqual([adapter]);
  });

  it("rejects a source that cannot pull", () => {
    expect(() => parseConfig({ ...valid(), sources: [{ name: "x" }] })).toThrow(/sources/);
  });

  it("defaults ci.previewLabel to media-ok and accepts another label", () => {
    expect(parseConfig(valid()).config.ci.previewLabel).toBe("media-ok");
    expect(parseConfig({ ...valid(), ci: { previewLabel: "approve-media" } }).config.ci.previewLabel).toBe("approve-media");
    expect(() => parseConfig({ ...valid(), ci: { previewLabel: " " } })).toThrow();
    expect(() => parseConfig({ ...valid(), ci: { previewLabel: "has,comma" } })).toThrow();
  });

  it("accepts an optional media.visionHint and rejects an empty one", () => {
    expect(parseConfig({ ...valid(), media: { visionHint: "Photos of vegetable gardens" } }).config.media.visionHint).toBe("Photos of vegetable gardens");
    expect(parseConfig(valid()).config.media).toEqual({});
    expect(() => parseConfig({ ...valid(), media: { visionHint: "  " } })).toThrow();
  });

  it("accepts cta null (turns the CTA check off)", () => {
    expect(issuesFor((c) => (c.accounts.b.cta = null))).toEqual([]);
  });

  it("accepts the shipped template", () => {
    expect(() => parseConfig(template)).not.toThrow();
  });

  it("defineConfig returns its input unchanged", () => {
    const c = valid();
    expect(defineConfig(c as any)).toBe(c);
  });
});

describe("parseConfig: accounts", () => {
  it("rejects zero accounts", () => {
    expect(issuesFor((c) => (c.accounts = {}))).toEqual(["accounts: define 1 to 10 accounts (got 0)"]);
  });

  it("rejects more than 10 accounts", () => {
    expect(
      issuesFor((c) => {
        c.accounts = {};
        for (let i = 0; i < 11; i++) c.accounts[`a${i}`] = valid().accounts.b;
      }),
    ).toEqual(["accounts: define 1 to 10 accounts (got 11)"]);
  });

  it("rejects an account id that is not lowercase/digits/hyphens", () => {
    expect(issuesFor((c) => ((c.accounts.B_1 = c.accounts.b), delete c.accounts.b))).toEqual([
      "accounts.B_1: account id must match ^[a-z][a-z0-9-]{0,15}$ (lowercase letters, digits, hyphens; max 16 characters)",
    ]);
  });

  it("rejects an invalid language tag", () => {
    expect(issuesFor((c) => (c.accounts.b.lang = "pt_BR!"))).toEqual(["accounts.b.lang: pt_BR! is not a BCP-47 language tag (e.g. pt-BR)"]);
  });

  it("rejects a time zone that is not IANA", () => {
    expect(issuesFor((c) => (c.accounts.b.timeZone = "America/Sao_Paul"))).toEqual([
      "accounts.b.timeZone: America/Sao_Paul is not an IANA time zone (e.g. America/Sao_Paulo)",
    ]);
  });

  it("rejects a hemisphere other than north or south", () => {
    expect(issuesFor((c) => (c.accounts.b.hemisphere = "east"))).toEqual(['accounts.b.hemisphere: use "north" or "south"']);
  });

  it("rejects a handle with @", () => {
    expect(issuesFor((c) => (c.accounts.b.handle = "@hortaviva.b"))).toEqual(["accounts.b.handle: write the handle without the @"]);
  });

  it("rejects a handle with characters Instagram does not allow (quotes, spaces, line breaks)", () => {
    for (const bad of ["h\n'evil", "has space", "quo'te", "a/b", "x".repeat(31)]) {
      expect(issuesFor((c) => (c.accounts.b.handle = bad)), JSON.stringify(bad)).toEqual(["accounts.b.handle: use only letters, digits, dots and underscores (30 characters at most)"]);
    }
    expect(issuesFor((c) => (c.accounts.b.handle = "horta_viva.b2"))).toEqual([]);
  });

  it("rejects an empty voice", () => {
    expect(issuesFor((c) => (c.accounts.b.voice = ""))).toEqual(["accounts.b.voice: voice is empty (use a catalog voice name or ID)"]);
  });

  it("rejects an empty CTA list", () => {
    expect(issuesFor((c) => (c.accounts.b.cta = []))).toEqual(["accounts.b.cta: list 1 to 10 words or phrases, or null to turn the check off"]);
  });

  it("rejects more than 10 CTA entries", () => {
    expect(issuesFor((c) => (c.accounts.b.cta = Array.from({ length: 11 }, (_, i) => `w${i}`)))).toEqual([
      "accounts.b.cta: list 1 to 10 words or phrases, or null to turn the check off",
    ]);
  });

  it("rejects a CTA entry that is a regex object or empty text", () => {
    expect(issuesFor((c) => (c.accounts.b.cta = [""]))).toEqual(["accounts.b.cta[0]: CTA entry is empty"]);
  });

  it("rejects a link base that is not https", () => {
    expect(issuesFor((c) => (c.accounts.b.link.base = "http://hortaviva.example/b/"))).toEqual([
      "accounts.b.link.base: use an https:// URL",
    ]);
  });

  it("rejects an unknown account key", () => {
    expect(issuesFor((c) => (c.accounts.b.color = "red"))).toEqual(['accounts.b: Unrecognized key: "color"']);
  });
});

describe("parseConfig: brand", () => {
  it("rejects an empty brand name", () => {
    expect(issuesFor((c) => (c.brand.name = " "))).toEqual(["brand.name: brand name is empty"]);
  });

  it("rejects a color that is not #RRGGBB", () => {
    expect(issuesFor((c) => (c.brand.colors.primary = "green"))).toEqual(["brand.colors.primary: green is not a #RRGGBB color"]);
  });

  it("rejects a missing color token", () => {
    const lines = issuesFor((c) => delete c.brand.colors.tint);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("brand.colors.tint: ")).toBe(true);
  });

  it("warns (does not fail) when onDark has less than 4.5:1 contrast on dark", () => {
    const c = valid();
    c.brand.colors.onDark = "#2A5A33";
    const { warnings } = parseConfig(c);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^brand\.colors\.onDark: contrast on brand\.colors\.dark is \d+\.\d{2}:1, below 4\.5:1$/);
  });

  it("rejects font files without the 800 weight", () => {
    expect(issuesFor((c) => (c.brand.font.files = { 400: "assets/fonts/inter-400.woff2" }))).toEqual([
      "brand.font.files: add a weight-800 file (used for titles)",
    ]);
  });

  it("rejects font files without a 400 to 500 weight", () => {
    expect(issuesFor((c) => (c.brand.font.files = { 800: "assets/fonts/inter-800.woff2" }))).toEqual([
      "brand.font.files: add a weight-400 to 500 file (used for body text)",
    ]);
  });

  it("rejects a font file with an unsupported extension", () => {
    expect(issuesFor((c) => (c.brand.font.files[800] = "assets/fonts/inter-800.otf"))).toEqual([
      "brand.font.files.800: use a .woff2, .woff or .ttf file",
    ]);
  });

  it("rejects a logo that is neither svg nor png", () => {
    expect(issuesFor((c) => (c.brand.logo.file = "assets/logo.jpg"))).toEqual(["brand.logo.file: use a .svg or .png file"]);
  });

  it("rejects recolor on a png logo", () => {
    expect(
      issuesFor((c) => {
        c.brand.logo = { file: "assets/logo.png", fileOnDark: "assets/logo-dark.png", recolor: { primary: "#2F6B3A" } };
      }),
    ).toEqual(["brand.logo.recolor: recolor only works with an .svg logo"]);
  });

  it("requires fileOnDark for a png logo", () => {
    expect(issuesFor((c) => (c.brand.logo = { file: "assets/logo.png" }))).toEqual([
      "brand.logo.fileOnDark: a .png logo needs a version for dark backgrounds",
    ]);
  });
});

describe("parseConfig: pillars, reel, budget, lint", () => {
  it("rejects an empty pillar list", () => {
    expect(issuesFor((c) => (c.pillars = []))).toEqual(["pillars: list 1 to 20 pillars"]);
  });

  it("rejects more than 20 pillars", () => {
    expect(issuesFor((c) => (c.pillars = Array.from({ length: 21 }, (_, i) => `p${i}`)))).toEqual(["pillars: list 1 to 20 pillars"]);
  });

  it("rejects reel.maxSeconds below 5", () => {
    expect(issuesFor((c) => (c.reel.maxSeconds = 4))).toEqual(["reel.maxSeconds: use a value from 5 to 90 seconds"]);
  });

  it("rejects reel.maxSeconds above 90", () => {
    expect(issuesFor((c) => (c.reel.maxSeconds = 91))).toEqual(["reel.maxSeconds: use a value from 5 to 90 seconds"]);
  });

  it("rejects a budget of zero", () => {
    expect(issuesFor((c) => (c.budget.weeklyUsd = 0))).toEqual(["budget.weeklyUsd: must be greater than 0"]);
  });

  it("rejects lint.plugins that is not a list", () => {
    const lines = issuesFor((c) => (c.lint.plugins = "x"));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("lint.plugins: ")).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    expect(issuesFor((c) => (c.colour = "x"))).toEqual(['(config): Unrecognized key: "colour"']);
  });

  it("reports every problem at once, not just the first", () => {
    const lines = issuesFor((c) => {
      c.pillars = [];
      c.reel.maxSeconds = 1;
    });
    expect(lines).toHaveLength(2);
  });
});

describe("loadConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Creates a project dir with weekpost.config.ts (a plain default export) and the given empty asset files.
  function project(config: unknown, files: string[] = ["assets/fonts/inter-400.woff2", "assets/fonts/inter-800.woff2", "assets/logo.svg"]): string {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-config-"));
    dirs.push(dir);
    writeFileSync(join(dir, "weekpost.config.ts"), `export default ${JSON.stringify(config)} as const;\n`);
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    return dir;
  }

  it("loads and validates weekpost.config.ts from the project dir", async () => {
    const { config, warnings } = await loadConfig(project(valid()));
    expect(config.brand.name).toBe("Horta Viva");
    expect(warnings).toEqual([]);
  });

  it("fails with a clear message when the file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-config-"));
    dirs.push(dir);
    await expect(loadConfig(dir)).rejects.toThrow(`weekpost.config.ts not found in ${dir}`);
  });

  it("fails when the file has no default export", async () => {
    const dir = project(valid());
    writeFileSync(join(dir, "weekpost.config.ts"), "export const config = {};\n");
    await expect(loadConfig(dir)).rejects.toThrow("weekpost.config.ts: export the config as the default export");
  });

  it("reports field errors with the file name", async () => {
    const bad = valid();
    bad.accounts.b.timeZone = "America/Sao_Paul";
    await expect(loadConfig(project(bad))).rejects.toThrow(
      "weekpost.config.ts is invalid:\n  accounts.b.timeZone: America/Sao_Paul is not an IANA time zone (e.g. America/Sao_Paulo)",
    );
  });

  it("fails when a font file does not exist", async () => {
    const dir = project(valid(), ["assets/fonts/inter-400.woff2", "assets/logo.svg"]);
    await expect(loadConfig(dir)).rejects.toThrow("brand.font.files.800: file not found: assets/fonts/inter-800.woff2");
  });

  it("fails when the logo file does not exist", async () => {
    const dir = project(valid(), ["assets/fonts/inter-400.woff2", "assets/fonts/inter-800.woff2"]);
    await expect(loadConfig(dir)).rejects.toThrow("brand.logo.file: file not found: assets/logo.svg");
  });
});
