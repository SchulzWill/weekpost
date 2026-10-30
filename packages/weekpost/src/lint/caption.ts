// The caption as published: caption + CTA + illustrative-images notice + plugin suffixes.
import type { WeekpostConfig } from "../config/schema.ts";
import type { Post } from "../content/post.ts";

// Closing notices by primary language subtag; other languages use English.
const NOTICES: Record<string, { illustrative: string; realFirst: string }> = {
  en: { illustrative: "Illustrative images.", realFirst: "The first image is real. The others are illustrative." },
  pt: { illustrative: "Imagens ilustrativas.", realFirst: "A primeira imagem é real. As outras são ilustrativas." },
};

export const primaryLang = (lang: string) => lang.split("-")[0].toLowerCase();

export function illustrativeNotice(lang: string, realFirst: boolean): string {
  const n = NOTICES[primaryLang(lang)] ?? NOTICES.en;
  return realFirst ? n.realFirst : n.illustrative;
}

const hasRealFirst = (post: Post) => post.type === "reel" && post.reel.segments[0]?.image_file !== undefined;

// Stories have no caption on Instagram, so they get no notice. The link never goes here (bio and Stories only).
export function captionFor(post: Post, account: string, config: WeekpostConfig): string {
  const text = `${post.caption[account] ?? ""}\n\n${post.cta[account] ?? ""}`.trim();
  if (post.type === "story") return text;
  const parts = [text, illustrativeNotice(config.accounts[account].lang, hasRealFirst(post))];
  for (const plugin of config.lint.plugins) {
    const suffix = plugin.captionSuffix?.(post, account, { config });
    if (suffix) parts.push(suffix);
  }
  return parts.join("\n\n");
}
