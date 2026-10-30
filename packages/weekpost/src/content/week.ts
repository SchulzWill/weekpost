// Structural validation of a week (already-parsed posts.yaml). Text lint lives in src/lint.
import { z } from "zod";
import type { WeekpostConfig } from "../config/schema.ts";
import { CONTENT_VERSION, MIN_CONTENT_VERSION, buildPostSchema, textFields, type Issue, type Post } from "./post.ts";
import { seasonFor } from "./season.ts";

// ISO 8601 week of a YYYY-MM-DD date (UTC), in the folder format: YYYY-Www.
export function isoWeekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // the Thursday of the same week decides the ISO year
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const formatPath = (path: PropertyKey[]) =>
  path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), "");


function checkPost(post: Post, week: string, config: WeekpostConfig, where: (path: string) => string): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", where: where(path), message });

  if (isoWeekOf(post.date) !== week) err("date", `${post.date} is outside week ${week}`);
  if (!post.id.startsWith(`${post.date}-`)) err("id", `id must start with ${post.date}-`);

  if (post.season) {
    for (const acc of post.accounts) {
      const actual = seasonFor(post.date, config.accounts[acc].hemisphere);
      if (actual !== post.season) err("season", `${post.season} is not the season of ${acc} on ${post.date} (${actual}); make one post per account, each with the season of its hemisphere`);
    }
  }
  for (const acc of post.accounts) if (!post.times[acc]) err("times", `missing time for ${acc}`);
  for (const [acc, time] of Object.entries(post.times)) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) err(`times.${acc}`, "time as HH:MM (local time of the account)");
  }
  for (const { path, text } of textFields(post)) {
    for (const acc of post.accounts) if (!text[acc]) err(path, `missing text for ${acc}`);
  }
  for (const acc of post.accounts) {
    const url = post.link[acc];
    if (!url) continue;
    const base = config.accounts[acc].link.base;
    let query: URLSearchParams | undefined;
    try {
      query = new URL(url).searchParams;
    } catch {
      /* reported below */
    }
    if (!query || !url.startsWith(base) || ![...query.keys()].some((k) => k.startsWith("utm_"))) {
      err(`link.${acc}`, `use ${base}?utm_...`);
    } else {
      // utm_campaign is the account; utm_content is the post.
      const want: Record<string, string> = { utm_source: "instagram", utm_medium: "social", utm_campaign: acc };
      if (post.type === "story") want.utm_content = post.story.link_utm_content;
      for (const [k, v] of Object.entries(want)) if (query.get(k) !== v) err(`link.${acc}`, `use ${k}=${v}`);
      if (!want.utm_content && !query.get("utm_content")) err(`link.${acc}`, "missing utm_content (the post id)");
    }
  }
  if (post.type === "reel") {
    const total = post.reel.segments.reduce((s, x) => s + x.seconds, 0);
    const max = config.reel.maxSeconds;
    if (total > max) err("reel.segments", `Reel with ${total} s; the maximum is ${max} s`);
    for (const acc of post.accounts) if (post.reel.voice && !post.reel.voice[acc]) err("reel.voice", `missing voice for ${acc}`);
  }
  return issues;
}

// `enqueue_accounts` (optional, top-level): accounts the scheduler enqueues; absent = all.
function parseEnqueueAccounts(raw: unknown, week: string, config: WeekpostConfig, issues: Issue[]): string[] | undefined {
  if (raw === undefined) return undefined;
  const where = `${week} enqueue_accounts`;
  const ids = Object.keys(config.accounts);
  const parsed = z.array(z.enum(ids as [string, ...string[]])).min(1, "at least one account").safeParse(raw);
  if (!parsed.success) {
    issues.push({ level: "error", where, message: `list of accounts (${ids.join(", ")}): ${parsed.error.issues[0].message}` });
    return undefined;
  }
  for (const acc of new Set(parsed.data.filter((a, i, all) => all.indexOf(a) !== i))) issues.push({ level: "error", where, message: `repeated account: ${acc}` });
  return parsed.data;
}

// Which contract versions a weekpost reads. `readers[n]` turns the raw content of a version-n week into the
// raw content of version n + 1 (in memory only, a new object); the chain ends at `current`, the shape the rest of
// the code knows. A week is never rewritten on disk: its bytes, and so its content hash, stay as they were.
export type RawWeek = Record<string, unknown>;
export type Contract = { current: number; min: number; readers: Record<number, (raw: RawWeek) => RawWeek> };
export const CONTRACT: Contract = { current: CONTENT_VERSION, min: MIN_CONTENT_VERSION, readers: {} };

// Returns the week in the current shape, or the reason it cannot be read.
export function readAsCurrent(raw: unknown, contract: Contract = CONTRACT): { raw: unknown; error?: string } {
  const { current, min, readers } = contract;
  const version = (raw as { version?: unknown } | null)?.version;
  if (version === undefined) return { raw, error: `\`version\` is missing; add \`version: ${current}\` at the top of posts.yaml` };
  if (typeof version !== "number" || !Number.isInteger(version)) return { raw, error: `\`version\` is ${JSON.stringify(version)}; use a whole number from ${min} to ${current}` };
  if (version > current) return { raw, error: `\`version\` is ${version}, newer than this weekpost reads (up to ${current}); update weekpost` };
  if (version < min) return { raw, error: `\`version\` is ${version}, older than this weekpost reads (from ${min}); read it with an older weekpost and update it there` };
  let cur = raw as RawWeek;
  for (let v = version; v < current; v++) {
    const reader = readers[v];
    if (!reader) return { raw, error: `no reader for version ${v}; this weekpost cannot read it` };
    cur = reader(structuredClone(cur));
  }
  return { raw: cur };
}

export function validateWeek(week: string, raw: unknown, config: WeekpostConfig, contract: Contract = CONTRACT): { posts: Post[]; issues: Issue[]; enqueueAccounts?: string[] } {
  const issues: Issue[] = [];
  const posts: Post[] = [];
  const read = readAsCurrent(raw, contract);
  if (read.error) issues.push({ level: "error", where: `${week} version`, message: read.error });
  else raw = read.raw;
  const list = (raw as { posts?: unknown } | null)?.posts;
  if (!Array.isArray(list)) {
    issues.push({ level: "error", where: week, message: "the file needs a posts: list" });
    return { posts, issues };
  }
  const enqueueAccounts = parseEnqueueAccounts((raw as { enqueue_accounts?: unknown }).enqueue_accounts, week, config, issues);
  const postSchema = buildPostSchema(config);

  const seen = new Set<string>();
  list.forEach((item, index) => {
    const label = typeof (item as { id?: unknown })?.id === "string" ? (item as { id: string }).id : `posts[${index}]`;
    const where = (path: string) => (path ? `${label} ${path}` : label);
    // Keys with undefined values (they do not exist in YAML) do not count as "unknown key".
    const clean = item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)) : item;
    const parsed = postSchema.safeParse(clean);
    if (!parsed.success) {
      for (const e of parsed.error.issues) {
        issues.push({ level: "error", where: where(formatPath(e.path)), message: e.message });
      }
      return;
    }
    if (seen.has(parsed.data.id)) issues.push({ level: "error", where: where("id"), message: "repeated id" });
    seen.add(parsed.data.id);
    issues.push(...checkPost(parsed.data, week, config, where));
    posts.push(parsed.data);
  });
  return { posts, issues, enqueueAccounts };
}
