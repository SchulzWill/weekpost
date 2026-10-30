// "Split" slide 1080x1350: text panel (560 px) on the left, illustrative image on the right (cover).
// Only the elements the slide has end up on the page: no empty box and no leftover text.
import type { Slide } from "../content/post.ts";

type Account = string; // account id from the config
import { esc, type Brand } from "./brand.ts";

export function carouselSlideHtml(brand: Brand, slide: Slide, account: Account, opts: { index: number; total: number; imageUrl: string; scale?: number }): string {
  const { colors: T, fontFaces, fontStack, lockup } = brand;
  const k = opts.scale ?? 1;
  const px = (n: number, min = 0) => Math.max(min, Math.round(n * k));
  const d = slide.dark;
  const text = (t: Slide["title"] | undefined) => (t?.[account] ? esc(t[account]!) : "");
  const title = slide.title[account] ?? "";
  const tip = text(slide.tip);
  return `<!doctype html><html lang="${brand.lang(account)}"><head><meta charset="utf-8"><style>
${fontFaces}
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1350px;overflow:hidden}
body{font-family:${fontStack};display:flex;background:${d ? T.dark : T.bg};-webkit-font-smoothing:antialiased}
/* Safe zone ~1012x1080 (4:5 grid cropped to 1:1): 34 px at the sides, 135 px top and bottom. */
.panel{position:relative;width:560px;height:1350px;padding:220px 48px 220px 74px;display:flex;flex-direction:column;justify-content:center;background:${d ? T.dark : T.bg};color:${d ? "#FFFFFF" : T.fg}}
.lockup{position:absolute;left:74px;top:135px}.lockup svg,.lockup img{height:44px;width:auto;display:block}
.body{display:flex;flex-direction:column;gap:${px(30, 16)}px}
.kicker{font-size:24px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${d ? T.onDarkMuted : T.primary}}
h1{font-size:${px(title.length > 20 ? 68 : 96, MIN_H1_PX)}px;font-weight:800;line-height:1.02;letter-spacing:-.025em;text-wrap:balance}
.sub{font-size:${px(35, MIN_SUB_PX)}px;font-weight:500;line-height:1.28;color:${d ? T.onDark : T.muted}}
.tip{background:${d ? T.onDark : T.tint};color:${T.fg};border-radius:18px;padding:${px(28, 16)}px ${px(30, 18)}px;font-size:${px(29, MIN_TIP_PX)}px;font-weight:600;line-height:1.32}
.foot{position:absolute;left:74px;right:48px;bottom:135px;display:flex;justify-content:space-between;align-items:center;font-size:22px;font-weight:600;color:${d ? T.onDarkMuted : T.muted}}
.foot .bar{width:56px;height:6px;border-radius:3px;background:${d ? T.onDark : T.primary}}
.image{flex:1;height:1350px;background:${T.muted} url("${opts.imageUrl}") center/cover no-repeat}
</style></head><body>
<div class="panel" data-surface="${d ? "dark" : "light"}">
  <div class="lockup">${lockup(d)}</div>
  <div class="body">
    <div class="kicker">${text(slide.kicker)}</div>
    <h1>${text(slide.title)}</h1>
    <p class="sub">${text(slide.sub)}</p>${tip ? `\n    <div class="tip">${tip}</div>` : ""}
  </div>
  <div class="foot"><span class="bar"></span><span>${opts.index + 1}/${opts.total}</span></div>
</div>
<div class="image" role="img" aria-label="Illustrative image"></div>
</body></html>`;
}

// Smallest accepted type size (px): below it the slide is not readable on a phone and the render fails.
export const MIN_H1_PX = 52;
export const MIN_SUB_PX = 28;
export const MIN_TIP_PX = 24;
const SCALE_STEP = 0.04;
// Minimum gap between the text block and the logo/footer.
const CLEARANCE = 24;

// Measured in the page: the text block sits between logo and footer and nothing exceeds the panel width.
function measureLayout() {
  // No nested helpers: the function is serialized into the page and tsx would inject `__name` into it.
  const body = document.querySelector(".body")!.getBoundingClientRect();
  const panelEl = document.querySelector<HTMLElement>(".panel")!;
  const wide = [...document.querySelectorAll<HTMLElement>(".body > *")].some((e) => e.scrollWidth > e.clientWidth);
  return {
    bodyTop: body.top, bodyBottom: body.bottom, bodyRight: body.right,
    lockupBottom: document.querySelector(".lockup")!.getBoundingClientRect().bottom,
    footTop: document.querySelector(".foot")!.getBoundingClientRect().top,
    panelRight: panelEl.getBoundingClientRect().right - parseFloat(getComputedStyle(panelEl).paddingRight), wide,
  };
}
export type CarouselLayout = ReturnType<typeof measureLayout>;
export const layoutFits = (l: CarouselLayout) =>
  l.bodyTop >= l.lockupBottom + CLEARANCE && l.bodyBottom <= l.footTop - CLEARANCE && l.bodyRight <= l.panelRight + 0.5 && !l.wide;

// Scale steps from 1 down to the floor where title, subtitle and tip are all at their minimums; returns the first
// scale `fitsAt` accepts. Pure (the measurement comes from outside): testable without a browser.
export async function pickScale(titleLength: number, fitsAt: (scale: number) => Promise<boolean>, where: string): Promise<number> {
  const h1 = titleLength > 20 ? 68 : 96;
  const floor = Math.min(MIN_H1_PX / h1, MIN_SUB_PX / 35, MIN_TIP_PX / 29);
  for (let k = 1; ; k = Math.max(floor, k - SCALE_STEP)) {
    if (await fitsAt(k)) return k;
    if (k <= floor) {
      throw new Error(`${where}: the text does not fit the panel even at the minimum size (title ${MIN_H1_PX} px, subtitle ${MIN_SUB_PX} px); shorten the text`);
    }
  }
}

// Shrinks the type until the text fits the safe zone, measuring in the browser; if it does not fit at the readable
// minimum, fails with `where`.
export function fitCarouselScale(
  brand: Brand, slide: Slide, account: Account, opts: { index: number; total: number; imageUrl: string },
  measure: <R>(html: string, size: { width: number; height: number }, script: () => R) => Promise<R>, where: string,
): Promise<number> {
  return pickScale(
    (slide.title[account] ?? "").length,
    async (scale) => layoutFits(await measure(carouselSlideHtml(brand, slide, account, { ...opts, scale }), { width: 1080, height: 1350 }, measureLayout)),
    where,
  );
}
