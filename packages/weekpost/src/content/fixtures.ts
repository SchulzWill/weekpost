// Shared test config: three accounts (north, south, north) like the real-world mix the contract must handle.
import { parseConfig } from "../config/parse.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import type { LintPlugin } from "../lint/plugin.ts";

export function testConfig(over: { plugins?: LintPlugin[]; reelMax?: number; ctaEn?: string[] | null } = {}): WeekpostConfig {
  const account = (lang: string, timeZone: string, hemisphere: "north" | "south", id: string, cta: string[] | null) => ({
    handle: `shop.${id}`, lang, timeZone, hemisphere, voice: "sarah", cta, link: { base: `https://example.com/${id}/` },
  });
  return parseConfig({
    brand: {
      name: "Shop",
      colors: { primary: "#2F6B3A", dark: "#173A20", bg: "#F7F4EA", fg: "#141A14", muted: "#5B6157", tint: "#E3EFE0", onDark: "#E6F2E3", onDarkMuted: "#C2D8BD" },
      font: { family: "Inter", files: { 400: "a.woff2", 800: "b.woff2" } },
      logo: { file: "logo.svg" },
    },
    accounts: {
      a: account("pt-PT", "Europe/Lisbon", "north", "a", ["link na bio"]),
      b: account("pt-BR", "America/Sao_Paulo", "south", "b", ["link na bio"]),
      en: account("en", "Europe/London", "north", "en", over.ctaEn === undefined ? ["link in bio"] : over.ctaEn),
    },
    pillars: ["tip", "seasonal", "myth", "other"],
    reel: { maxSeconds: over.reelMax ?? 20 },
    lint: { plugins: over.plugins ?? [] },
  }).config;
}
