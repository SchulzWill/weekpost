// Per-account text lint: the core rules plus the config's plugins. Errors block; warnings go to the preview.
import type { WeekpostConfig } from "../config/schema.ts";
import { textFields, type Issue, type Post } from "../content/post.ts";
import { nextSeason, seasonFor, type Season } from "../content/season.ts";
import { captionFor, primaryLang } from "./caption.ts";
import { guarded } from "./plugin.ts";

// Instagram: caption "Maximum 2200 characters, 30 hashtags, and 20 @ tags".
// Source: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media (checked 2026-10-30)
// An error, not a warning: the API call would fail.
const CAPTION_MAX = 2200;
const HASHTAGS_MAX = 5;
const TITLE_WARN = 50; // above this the title overflows the 4 lines of the 560 px panel
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole word (\b does not recognize accented letters).
export const word = (w: string) => new RegExp(`(?<![\\p{L}\\d])${escapeRe(w).replace(/ /g, "\\s+")}(?![\\p{L}\\d])`, "iu");

// Season words by primary language. Visible text and hashtags use the account's language; image_prompt uses all of them. `spring` and `fall` are left out of
// English: they mean other things. Other languages are not checked (add a plugin).
const SEASON_WORDS: Record<string, [string, Season][]> = {
  en: [["autumn", "autumn"], ["winter", "winter"], ["summer", "summer"]],
  pt: [["outono", "autumn"], ["inverno", "winter"], ["primavera", "spring"], ["verão", "summer"], ["verao", "summer"]],
};
const toRegexes = (entries: [string, Season][]) => entries.map(([w, season]) => ({ re: word(w), season }));
const seasonRegexes = (lang: string) => toRegexes(SEASON_WORDS[primaryLang(lang)] ?? []);
// Image prompts are often written in another language than the account's, so they use every known dictionary.
const allSeasonRegexes = toRegexes(Object.values(SEASON_WORDS).flat());

function imagePrompts(post: Post): { path: string; prompt: string }[] {
  if (post.type === "carousel") return post.slides.map((s, i) => ({ path: `slides[${i}].image_prompt`, prompt: s.image_prompt }));
  if (post.type === "reel") return post.reel.segments.flatMap((s, i) => (s.image_prompt ? [{ path: `reel.segments[${i}].image_prompt`, prompt: s.image_prompt }] : []));
  return post.story.image_prompt ? [{ path: "story.image_prompt", prompt: post.story.image_prompt }] : [];
}

export function lintPost(post: Post, config: WeekpostConfig): Issue[] {
  const issues: Issue[] = [];
  const add = (level: Issue["level"], acc: string, path: string, message: string) =>
    issues.push({ level, where: `${post.id} ${acc} ${path}`, message });

  // A season word outside the current and the next season of an account. Without `season` the season check cannot see it.
  if (!post.season) {
    const fields = [
      ...textFields(post).filter((f) => f.path !== "link").flatMap(({ path, text }) => post.accounts.map((acc) => ({ accounts: [acc], path, text: text[acc] ?? "", anyLang: false }))),
      ...imagePrompts(post).map(({ path, prompt }) => ({ accounts: post.accounts, path, text: prompt, anyLang: true })),
    ];
    for (const f of fields) {
      const hit = f.accounts.flatMap((acc) => {
        const { lang, hemisphere } = config.accounts[acc];
        const now = seasonFor(post.date, hemisphere);
        return (f.anyLang ? allSeasonRegexes : seasonRegexes(lang))
          .filter(({ re, season }) => re.test(f.text) && season !== now && season !== nextSeason(now))
          .map(({ season }) => ({ acc, season, now }));
      })[0];
      if (hit) {
        add("warn", hit.acc, f.path, `mentions ${hit.season}, but on ${post.date} it is ${hit.now} for ${hit.acc}: declare \`season\` and make one post per account`);
        break;
      }
    }
  }

  for (const { path, text } of textFields(post)) {
    if (path === "link") continue;
    for (const acc of post.accounts) {
      const t = text[acc];
      if (!t) continue;
      if ((path === "caption" || path === "cta") && /https?:\/\/|www\./i.test(t)) add("error", acc, path, "link in the caption: put the link in the bio or in Stories");
      if (post.type === "carousel" && /^slides\[\d+\]\.title$/.test(path) && t.length > TITLE_WARN) {
        add("warn", acc, path, `title with ${t.length} characters may overflow 4 lines`);
      }
    }
  }

  for (const acc of post.accounts) {
    // The CTA of carousels and Reels must contain one of the account's words (whole word, case-insensitive).
    const words = config.accounts[acc].cta;
    const cta = post.cta[acc];
    if (words && cta && post.type !== "story" && !words.some((w) => word(w).test(cta))) {
      add("error", acc, "cta", `CTA must contain one of: ${words.map((w) => `"${w}"`).join(", ")}`);
    }
    try {
      const full = captionFor(post, acc, config);
      if (full.length > CAPTION_MAX) add("error", acc, "caption", `published caption (with CTA and notices) has ${full.length} characters; maximum ${CAPTION_MAX}`);
      const tags = full.match(/#[\p{L}\d_]+/gu)?.length ?? 0;
      if (tags > HASHTAGS_MAX) add("error", acc, "caption", `${tags} hashtags; maximum ${HASHTAGS_MAX}`);
    } catch (e) {
      add("error", acc, "caption", `a plugin's captionSuffix failed: ${(e as Error).message}`);
    }
  }

  for (const plugin of config.lint.plugins) {
    issues.push(...guarded(plugin, post.id, () => plugin.lintPost?.(post, { config })).map((i) => ({ ...i, where: i.where || post.id })));
    if (!plugin.lintText) continue;
    for (const { path, text } of textFields(post)) {
      if (path === "link") continue;
      for (const acc of post.accounts) {
        const t = text[acc];
        if (!t) continue;
        const where = `${post.id} ${acc} ${path}`;
        const ctx = { config, account: acc, lang: config.accounts[acc].lang };
        issues.push(...guarded(plugin, where, () => plugin.lintText?.(t, path, ctx)).map((i) => ({ ...i, where: i.where || where })));
      }
    }
  }
  return issues;
}
