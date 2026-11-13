// Story 1080x1920: logo, optional illustrative image (no label), large text and a bottom strip. By default the
// strip is left free for the link sticker; with `opts.cta` it becomes a card carrying that text (never a URL), kept above the bottom 250 px safe zone
// (Instagram's reply bar) so nothing key sits under the UI.
import type { Post } from "../content/post.ts";

type Account = string; // account id from the config
import { esc, type Brand } from "./brand.ts";

type Story = Extract<Post, { type: "story" }>["story"];

export function storyHtml(brand: Brand, story: Story, account: Account, imageUrl?: string, opts?: { cta?: string }): string {
  const { colors: T, fontFaces, fontStack, lockup } = brand;
  const cta = opts?.cta;
  return `<!doctype html><html lang="${brand.lang(account)}"><head><meta charset="utf-8"><style>
${fontFaces}
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1920px;overflow:hidden}
body{font-family:${fontStack};background:${T.dark};color:#fff;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;padding:180px 80px 0}
.lockup svg,.lockup img{height:52px;width:auto;display:block}
.photo{position:relative;margin-top:64px;height:760px;border-radius:36px;background:${T.muted} url("${imageUrl ?? ""}") center/cover no-repeat}
p{margin-top:64px;font-size:64px;font-weight:800;line-height:1.08;letter-spacing:-.02em;color:${T.onDark};text-wrap:balance}
/* Link sticker strip: 420 px left free at the bottom (outside the Instagram UI). */
${
  cta
    ? `/* CTA card: sits in the upper part of the same 420 px strip, fully above the bottom 250 px that Instagram covers with the reply bar. */
.cta{margin-top:auto;height:170px;margin-bottom:250px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 48px;border-radius:36px;background:${T.primary};color:${T.dark};font-size:56px;font-weight:800;line-height:1.1;letter-spacing:-.01em;text-wrap:balance}`
    : `.sticker-zone{margin-top:auto;height:420px}`
}
</style></head><body>
<div class="lockup">${lockup(true)}</div>
${imageUrl ? `<div class="photo" role="img" aria-label="Illustrative image"></div>` : ""}
<p>${esc(story.text[account] ?? "")}</p>
${cta ? `<div class="cta">${esc(cta)}</div>` : `<div class="sticker-zone"></div>`}
</body></html>`;
}
