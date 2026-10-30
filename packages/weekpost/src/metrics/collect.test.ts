import { describe, expect, it } from "vitest";
import { InstagramGraph } from "../publisher/instagram.ts";
import type { MetricsDb, QueueRow, Token } from "../queue/types.ts";
import { ACCOUNT_METRICS, collectMetrics, FEED_METRICS, NEVER_REQUEST, REEL_METRICS } from "./collect.ts";

const TOKEN = "IGAAtoken-secret-1234567890abcdef";
const NOW = new Date("2026-10-30T08:17:00Z");

// Response shapes recorded from the live API (ids and numbers are placeholders).
const insights = (o: Record<string, number>) => ({
  data: Object.entries(o).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }], title: "Contas alcançadas", description: "localized", id: `1/insights/${name}/lifetime` })),
});
const totals = (o: Record<string, number>) => ({
  data: Object.entries(o).map(([name, value]) => ({ name, period: "day", total_value: { value }, title: "t", description: "d", id: `1/insights/${name}/day` })),
});
const error = (message: string, code: number, status = 400) => ({ body: { error: { message, type: "IGApiException", code } }, status });
const ENUM_ERROR = "metric[0] must be one of the following values: impressions, shares, comments, likes, saved, reach";

const row = (over: Partial<QueueRow>): QueueRow => ({
  postId: "2026-10-27-a", account: "en", type: "reel", week: "2026-W44", publishAt: "2026-10-27T12:00:00Z", caption: "c", media: ["a.mp4"],
  cover: null, link: null, contentHash: null, status: "published", attempts: 1, nextAttemptAt: null, claimedAt: null, containerId: null,
  mediaId: "m-fake-1", permalink: null, lastError: null, publishedAt: "2026-10-27T12:01:00Z", mediaPurgedAt: null, rescheduledAt: null, ...over,
});
const token = (account = "en", igUserId = "9001"): Token => ({ account, igUserId, accessToken: TOKEN, expiresAt: "2026-12-20T00:00:00Z", refreshedAt: "2026-10-01T00:00:00Z" });

type Reply = { body: unknown; status?: number };
function world(opts: { posts: QueueRow[]; tokens?: Token[]; reply: (path: string, params: URLSearchParams) => Reply }) {
  const calls: { path: string; params: URLSearchParams; auth: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, params: url.searchParams, auth: new Headers(init?.headers).get("authorization") });
    const r = opts.reply(url.pathname, url.searchParams);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const db: Pick<MetricsDb, "tokens" | "publishedSince"> = { tokens: async () => opts.tokens ?? [token()], publishedSince: async () => opts.posts };
  return { calls, deps: { db, graph: new InstagramGraph(fetchFn), now: NOW } };
}

const happy = (path: string, p: URLSearchParams): Reply => {
  if (path.endsWith("/9001/insights")) return { body: totals({ reach: 37, views: 76, total_interactions: 9, profile_links_taps: 0, profile_views: 4, website_clicks: 0 }) };
  if (path.endsWith("/9001")) return { body: { followers_count: 19, id: "9001" } };
  if (path.endsWith("/insights")) return { body: insights(Object.fromEntries(p.get("metric")!.split(",").map((m, i) => [m, i + 1]))) };
  return error("unknown route", 100, 404);
};

describe("collectMetrics", () => {
  it("asks each media type for its own metrics and never for a retired one", async () => {
    const w = world({ posts: [row({}), row({ postId: "2026-10-26-b", type: "carousel", mediaId: "m-fake-2" })], reply: happy });
    const out = await collectMetrics(w.deps);
    const asked = w.calls.filter((c) => /\/m-fake/.test(c.path)).map((c) => c.params.get("metric")!.split(","));
    expect(asked).toEqual([REEL_METRICS, FEED_METRICS]);
    expect(asked.flat().some((m) => NEVER_REQUEST.includes(m))).toBe(false);
    expect(REEL_METRICS).toContain("ig_reels_avg_watch_time");
    expect(REEL_METRICS).not.toContain("profile_visits");
    expect(FEED_METRICS).toContain("profile_visits");
    expect(FEED_METRICS).not.toContain("ig_reels_avg_watch_time");
    expect(out.issues).toEqual([]);
  });

  it("reads the account over seven days, adds the follower count, and sends the token only in the header", async () => {
    const w = world({ posts: [], reply: happy });
    const out = await collectMetrics(w.deps);
    const acc = w.calls.find((c) => c.path.endsWith("/9001/insights"))!;
    expect(acc.params.get("metric")).toBe(ACCOUNT_METRICS.join(","));
    expect(acc.params.get("metric_type")).toBe("total_value");
    expect(Number(acc.params.get("until")) - Number(acc.params.get("since"))).toBe(7 * 86_400);
    expect(w.calls.every((c) => c.auth === `Bearer ${TOKEN}` && !c.params.has("access_token"))).toBe(true);
    const acct = Object.fromEntries(out.rows.filter((r) => r.scope === "account").map((r) => [r.metric, r.value]));
    expect(acct).toEqual({ reach: 37, views: 76, total_interactions: 9, profile_links_taps: 0, profile_views: 4, website_clicks: 0, followers_count: 19 });
    expect(out.rows.every((r) => r.collectedOn === "2026-10-30")).toBe(true);
  });

  it("stores post rows under the post id with the value Meta returned, ignoring titles", async () => {
    const w = world({
      posts: [row({})],
      reply: (path, p) => (/\/m-fake/.test(path) ? { body: insights({ reach: 29, views: 37, ig_reels_avg_watch_time: 3916 }) } : happy(path, p)),
    });
    const out = await collectMetrics(w.deps);
    expect(out.rows.filter((r) => r.scope === "post")).toEqual([
      { scope: "post", postId: "2026-10-27-a", account: "en", collectedOn: "2026-10-30", metric: "reach", value: 29 },
      { scope: "post", postId: "2026-10-27-a", account: "en", collectedOn: "2026-10-30", metric: "views", value: 37 },
      { scope: "post", postId: "2026-10-27-a", account: "en", collectedOn: "2026-10-30", metric: "ig_reels_avg_watch_time", value: 3916 },
    ]);
  });

  it("an error on one post does not stop the others", async () => {
    const w = world({
      posts: [row({ postId: "2026-10-27-a", mediaId: "m-fake-1" }), row({ postId: "2026-10-28-b", mediaId: "m-fake-2" })],
      reply: (path, p) => (path.includes("m-fake-1") ? error(ENUM_ERROR, 100) : happy(path, p)),
    });
    const out = await collectMetrics(w.deps);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({ postId: "2026-10-27-a", kind: "error" });
    expect(out.rows.some((r) => r.postId === "2026-10-28-b")).toBe(true);
  });

  it("an empty answer is an issue, not a zero", async () => {
    const w = world({ posts: [row({})], reply: (path, p) => (/\/m-fake/.test(path) ? { body: { data: [] } } : happy(path, p)) });
    const out = await collectMetrics(w.deps);
    expect(out.issues).toMatchObject([{ postId: "2026-10-27-a", kind: "empty" }]);
    expect(out.rows.some((r) => r.scope === "post")).toBe(false);
  });

  it("a post without a media id is reported and not requested; Stories are skipped", async () => {
    const w = world({ posts: [row({ mediaId: null }), row({ postId: "2026-10-28-s", type: "story", mediaId: "m-fake-9" })], reply: happy });
    const out = await collectMetrics(w.deps);
    expect(out.issues).toMatchObject([{ postId: "2026-10-27-a", kind: "no-media-id" }]);
    expect(w.calls.some((c) => /\/m-fake/.test(c.path))).toBe(false);
  });

  it("80002 stops the account and keeps what was already read", async () => {
    const w = world({
      posts: [row({ postId: "2026-10-27-a", mediaId: "m-fake-1" }), row({ postId: "2026-10-28-b", mediaId: "m-fake-2" })],
      reply: (path, p) => (path.includes("m-fake-1") ? error("Application request limit reached", 80002) : happy(path, p)),
    });
    const out = await collectMetrics(w.deps);
    expect(out.issues).toMatchObject([{ postId: "2026-10-27-a", kind: "rate-limit" }]);
    expect(w.calls.some((c) => c.path.includes("m-fake-2"))).toBe(false);
    expect(out.rows.some((r) => r.scope === "account")).toBe(true);
  });

  it("a token without the Insights permission degrades to one issue for the account", async () => {
    const w = world({ posts: [row({})], reply: () => error("(#10) Application does not have permission for this action", 10) });
    const out = await collectMetrics(w.deps);
    expect(out.rows).toEqual([]);
    expect(out.issues).toMatchObject([{ account: "en", postId: "", kind: "no-permission" }]);
    expect(w.calls).toHaveLength(1);
  });

  it("an expired token (190) is its own kind and never echoes the token", async () => {
    const w = world({ posts: [], reply: () => error(`Invalid OAuth access token ${TOKEN}`, 190, 401) });
    const out = await collectMetrics(w.deps);
    expect(out.issues[0]!.kind).toBe("token");
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("an account with posts but no token is one issue", async () => {
    const w = world({ posts: [row({ account: "pt" })], tokens: [token("en")], reply: happy });
    const out = await collectMetrics(w.deps);
    expect(out.issues).toMatchObject([{ account: "pt", kind: "no-token" }]);
    expect(out.accounts).toEqual(["en", "pt"]);
  });

  it("one account failing does not stop the next", async () => {
    const w = world({
      posts: [],
      tokens: [token("en", "9001"), token("pt", "9002")],
      reply: (path, p) => (path.includes("/9001") ? error("limit", 80002) : path.endsWith("/9002/insights") ? { body: totals({ reach: 5 }) } : path.endsWith("/9002") ? { body: { followers_count: 3 } } : happy(path, p)),
    });
    const out = await collectMetrics(w.deps);
    expect(out.issues).toMatchObject([{ account: "en", kind: "rate-limit" }]);
    expect(out.rows.filter((r) => r.account === "pt").map((r) => r.metric)).toEqual(["reach", "followers_count"]);
  });
});
