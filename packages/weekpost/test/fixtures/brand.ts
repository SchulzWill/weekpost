// Test brand: a fictional logo (test/fixtures/logo.svg) and placeholder font files written to a temp project dir.
// The font files are not real fonts, so the browser falls back to sans-serif; the tests do not depend on glyphs.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brandFrom, type Brand } from "../../src/render/brand.ts";
import { parseConfig } from "../../src/config/index.ts";
import type { WeekpostConfigInput } from "../../src/config/index.ts";

export const COLORS = {
  primary: "#2F6B3A", dark: "#173A20", bg: "#F7F4EA", fg: "#141A14",
  muted: "#5B6157", tint: "#E3EFE0", onDark: "#E6F2E3", onDarkMuted: "#C2D8BD",
};

export const FIXTURE_LOGO = join(import.meta.dirname, "logo.svg");

export function testConfig(over: { logo?: WeekpostConfigInput["brand"]["logo"] } = {}): WeekpostConfigInput {
  const account = (lang: string, timeZone: string) => ({
    handle: "hortaviva", lang, timeZone, hemisphere: "north" as const, voice: "george", cta: ["link"], link: { base: "https://hortaviva.example/" },
  });
  return {
    brand: {
      name: "Horta Viva",
      colors: COLORS,
      font: { family: "Test Sans", files: { 400: "assets/fonts/test-400.woff2", 800: "assets/fonts/test-800.woff2" } },
      logo: over.logo ?? { file: "assets/logo.svg", recolor: { primary: "#2F6B3A", fg: "#141A14" } },
    },
    accounts: { a: account("pt-PT", "Europe/Lisbon"), b: account("pt-BR", "America/Sao_Paulo"), en: account("en", "Europe/London") },
    pillars: ["tip"],
  };
}

// Writes the project files a config names and returns the project dir.
export function testProject(files: Record<string, string | Buffer> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "weekpost-brand-"));
  const put = (rel: string, data: string | Buffer) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  };
  copyFileSync(FIXTURE_LOGO, (mkdirSync(join(dir, "assets"), { recursive: true }), join(dir, "assets/logo.svg")));
  put("assets/fonts/test-400.woff2", "not a real font");
  put("assets/fonts/test-800.woff2", "not a real font");
  for (const [rel, data] of Object.entries(files)) put(rel, data);
  return dir;
}

export function testBrand(over: Parameters<typeof testConfig>[0] = {}, files: Record<string, string | Buffer> = {}): Brand {
  const { config } = parseConfig(testConfig(over));
  return brandFrom(config, testProject(files));
}
