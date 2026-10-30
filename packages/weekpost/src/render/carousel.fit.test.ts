import { describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { testBrand } from "../../test/fixtures/brand.ts";
import { carouselSlideHtml, fitCarouselScale, layoutFits, pickScale } from "./carousel.ts";
import { withBrowser } from "./png.ts";
import type { Slide } from "../content/post.ts";

const brand = testBrand();
const IMG = "file:///nao-existe.jpg";
const SIZE = { width: 1080, height: 1350 };

// Measures with the browser itself, bypassing the fitting step, to prove the text really fits.
async function layoutOf(slide: Slide, account: "a" | "b", scale: number, measure: Parameters<Parameters<typeof withBrowser>[0]>[1]) {
  const probe = await measure(carouselSlideHtml(brand, slide, account, { index: 1, total: 8, imageUrl: IMG, scale }), SIZE, () => {
    const body = document.querySelector(".body")!.getBoundingClientRect();
    return { bodyTop: body.top, bodyBottom: body.bottom, lockupBottom: document.querySelector(".lockup")!.getBoundingClientRect().bottom, footTop: document.querySelector(".foot")!.getBoundingClientRect().top };
  });
  return probe;
}

const longest: Slide = {
  kicker: { a: "Ponto 3", b: "Ponto 3" },
  title: { a: "Ervas em vasos bem drenados crescem mais e melhor", b: "Ervas em vasos bem drenados crescem mais fortes" },
  sub: { a: "Passe o dedo na terra do vaso num dia quente. Se estiver seca até o segundo dedo, é hora de regar antes que as folhas murchem e as pontas escureçam no peitoril.", b: "x" },
  tip: { a: "Dica: regue de manhã cedo, junto da base; se a água escorrer pelo fundo, o vaso drena bem, sem encharcar a terra.", b: "x" },
  dark: false,
  image_prompt: "x",
};
const impossible: Slide = {
  ...longest,
  title: { a: "Supercalifragilisticoespialidosamente", b: "x" },
  sub: { a: "palavra ".repeat(120), b: "x" },
};

// Environments without a browser skip the real-Chromium tests (with a warning); they run locally and in generate.
const hasChromium = await chromium.launch().then((b) => b.close()).then(() => true, () => false);
if (!hasChromium) console.warn("carousel.fit.test: Chromium unavailable, skipping the real-browser tests");

describe("pickScale (no browser)", () => {
  it("returns 1 when it already fits and the first scale that fits otherwise", async () => {
    expect(await pickScale(10, async () => true, "x")).toBe(1);
    expect(await pickScale(10, async (k) => k <= 0.8, "x")).toBeCloseTo(0.8, 5);
  });

  it("fails with the id, account and slide when it does not fit even at the floor, having tried the floor", async () => {
    const tried: number[] = [];
    await expect(pickScale(10, async (k) => (tried.push(k), false), "post-x (a) slide 3")).rejects.toThrow(/post-x \(a\) slide 3: the text does not fit/);
    expect(tried[0]).toBe(1);
    expect(tried.at(-1)).toBeCloseTo(52 / 96, 5);
  });

  it("the short-title floor (96 px) is larger than the long-title floor (68 px)", async () => {
    const floorOf = async (len: number) => { let last = 1; await pickScale(len, async (k) => (last = k, false), "x").catch(() => {}); return last; };
    expect(await floorOf(10)).toBeLessThan(await floorOf(40));
  });

  it("layoutFits rejects a block over the lockup, over the footer or beyond the width", () => {
    const ok = { bodyTop: 300, bodyBottom: 900, bodyRight: 500, lockupBottom: 179, footTop: 1200, panelRight: 512, wide: false };
    expect(layoutFits(ok)).toBe(true);
    expect(layoutFits({ ...ok, bodyTop: 150 })).toBe(false);
    expect(layoutFits({ ...ok, bodyBottom: 1250 })).toBe(false);
    expect(layoutFits({ ...ok, wide: true })).toBe(false);
  });
});

describe.skipIf(!hasChromium)("fitCarouselScale with real Chromium", () => {
  it("the longest text fits between lockup and footer after fitting", async () => {
    await withBrowser(async (_render, measure) => {
      const k = await fitCarouselScale(brand, longest, "a", { index: 1, total: 8, imageUrl: IMG }, measure, "longo");
      expect(k).toBeLessThan(1);
      const l = await layoutOf(longest, "a", k, measure);
      expect(l.bodyTop).toBeGreaterThanOrEqual(l.lockupBottom);
      expect(l.bodyBottom).toBeLessThanOrEqual(l.footTop);
    });
  });

  it("fails with the id, account and slide when it does not fit even at the legible minimum", async () => {
    await withBrowser(async (_render, measure) => {
      await expect(fitCarouselScale(brand, impossible, "a", { index: 2, total: 8, imageUrl: IMG }, measure, "post-x (a) slide 3"))
        .rejects.toThrow(/post-x \(a\) slide 3: the text does not fit/);
    });
  });
});
