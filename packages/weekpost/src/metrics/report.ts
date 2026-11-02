// The weekly Insights issue as markdown. Pure: data in, text out; the whole body is rewritten on every run.
// Four sections: Account (7 days), Posts (last 14 days), Extra numbers (the optional hook), Attention. Attention is the
// part that matters when a number is missing or the queue needs a hand: one line per item, each with the command that
// fixes it. Text that comes from outside (a post's last_error, the hook, Meta's messages) goes through `clean()`.
import type { VersionStatus } from "../setup/graphVersions.ts";
import type { Collected, CollectIssue } from "./collect.ts";
import type { Key, MetricRow, QueueRow, Token } from "../queue/types.ts";

export const ISSUE_LABEL = "metrics";
export const TOKEN_WARN_DAYS = 14;
export const STUCK_MINUTES = 30;
export const OVERDUE_MINUTES = 60;
const DAY = 86_400_000;

/** ISO 8601 week in UTC (`2026-W44`): the Thursday of the week decides the year. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
export const issueTitle = (d: Date) => `weekpost metrics: ${isoWeek(d)}`;

/**
 * One line of plain text that cannot break a table or a list, open a link or mention anyone: whitespace collapses,
 * and backticks, pipes, angle brackets, square brackets and `@` are neutralized.
 */
export function clean(s: string, max = 200): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[`<>]/g, "'")
    .replace(/\|/g, "/")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/@/g, "(at)")
    .trim()
    .slice(0, max);
}

export interface ExtraLine {
  label: string;
  value: string | number;
}

export interface ReportInput {
  now: Date;
  /** What this run collected. */
  collected: Collected;
  failed: QueueRow[];
  /** In `publishing` for longer than STUCK_MINUTES. */
  stuck: Key[];
  /** `scheduled` and due for longer than OVERDUE_MINUTES. */
  overdue: QueueRow[];
  /** Stories to post by hand this week. */
  manual: QueueRow[];
  tokens: Pick<Token, "account" | "expiresAt">[];
  graph: VersionStatus & { version: string };
  /** Rows from the `metrics.extra` hook; `null` when the hook is off. */
  extra: ExtraLine[] | null;
  /** The hook failed or returned something unusable. */
  extraError?: string;
  /** Rows dropped or cut by the limits; one Attention line each. */
  extraWarnings?: string[];
}

const num = (n: number | undefined) => (n === undefined ? "—" : String(n));
const seconds = (ms: number | undefined) => (ms === undefined ? "—" : (ms / 1000).toFixed(1));
const TYPE_LABEL = { carousel: "carousel", reel: "reel", story: "story" } as const;

function accountSection(rows: MetricRow[], accounts: string[]): string[] {
  const at = new Map<string, number>();
  for (const r of rows) if (r.scope === "account") at.set(`${r.account}/${r.metric}`, r.value);
  const lines = [...accounts].sort().map((a) => {
    const v = (m: string) => num(at.get(`${a}/${m}`));
    return `| ${clean(a)} | ${v("reach")} | ${v("views")} | ${v("total_interactions")} | ${v("profile_views")} | ${v("profile_links_taps")} | ${v("website_clicks")} | ${v("followers_count")} |`;
  });
  return [
    "## Account (7 days)",
    "",
    "| Account | Reach | Views | Interactions | Profile views | Contact taps | Link taps | Followers |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...(lines.length ? lines : ["| — | no account with a token | — | — | — | — | — | — |"]),
    "",
    "Contact taps are `profile_links_taps` (address, call, e-mail, SMS); link taps are `website_clicks`, the taps on the link in the profile. `—` means Meta did not return the number.",
    "",
  ];
}

function postsSection(rows: MetricRow[], posts: QueueRow[]): string[] {
  const byKey = new Map(posts.map((p) => [`${p.postId}/${p.account}`, p]));
  const values = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.scope !== "post") continue;
    const k = `${r.postId}/${r.account}`;
    if (!values.has(k)) values.set(k, new Map());
    values.get(k)!.set(r.metric, r.value);
  }
  const lines = [...values.keys()].sort().map((k) => {
    const p = byKey.get(k);
    const v = values.get(k)!;
    const id = clean(p?.postId ?? k.split("/")[0]!);
    const link = p?.permalink && /^https:\/\/[^\s)]+$/.test(p.permalink) ? `[${id}](${p.permalink})` : id;
    return `| ${clean(p?.account ?? k.split("/")[1]!)} | ${link} | ${p ? TYPE_LABEL[p.type] : "—"} | ${num(v.get("reach"))} | ${num(v.get("views"))} | ${num(v.get("saved"))} | ${num(v.get("shares"))} | ${num(v.get("total_interactions"))} | ${num(v.get("profile_visits"))} | ${seconds(v.get("ig_reels_avg_watch_time"))} |`;
  });
  return [
    "## Posts (last 14 days)",
    "",
    "| Account | Post | Type | Reach | Views | Saved | Shares | Interactions | Profile visits | Avg watch (s) |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...(lines.length ? lines : ["| — | no post with metrics this run | — | — | — | — | — | — | — | — |"]),
    "",
    "`—` means Meta does not offer the metric for that post type (profile visits are for carousels, watch time for reels) or did not return it.",
    "",
  ];
}

function extraSection(extra: ExtraLine[] | null, failed: boolean): string[] {
  return [
    "## Extra numbers",
    "",
    ...(failed ? ["The hook failed; see Attention."] : extra === null ? ["Not configured (`metrics.extra` in `weekpost.config.ts`)."] : extra.length ? extra.map((e) => `- ${clean(e.label, 60)}: ${clean(String(e.value), 120)}`) : ["The hook returned no rows."]),
    "",
  ];
}

const where = (i: CollectIssue) => (i.postId ? `\`${clean(i.postId)}/${clean(i.account)}\`` : `account \`${clean(i.account)}\``);

/** The Attention lines, in a fixed order: things that stop publishing first, then tokens, then missing data. */
export function attentionLines(i: ReportInput): string[] {
  const out: string[] = [];
  for (const f of i.failed) {
    out.push(`- **Failed:** \`${clean(f.postId)}/${clean(f.account)}\`: ${clean(f.lastError ?? "no last_error")}. Fix it, then \`npx weekpost reschedule ${clean(f.postId)} --account=${clean(f.account)} --at="YYYY-MM-DD HH:MM" --rearm\`.`);
  }
  for (const s of i.stuck) {
    out.push(`- **In \`publishing\` for over ${STUCK_MINUTES} minutes:** \`${clean(s.postId)}/${clean(s.account)}\`. Check Instagram first, then \`npx weekpost resolve ${clean(s.postId)} --account=${clean(s.account)} --published=<link>\` or \`--not-published\`.`);
  }
  if (i.overdue.length) {
    const ids = i.overdue.slice(0, 5).map((r) => `\`${clean(r.postId)}/${clean(r.account)}\``).join(", ");
    out.push(`- **The queue looks stopped:** ${i.overdue.length} scheduled post(s) are over ${OVERDUE_MINUTES} minutes late (${ids}). The Worker is not running them. Run \`npx weekpost doctor\`.`);
  }
  for (const t of i.tokens) {
    if (t.expiresAt === null) continue;
    const left = Date.parse(t.expiresAt) - i.now.getTime();
    if (left < TOKEN_WARN_DAYS * DAY) {
      out.push(`- **Token of \`${clean(t.account)}\` ${left < 0 ? "has expired" : `expires in ${Math.ceil(left / DAY)} day(s)`}** (${clean(t.expiresAt.slice(0, 10))}). Run \`npx weekpost token ${clean(t.account)}\`.`);
    }
  }
  for (const m of i.collected.issues.filter((x) => x.kind === "no-permission")) {
    out.push(`- **The token for \`${clean(m.account)}\` cannot read Insights**, so \`weekpost metrics\` will have no numbers (posts still publish). Generate it again in Meta's "API setup with Instagram login" with all three permissions (setup step 4, item 5), then run \`npx weekpost token ${clean(m.account)}\`.`);
  }
  for (const m of i.collected.issues.filter((x) => x.kind === "token")) {
    out.push(`- **Meta rejected the token of \`${clean(m.account)}\`:** ${clean(m.detail)}. Run \`npx weekpost token ${clean(m.account)}\`.`);
  }
  for (const m of i.collected.issues.filter((x) => x.kind === "no-token")) {
    out.push(`- **No token for \`${clean(m.account)}\`:** its posts have no metrics. Run \`npx weekpost token ${clean(m.account)}\`.`);
  }
  if (i.graph.level !== "ok") out.push(`- **Graph API version:** ${clean(i.graph.detail)}. Update weekpost, or set \`graphVersion\` in the run options, then run \`npx weekpost doctor\`.`);
  if (i.manual.length) {
    const ids = i.manual.map((r) => `\`${clean(r.postId)}/${clean(r.account)}\``).join(", ");
    out.push(`- **${i.manual.length} Story(ies) to post by hand this week:** ${ids}. See \`npx weekpost status\`.`);
  }
  for (const m of i.collected.issues.filter((x) => x.kind === "rate-limit")) {
    out.push(`- **Meta's rate limit (80002) hit ${where(m)}:** ${clean(m.detail)}. The numbers not read this run come back on the next one.`);
  }
  for (const m of i.collected.issues.filter((x) => x.kind === "no-media-id")) {
    out.push(`- **Published without a media id:** ${where(m)} has no metrics. Check the post on Instagram.`);
  }
  for (const m of i.collected.issues.filter((x) => x.kind === "empty")) {
    out.push(`- **No numbers yet for ${where(m)}:** ${clean(m.detail)}.`);
  }
  for (const m of i.collected.issues.filter((x) => x.kind === "error")) {
    out.push(`- **Could not read Insights for ${where(m)}:** ${clean(m.detail)}.`);
  }
  if (i.extraError) out.push(`- **The \`metrics.extra\` hook failed:** ${clean(i.extraError)}. Check \`metrics.extra\` in \`weekpost.config.ts\`; the rest of this report is unaffected.`);
  for (const w of i.extraWarnings ?? []) out.push(`- **The \`metrics.extra\` hook:** ${clean(w)}.`);
  return out;
}

export function buildReport(i: ReportInput): string {
  const attention = attentionLines(i);
  return [
    `Generated by \`weekpost metrics\` at ${i.now.toISOString()}. Rewritten on every run; do not edit by hand.`,
    "",
    ...accountSection(i.collected.rows, i.collected.accounts),
    ...postsSection(i.collected.rows, i.collected.posts),
    ...extraSection(i.extra, Boolean(i.extraError)),
    "## Attention",
    "",
    ...(attention.length ? attention : [`Nothing pending: no failed or stuck posts, the queue is running, tokens have more than ${TOKEN_WARN_DAYS} days left.`]),
    "",
  ].join("\n");
}
