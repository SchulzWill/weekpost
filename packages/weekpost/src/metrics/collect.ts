// Collects Instagram Insights for the posts of the last two weeks and for each account. Pure of storage: it takes the
// queue reads and the Graph client, and returns rows plus the problems it met. A problem with one post never stops the
// others; a missing permission, an expired token or a rate limit stops only the account it happened on.
// Which metrics exist for which media type was checked against the live API; Meta rejects the whole request when one
// metric does not fit the media type, so each list below holds only metrics valid for its type.
//   https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
//   https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
import { GraphError, type InstagramGraph } from "../publisher/instagram.ts";
import type { MetricRow, MetricsDb, PostType, QueueRow, Token } from "../queue/types.ts";

/** Reels. `ig_reels_avg_watch_time` is in milliseconds. */
export const REEL_METRICS = ["reach", "views", "saved", "shares", "total_interactions", "likes", "comments", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"];
/** Carousels (the FEED product type). */
export const FEED_METRICS = ["reach", "views", "saved", "shares", "total_interactions", "likes", "comments", "profile_visits", "follows"];
/** Account totals over the window. `website_clicks` is the tap on the link of the profile. */
export const ACCOUNT_METRICS = ["reach", "views", "total_interactions", "profile_links_taps", "profile_views", "website_clicks"];

/**
 * Never requested: Meta removed them (`impressions`, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`,
 * `video_views`) or the endpoint does not know them (`reposts`). Kept as a list so a test can prove no request carries them.
 */
export const NEVER_REQUEST = ["impressions", "plays", "clips_replays_count", "ig_reels_aggregated_all_plays_count", "video_views", "reposts", "link_clicks"];

const DAY = 86_400_000;
export const POST_WINDOW_DAYS = 14;
export const ACCOUNT_WINDOW_DAYS = 7;

export type IssueKind =
  | "no-token" // the account has no token row
  | "no-permission" // the token lacks instagram_business_manage_insights
  | "token" // Meta rejected the token (expired or revoked)
  | "rate-limit" // Meta answered 80002 (or the app-level limit)
  | "no-media-id" // published but the queue holds no media id
  | "empty" // Meta answered without any number
  | "error"; // anything else, with the message

export interface CollectIssue {
  account: string;
  /** Empty for an account-level problem. */
  postId: string;
  kind: IssueKind;
  /** Already free of the token; the report cleans it again before printing. */
  detail: string;
}

export interface Collected {
  rows: MetricRow[];
  issues: CollectIssue[];
  /** Accounts the run looked at, for the report. */
  accounts: string[];
  /** The published posts of the window (Stories left out), for the type and the link of each row. */
  posts: QueueRow[];
}

export function metricsFor(type: PostType): string[] | null {
  if (type === "reel") return REEL_METRICS;
  if (type === "carousel") return FEED_METRICS;
  return null; // Stories are posted by hand and have no media id here
}

/** The kind of problem behind a Graph error. Meta's codes: 190 token, 80002 rate limit, 10 and 200 permission. */
export function classify(e: unknown): { kind: IssueKind; fatal: boolean; detail: string } {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof GraphError) {
    if (e.code === 80002 || e.code === 4) return { kind: "rate-limit", fatal: true, detail };
    if (e.code === 190) return { kind: "token", fatal: true, detail };
    if (e.code === 10 || e.code === 200 || /permission/i.test(detail)) return { kind: "no-permission", fatal: true, detail };
  }
  return { kind: "error", fatal: false, detail };
}

export interface CollectDeps {
  db: Pick<MetricsDb, "tokens" | "publishedSince">;
  graph: Pick<InstagramGraph, "mediaInsights" | "accountInsights" | "followersCount">;
  now: Date;
}

export async function collectMetrics(deps: CollectDeps): Promise<Collected> {
  const { db, graph, now } = deps;
  const day = now.toISOString().slice(0, 10);
  const tokens = new Map<string, Token>((await db.tokens()).map((t) => [t.account, t]));
  const posts = (await db.publishedSince(new Date(now.getTime() - POST_WINDOW_DAYS * DAY).toISOString())).filter((p) => p.type !== "story");
  const rows: MetricRow[] = [];
  const issues: CollectIssue[] = [];

  const accounts = [...new Set([...tokens.keys(), ...posts.map((p) => p.account)])].sort();
  for (const account of accounts) {
    const token = tokens.get(account);
    const mine = posts.filter((p) => p.account === account);
    if (!token) {
      issues.push({ account, postId: "", kind: "no-token", detail: `no token saved for "${account}"` });
      continue;
    }
    const issue = (postId: string, kind: IssueKind, detail: string) => issues.push({ account, postId, kind, detail });
    const add = (scope: MetricRow["scope"], postId: string, values: Record<string, number>) => {
      for (const [metric, value] of Object.entries(values)) if (value >= 0) rows.push({ scope, postId, account, collectedOn: day, metric, value: Math.trunc(value) });
    };

    // The account first: one call for the totals, one for the follower count.
    let stop = false;
    try {
      const until = Math.floor(now.getTime() / 1000);
      const totals = await graph.accountInsights(token.igUserId, token.accessToken, {
        metrics: ACCOUNT_METRICS, sinceSeconds: until - ACCOUNT_WINDOW_DAYS * 86_400, untilSeconds: until,
      });
      if (Object.keys(totals).length === 0) issue("", "empty", "account insights came back without a number");
      add("account", "", totals);
      const followers = await graph.followersCount(token.igUserId, token.accessToken);
      if (followers !== null) add("account", "", { followers_count: followers });
    } catch (e) {
      const c = classify(e);
      issue("", c.kind, c.detail);
      stop = c.fatal;
    }
    if (stop) continue;

    for (const p of mine) {
      if (!p.mediaId) {
        issue(p.postId, "no-media-id", "published without a media id, so there is nothing to read");
        continue;
      }
      try {
        const values = await graph.mediaInsights(p.mediaId, token.accessToken, metricsFor(p.type)!);
        if (Object.keys(values).length === 0) issue(p.postId, "empty", "Insights came back without a number (Meta can take up to 48 hours)");
        add("post", p.postId, values);
      } catch (e) {
        const c = classify(e);
        issue(p.postId, c.kind, c.detail);
        if (c.fatal) break;
      }
    }
  }
  return { rows, issues, accounts, posts };
}

