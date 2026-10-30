// Loads the content weeks (<root>/<YYYY-Www>/posts.yaml) with validation and lint.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { WeekpostConfig } from "../config/schema.ts";
import { lintPost } from "../lint/core.ts";
import { checkRealImages } from "../media/realImage.ts";
import type { Issue, Post } from "./post.ts";
import { validateWeek, type Contract } from "./week.ts";

export const WEEK_DIR = /^\d{4}-W\d{2}$/;

export type Week = { week: string; dir: string; posts: Post[]; enqueueAccounts?: string[] };

// `music` names a file in <project>/assets/music/ (extension omitted) or "none".
function checkMusic(post: Post, projectDir: string): Issue[] {
  if (post.type !== "reel" || !post.reel.music || post.reel.music === "none") return [];
  const name = post.reel.music;
  const dir = join(projectDir, "assets", "music");
  const found = existsSync(dir) && readdirSync(dir).some((f) => f === name || f.replace(/\.[^.]+$/, "") === name);
  return found ? [] : [{ level: "error", where: `${post.id} reel.music`, message: `no file named "${name}" in assets/music/ (add it there, or use "none")` }];
}

// `root` is the content directory; the project directory (assets/, config) is its parent.
export function checkContent(root: string, config: WeekpostConfig, only?: string, contract?: Contract): { weeks: Week[]; issues: Issue[] } {
  const weeks: Week[] = [];
  const issues: Issue[] = [];
  const firstSeen = new Map<string, string>();
  const projectDir = dirname(resolve(root));
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => WEEK_DIR.test(d) && (!only || d === only)).sort() : [];

  for (const week of dirs) {
    const file = join(root, week, "posts.yaml");
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, "utf8"));
    } catch (e) {
      const first = (e as Error).message.split("\n")[0];
      // Most common mistake: text with a comma inside { en: ..., pt: ... } without quotes.
      const hint = /keys must be unique|Flow map/i.test(first) ? ' (hint: quote text that has a comma inside "{ }")' : "";
      issues.push({ level: "error", where: `${week}/posts.yaml`, message: `invalid YAML: ${first}${hint}` });
      continue;
    }
    const result = validateWeek(week, raw, config, contract);
    issues.push(...result.issues);
    for (const post of result.posts) {
      const other = firstSeen.get(post.id);
      if (other && other !== week) issues.push({ level: "error", where: `${post.id} id`, message: `id already used in ${other}` });
      firstSeen.set(post.id, week);
      issues.push(...lintPost(post, config), ...checkMusic(post, projectDir), ...checkRealImages(post, join(root, week)));
    }
    weeks.push({ week, dir: join(root, week), posts: result.posts, enqueueAccounts: result.enqueueAccounts });
  }
  return { weeks, issues };
}
