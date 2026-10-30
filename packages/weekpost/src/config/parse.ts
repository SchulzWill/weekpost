import { configSchema, type WeekpostConfig } from "./schema.ts";

// All problems at once, one "path: message" line each.
export class ConfigError extends Error {
  constructor(readonly issues: string[], file = "weekpost.config.ts") {
    super(`${file} is invalid:\n${issues.map((i) => `  ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const formatPath = (path: PropertyKey[]) =>
  path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), "") || "(config)";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Validates an already-evaluated config object. Throws ConfigError; warnings (non-fatal) come back with the config.
export function parseConfig(raw: unknown): { config: WeekpostConfig; warnings: string[] } {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((e) => `${formatPath(e.path)}: ${e.message}`));
  const config = parsed.data;
  const warnings: string[] = [];
  const { dark, onDark, onDarkMuted } = config.brand.colors;
  for (const [name, color] of [["onDark", onDark], ["onDarkMuted", onDarkMuted]] as const) {
    const ratio = contrast(color, dark);
    if (ratio < 4.5) warnings.push(`brand.colors.${name}: contrast on brand.colors.dark is ${ratio.toFixed(2)}:1, below 4.5:1`);
  }
  return { config, warnings };
}
