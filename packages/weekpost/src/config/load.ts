import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import { ConfigError, parseConfig } from "./parse.ts";
import type { WeekpostConfig } from "./schema.ts";

export const CONFIG_FILE = "weekpost.config.ts";

// The default export of the config module. How it arrives depends on the Node version and on whether the project
// has "type": "module": as `mod.default`, under `mod["module.exports"].default` (tsx loading the file as CommonJS),
// or wrapped once more as `{ default: { default: config } }` (CommonJS interop on Node 22). Unwraps until the value
// is no longer a bare `{ default }` wrapper.
export function defaultExport(mod: unknown): unknown {
  const m = mod as Record<string, unknown> | undefined;
  if (!m) return undefined;
  let value: unknown;
  if ("module.exports" in m) {
    value = (m["module.exports"] as Record<string, unknown> | undefined)?.default;
  } else {
    const d = m.default as Record<string, unknown> | undefined;
    const named = Object.keys(m).filter((k) => k !== "default");
    // CommonJS interop without "module.exports" (Node 22): `default` is the whole exports object, so the named
    // exports appear both at the top level and inside it, and the real default export is `default.default`.
    const cjsExports = !!d && typeof d === "object" && named.length > 0 && named.every((k) => k in d && d[k] === m[k]);
    value = cjsExports ? d.default : d;
  }
  for (let i = 0; i < 3 && isWrapper(value); i++) value = (value as { default: unknown }).default;
  return value;
}

function isWrapper(v: unknown): boolean {
  if (!v || typeof v !== "object" || !("default" in v)) return false;
  return Object.keys(v).every((k) => k === "default" || k === "__esModule" || k === "module.exports");
}

// Loads <dir>/weekpost.config.ts (TypeScript, via tsx), validates it and checks that the files it names exist.
export async function loadConfig(dir: string): Promise<{ config: WeekpostConfig; warnings: string[] }> {
  const root = resolve(dir);
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`${CONFIG_FILE} not found in ${root}. Create one with \`weekpost init\`.`);

  const mod = await tsImport(file, import.meta.url);
  const exported = defaultExport(mod);
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
