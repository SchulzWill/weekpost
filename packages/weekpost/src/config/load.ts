import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import { ConfigError, parseConfig } from "./parse.ts";
import type { WeekpostConfig } from "./schema.ts";

export const CONFIG_FILE = "weekpost.config.ts";

// Loads <dir>/weekpost.config.ts (TypeScript, via tsx), validates it and checks that the files it names exist.
export async function loadConfig(dir: string): Promise<{ config: WeekpostConfig; warnings: string[] }> {
  const root = resolve(dir);
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`${CONFIG_FILE} not found in ${root}. Create one with \`weekpost init\`.`);

  const mod = await tsImport(file, import.meta.url);
  // In a project without "type": "module" the file loads as CommonJS: tsx then also exposes `module.exports`,
  // and the ESM default export is its `default` key.
  const exported = mod && "module.exports" in mod ? mod["module.exports"]?.default : mod?.default;
  if (exported === undefined) throw new Error(`${CONFIG_FILE}: export the config as the default export (export default defineConfig({ ... }))`);

  const result = parseConfig(exported);
  const { font, logo } = result.config.brand;
  const missing: string[] = [];
  const need = (path: string, rel: string | undefined) => {
    if (rel !== undefined && !existsSync(join(root, rel))) missing.push(`${path}: file not found: ${rel}`);
  };
  for (const [weight, rel] of Object.entries(font.files)) need(`brand.font.files.${weight}`, rel);
  need("brand.logo.file", logo.file);
  need("brand.logo.fileOnDark", logo.fileOnDark);
  if (missing.length) throw new ConfigError(missing);
  return result;
}
