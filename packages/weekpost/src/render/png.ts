// HTML to PNG/JPEG (by extension; the Instagram API only accepts JPEG) with Playwright (headless Chromium). One page reused per batch.
import { chromium, type Browser } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type Size = { width: number; height: number };
export type Render = (html: string, out: string, size: Size) => Promise<void>;
// Loads the HTML (no screenshot) and returns what `script` computes in the page: used to measure boxes before rendering.
export type Measure = <R>(html: string, size: Size, script: () => R) => Promise<R>;

export async function withBrowser<T>(fn: (render: Render, measure: Measure) => Promise<T>): Promise<T> {
  const browser: Browser = await chromium.launch();
  try {
    const measure: Measure = async (html, size, script) => {
      const dir = mkdtempSync(join(tmpdir(), "social-measure-"));
      const tmp = join(dir, "m.html");
      writeFileSync(tmp, html);
      const page = await browser.newPage({ viewport: size });
      try {
        await page.goto(pathToFileURL(tmp).href);
        await page.evaluate(() => document.fonts.ready);
        return await page.evaluate(script);
      } finally {
        await page.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    return await fn(async (html, out, size) => {
      mkdirSync(dirname(out), { recursive: true });
      // File next to the output so file:// URLs (fonts, image) resolve; deleted afterwards.
      const tmp = `${out}.html`;
      writeFileSync(tmp, html);
      const page = await browser.newPage({ viewport: size });
      try {
        await page.goto(pathToFileURL(tmp).href);
        await page.evaluate(() => document.fonts.ready);
        const jpeg = /\.jpe?g$/i.test(out);
        await page.screenshot({
          path: out, clip: { x: 0, y: 0, ...size },
          ...(jpeg ? { type: "jpeg" as const, quality: 90 } : { omitBackground: true }),
        });
      } finally {
        await page.close();
        rmSync(tmp, { force: true });
      }
    }, measure);
  } finally {
    await browser.close();
  }
}
