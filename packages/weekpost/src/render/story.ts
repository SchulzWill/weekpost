// Story 1080x1920: logo, optional illustrative image (no label), large text and a free bottom strip for the
// link sticker.
import type { Post } from "../content/post.ts";

type Account = string; // account id from the config
import { esc, type Brand } from "./brand.ts";

type Story = Extract<Post, { type: "story" }>["story"];

export function storyHtml(brand: Brand, story: Story, account: Account, imageUrl?: string): string {
  const { colors: T, fontFaces, fontStack, lockup } = brand;
  return `<!doctype html><html lang="${brand.lang(account)}"><head><meta charset="utf-8"><style>
${fontFaces}
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1920px;overflow:hidden}
body{font-family:${fontStack};background:${T.dark};color:#fff;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;padding:180px 80px 0}
.lockup svg,.lockup img{height:52px;width:auto;display:block}
.photo{position:relative;margin-top:64px;height:760px;border-radius:36px;background:${T.muted} url("${imageUrl ?? ""}") center/cover no-repeat}
p{margin-top:64px;font-size:64px;font-weight:800;line-height:1.08;letter-spacing:-.02em;color:${T.onDark};text-wrap:balance}
/* Link sticker strip: 420 px left free at the bottom (outside the Instagram UI). */
.sticker-zone{margin-top:auto;height:420px}
</style></head><body>
<div class="lockup">${lockup(true)}</div>
${imageUrl ? `<div class="photo" role="img" aria-label="Illustrative image"></div>` : ""}
<p>${esc(story.text[account] ?? "")}</p>
<div class="sticker-zone"></div>
</body></html>`;
}
