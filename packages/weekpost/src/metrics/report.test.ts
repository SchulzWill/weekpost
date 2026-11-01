import { describe, expect, it } from "vitest";
import type { QueueRow } from "../queue/types.ts";
import type { CollectIssue } from "./collect.ts";
import { attentionLines, buildReport, clean, isoWeek, issueTitle, type ReportInput } from "./report.ts";

const NOW = new Date("2026-11-02T08:17:00Z");
const post = (over: Partial<QueueRow> = {}): QueueRow => ({
  postId: "2026-10-27-a", account: "en", type: "reel", week: "2026-W44", publishAt: "2026-10-27T12:00:00Z", caption: "c", media: ["a.mp4"],
  cover: null, link: null, contentHash: null, status: "published", attempts: 1, nextAttemptAt: null, claimedAt: null, containerId: null,
  mediaId: "m-1", permalink: "https://www.instagram.com/reel/abc/", lastError: null, publishedAt: "2026-10-27T12:01:00Z", mediaPurgedAt: null, rescheduledAt: null, ...over,
});
const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  now: NOW,
  collected: { rows: [], issues: [], accounts: ["en"], posts: [] },
  failed: [], stuck: [], overdue: [], manual: [],
  tokens: [{ account: "en", expiresAt: "2027-01-01T00:00:00Z" }],
  graph: { version: "v26.0", level: "ok", detail: "v26.0 is the latest version" },
  extra: null,
  ...over,
});
const issue = (kind: CollectIssue["kind"], over: Partial<CollectIssue> = {}): CollectIssue => ({ account: "en", postId: "", kind, detail: "detail", ...over });
const attention = (over: Partial<ReportInput>) => attentionLines(base(over));

describe("isoWeek and the title", () => {
  it("names the week by its Thursday", () => {
    expect(isoWeek(new Date("2026-11-02T08:17:00Z"))).toBe("2026-W45");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(issueTitle(NOW)).toBe("weekpost metrics: 2026-W45");
  });
});

describe("clean", () => {
  it("keeps one line and neutralizes table, code, link and mention syntax", () => {
    const out = clean("a | b\n`c` <img src=x> [link](http://x) @someone");
    expect(out).not.toMatch(/[|`<>[\]@\n]/);
    expect(out).toContain("(at)someone");
  });
  it("caps the length", () => expect(clean("x".repeat(500))).toHaveLength(200));
});

describe("buildReport", () => {
  it("has the four sections in order, and a clean Attention when nothing is wrong", () => {
    const md = buildReport(base());
    const heads = md.split("\n").filter((l) => l.startsWith("## "));
    expect(heads).toEqual(["## Account (7 days)", "## Posts (last 14 days)", "## Extra numbers", "## Attention"]);
    expect(md).toContain("Nothing pending");
    expect(md).toContain("Not configured");
  });

  it("fills the account and post tables from the collected rows", () => {
    const rows = [
      ...["reach", "views", "total_interactions", "profile_views", "profile_links_taps", "website_clicks", "followers_count"].map((metric, i) => ({ scope: "account" as const, postId: "", account: "en", collectedOn: "2026-11-02", metric, value: i + 10 })),
      { scope: "post" as const, postId: "2026-10-27-a", account: "en", collectedOn: "2026-11-02", metric: "reach", value: 29 },
      { scope: "post" as const, postId: "2026-10-27-a", account: "en", collectedOn: "2026-11-02", metric: "ig_reels_avg_watch_time", value: 3916 },
    ];
    const md = buildReport(base({ collected: { rows, issues: [], accounts: ["en"], posts: [post()] } }));
    expect(md).toContain("| en | 10 | 11 | 12 | 13 | 14 | 15 | 16 |");
    expect(md).toContain("| en | [2026-10-27-a](https://www.instagram.com/reel/abc/) | reel | 29 | — | — | — | — | — | 3.9 |");
  });

  it("lists the hook rows, cleaned", () => {
    const md = buildReport(base({ extra: [{ label: "Sign-ups | from IG", value: 12 }] }));
    expect(md).toContain("- Sign-ups / from IG: 12");
  });

  it("does not render a permalink that is not https", () => {
    const rows = [{ scope: "post" as const, postId: "2026-10-27-a", account: "en", collectedOn: "2026-11-02", metric: "reach", value: 1 }];
    const md = buildReport(base({ collected: { rows, issues: [], accounts: ["en"], posts: [post({ permalink: "javascript:alert(1)" })] } }));
    expect(md).not.toContain("javascript:");
  });
});

describe("Attention, one item at a time", () => {
  it("failed post, with last_error cleaned and the command", () => {
    const [l] = attention({ failed: [post({ status: "failed", lastError: "bad `x` | y @bob" })] });
    expect(l).toBe('- **Failed:** `2026-10-27-a/en`: bad \'x\' / y (at)bob. Fix it, then `npx weekpost reschedule 2026-10-27-a --account=en --at="YYYY-MM-DD HH:MM" --rearm`.');
  });
  it("stuck in publishing", () => {
    expect(attention({ stuck: [{ postId: "2026-10-27-a", account: "en" }] })[0]).toBe(
      "- **In `publishing` for over 30 minutes:** `2026-10-27-a/en`. Check Instagram first, then `npx weekpost resolve 2026-10-27-a --account=en --published=<link>` or `--not-published`.",
    );
  });
  it("stopped queue", () => {
    const l = attention({ overdue: [post({ status: "scheduled" })] })[0]!;
    expect(l).toContain("The queue looks stopped");
    expect(l).toContain("1 scheduled post(s)");
    expect(l).toContain("npx weekpost doctor");
  });
  it("token close to expiry or expired, but not a healthy one", () => {
    expect(attention({ tokens: [{ account: "en", expiresAt: "2026-11-10T00:00:00Z" }] })[0]).toContain("expires in 8 day(s)");
    expect(attention({ tokens: [{ account: "en", expiresAt: "2026-10-01T00:00:00Z" }] })[0]).toContain("has expired");
    expect(attention({ tokens: [{ account: "en", expiresAt: "2026-11-20T00:00:00Z" }] })).toEqual([]);
    expect(attention({ tokens: [{ account: "en", expiresAt: "2026-11-15T00:00:00Z" }] })[0]).toContain("npx weekpost token en");
  });
  it("token without the Insights permission", () => {
    const l = attention({ collected: { rows: [], accounts: ["en"], posts: [], issues: [issue("no-permission")] } })[0]!;
    expect(l).toContain("API setup with Instagram login");
    expect(l).toContain("all three permissions");
    expect(l).toContain("npx weekpost token en");
  });
  it("token rejected by Meta and account without a token", () => {
    expect(attention({ collected: { rows: [], accounts: ["en"], posts: [], issues: [issue("token", { detail: "Instagram 190: expired" })] } })[0]).toContain("Meta rejected the token");
    expect(attention({ collected: { rows: [], accounts: ["pt"], posts: [], issues: [issue("no-token", { account: "pt" })] } })[0]).toContain("No token for `pt`");
  });
  it("Graph API close to the end", () => {
    expect(attention({ graph: { version: "v24.0", level: "warn", detail: "v24.0 stops being available on 2028-02-18 (100 days)" } })[0]).toContain("Graph API version");
  });
  it("Stories to post by hand", () => {
    const l = attention({ manual: [post({ postId: "2026-11-03-s", type: "story", status: "manual" })] })[0]!;
    expect(l).toContain("1 Story(ies) to post by hand");
    expect(l).toContain("`2026-11-03-s/en`");
  });
  it("missing data: rate limit, no media id, empty, error", () => {
    const issues = [issue("rate-limit", { detail: "Instagram 80002: limit" }), issue("no-media-id", { postId: "2026-10-27-a" }), issue("empty", { postId: "2026-10-28-b" }), issue("error", { postId: "2026-10-29-c", detail: "boom" })];
    const l = attention({ collected: { rows: [], accounts: ["en"], posts: [], issues } });
    expect(l).toHaveLength(4);
    expect(l[0]).toContain("rate limit (80002)");
    expect(l[1]).toContain("Published without a media id");
    expect(l[2]).toContain("No numbers yet for `2026-10-28-b/en`");
    expect(l[3]).toContain("Could not read Insights for `2026-10-29-c/en`");
  });
  it("hook failure keeps the rest of the report", () => {
    const md = buildReport(base({ extra: [], extraError: "timed out after 30 s" }));
    expect(md).toContain("**The `metrics.extra` hook failed:** timed out after 30 s");
    expect(md).toContain("## Account (7 days)");
  });
});
