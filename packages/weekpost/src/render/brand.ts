// Brand for the rendered pieces, built from weekpost.config.ts (`brand` and `accounts`).
// Templates take a `Brand` as a parameter; nothing here holds state.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WeekpostConfig } from "../config/index.ts";

export type BrandColors = WeekpostConfig["brand"]["colors"];

export type Brand = {
  name: string;
  colors: BrandColors;
  // CSS `font-family` value: the configured family, quoted, then a generic fallback.
  fontStack: string;
  // One @font-face rule per font file of the config (file:// URLs: pages are rendered from local files).
  fontFaces: string;
  // Logo markup for a light or dark surface: an inline <svg> (recolored when configured) or an <img> for PNG.
  lockup: (dark: boolean) => string;
  // BCP-47 language of an account, for the `lang` attribute.
  lang: (account: string) => string;
};

const FONT_FORMAT: Record<string, string> = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype" };

// A CSS string literal that cannot be closed early from inside.
const cssString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/[\n\r<]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// "#RRGGBB" to "rgba(r,g,b,a)".
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

function readLogo(projectDir: string, field: string, rel: string): Buffer {
  try {
    return readFileSync(join(projectDir, rel));
  } catch {
    throw new Error(`${field}: cannot read ${rel} in ${projectDir}`);
  }
}

const hexRe = (hex: string) => new RegExp(`${hex}(?![0-9a-fA-F])`, "gi");

// Inline SVG: recolored (one pass, so a replacement is never replaced again) and named after the brand.
function svgLogo(source: string, file: string, name: string, swaps: [from: string, to: string, field: string][]): string {
  let svg = source;
  if (swaps.length) {
    for (const [from, , field] of swaps) {
      if (!hexRe(from).test(svg)) throw new Error(`brand.logo.recolor.${field} ${from} is not used in ${file}: use a color that appears in the file`);
    }
    const to = new Map(swaps.map(([from, target]) => [from.toLowerCase(), target]));
    svg = svg.replace(new RegExp(swaps.map(([from]) => `${from}(?![0-9a-fA-F])`).join("|"), "gi"), (m) => to.get(m.toLowerCase())!);
  }
  svg = svg.replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/gi, "").trim();
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) throw new Error(`brand.logo: ${file} has no <svg> element`);
  const tag = open[0].replace(/\s(?:role|aria-label)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "").replace(/^<svg/i, `<svg role="img" aria-label="${esc(name)}"`);
  return svg.replace(open[0], tag);
}

function pngLogo(data: Buffer, name: string): string {
  return `<img src="data:image/png;base64,${data.toString("base64")}" alt="${esc(name)}">`;
}

export function brandFrom(config: Pick<WeekpostConfig, "brand" | "accounts">, projectDir: string): Brand {
  const { name, colors, font, logo } = config.brand;

  const fontFaces = Object.entries(font.files)
    .map(([weight, rel]) => `@font-face{font-family:${cssString(font.family)};font-weight:${weight};src:url(${cssString(pathToFileURL(join(projectDir, rel)).href)}) format("${FONT_FORMAT[extname(rel).toLowerCase()]}")}`)
    .join("");

  const render = (rel: string, field: string, dark: boolean): string => {
    const data = readLogo(projectDir, field, rel);
    if (extname(rel).toLowerCase() === ".png") return pngLogo(data, name);
    const r = logo.recolor;
    const swaps: [string, string, string][] = [];
    // The symbol goes to `onDark` and the wordmark to white on dark surfaces.
    if (r?.primary) swaps.push([r.primary, dark ? colors.onDark : colors.primary, "primary"]);
    if (r?.fg) swaps.push([r.fg, dark ? "#FFFFFF" : colors.fg, "fg"]);
    return svgLogo(data.toString("utf8"), rel, name, swaps);
  };
  // Built once so a bad logo fails here, not halfway through a render.
  const light = render(logo.file, "brand.logo.file", false);
  const dark = logo.fileOnDark ? render(logo.fileOnDark, "brand.logo.fileOnDark", true) : render(logo.file, "brand.logo.file", true);

  return {
    name,
    colors,
    fontStack: `${cssString(font.family)},sans-serif`,
    fontFaces,
    lockup: (onDark) => (onDark ? dark : light),
    lang: (account) => {
      const a = config.accounts[account];
      if (!a) throw new Error(`account "${account}" is not defined in weekpost.config.ts (accounts: ${Object.keys(config.accounts).join(", ")})`);
      return a.lang;
    },
  };
}
