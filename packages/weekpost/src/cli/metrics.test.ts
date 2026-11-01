import { describe, expect, it } from "vitest";
import type { MetricRow, MetricsDb, QueueRow, Token } from "../queue/types.ts";
import { runMetrics, type MetricsDeps } from "./metrics.ts";

const TOKEN = "IGAAtoken-secret-1234567890abcdef";
const GH = "ghs_actionsTokenValue1234567890";
const NOW = new Date("2026-11-02T08:17:00Z");

const published = (): QueueRow => ({
  postId: "2026-10-27-a", account: "en", type: "reel", week: "2026-W44", publishAt: "2026-10-27T12:00:00Z", caption: "c", media: ["a.mp4"],
  cover: null, link: null, contentHash: null, status: "published", attempts: 1, nextAttemptAt: null, claimedAt: null, containerId: null,
  mediaId: "m-fake-1", permalink: "https://www.instagram.com/reel/abc/", lastError: null, publishedAt: "2026-10-27T12:01:00Z", mediaPurgedAt: null, rescheduledAt: null,
});

function fakeDb(over: Partial<MetricsDb> = {}) {
  const written: MetricRow[] = [];
  const asked: Record<string, string[]> = {};
  const rec = (name: string, ...a: string[]) => { asked[name] = a; };
  const db: MetricsDb = {
    tokens: async (): Promise<Token[]> => [{ account: "en", igUserId: "9001", accessToken: TOKEN, expiresAt: "2027-01-01T00:00:00Z", refreshedAt: "2026-10-01T00:00:00Z" }],
    stuck: async (o) => { rec("stuck", o); return []; },
    publishedSince: async () => [published()],
    metricsSince: async () => [],
    upsertMetrics: async (rows) => { written.push(...rows); },
    failed: async () => [],
    overdue: async (b) => { rec("overdue", b); return []; },
    manualDue: async (a, b) => { rec("manualDue", a, b); return []; },
    ...over,
  };
  return { db, written, asked };
}

type Issue = { number: number; title: string; body: string; labels: string[]; pull_request?: unknown };
function world() {
  const issues: Issue[] = [];
  const calls: { method: string; url: string; auth: string | null; body: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, url: url.href, auth, body: String(init?.body ?? "") });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.hostname === "graph.instagram.com") {
      if (url.pathname.endsWith("/9001/insights")) return json({ data: [{ name: "reach", period: "day", total_value: { value: 37 } }] });
      if (url.pathname.endsWith("/9001")) return json({ followers_count: 19 });
      return json({ data: [{ name: "reach", period: "lifetime", values: [{ value: 29 }] }, { name: "views", period: "lifetime", values: [{ value: 37 }] }] });
    }
    if (url.hostname === "api.github.com") {
      if (method === "GET") return json(issues);
      if (method === "POST") {
        const b = JSON.parse(String(init!.body));
        issues.push({ number: issues.length + 1, title: b.title, body: b.body, labels: b.labels });
        return json({ number: issues.length, html_url: `https://github.com/o/r/issues/${issues.length}` }, 201);
      }
      if (method === "PATCH") {
        const n = Number(url.pathname.split("/").pop());
        issues.find((i) => i.number === n)!.body = JSON.parse(String(init!.body)).body;
        return json({ number: n, html_url: `https://github.com/o/r/issues/${n}` });
      }
    }
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;
  return { issues, calls, fetchFn };
}

function run(args: string[], deps: MetricsDeps) {
  const lines: string[] = [];
  const errs: string[] = [];
  return runMetrics(args, { log: (l: string) => lines.push(l), error: (l: string) => errs.push(l) } as never, "/nope", { now: () => NOW, tty: false, home: "/nope", env: { WEEKPOST_SUPABASE_URL: "https://x.supabase.co", WEEKPOST_SUPABASE_KEY: "sb_secret_x" }, ...deps })
    .then((code) => ({ code, out: lines.join("\n"), err: errs.join("\n") }));
}

describe("weekpost metrics", () => {
  it("by default prints the report and writes nothing", async () => {
    const w = world();
    const d = fakeDb();
    const r = await run([], { db: d.db, fetch: w.fetchFn });
    expect(r.code).toBe(0);
    expect(r.out).toContain("## Attention");
    expect(r.out).toContain("[2026-10-27-a](https://www.instagram.com/reel/abc/)");
    expect(d.written).toEqual([]);
    expect(w.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
    expect(r.err).toContain("nothing written");
  });

  it("--write stores the collected rows", async () => {
    const w = world();
    const d = fakeDb();
    const r = await run(["--write"], { db: d.db, fetch: w.fetchFn });
    expect(r.code).toBe(0);
    expect(d.written.map((x) => `${x.scope}:${x.metric}:${x.value}`)).toEqual(["account:reach:37", "account:followers_count:19", "post:reach:29", "post:views:37"]);
    expect(d.written.every((x) => x.collectedOn === "2026-11-02")).toBe(true);
  });

  it("--issue creates the issue once, then updates the same one and never duplicates", async () => {
    const w = world();
    const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: GH, WEEKPOST_SUPABASE_URL: "https://x.supabase.co", WEEKPOST_SUPABASE_KEY: "sb_secret_x" };
    const first = await run(["--issue"], { db: fakeDb().db, fetch: w.fetchFn, env });
    expect(first.err).toContain("issue created: https://github.com/o/r/issues/1");
    const second = await run(["--issue"], { db: fakeDb().db, fetch: w.fetchFn, env });
    expect(second.err).toContain("issue updated");
    expect(w.issues).toHaveLength(1);
    expect(w.issues[0]).toMatchObject({ title: "weekpost metrics: 2026-W45", labels: ["metrics"] });
    expect(w.issues[0]!.body).toContain("## Account (7 days)");
    const list = w.calls.find((c) => c.method === "GET" && c.url.includes("api.github.com"))!;
    expect(list.url).toContain("labels=metrics");
    expect(list.url).not.toContain("/search/");
  });

  it("does not touch a pull request or an issue with another title", async () => {
    const w = world();
    w.issues.push({ number: 7, title: "weekpost metrics: 2026-W45", body: "pr", labels: ["metrics"], pull_request: {} }, { number: 8, title: "weekpost metrics: 2026-W44", body: "old", labels: ["metrics"] });
    const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: GH, WEEKPOST_SUPABASE_URL: "https://x.supabase.co", WEEKPOST_SUPABASE_KEY: "sb_secret_x" };
    await run(["--issue"], { db: fakeDb().db, fetch: w.fetchFn, env });
    expect(w.issues).toHaveLength(3);
    expect(w.issues[0]!.body).toBe("pr");
    expect(w.issues[1]!.body).toBe("old");
  });

  it("never prints the Instagram token or the GitHub token, in text or json", async () => {
    const w = world();
    const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: GH, WEEKPOST_SUPABASE_URL: "https://x.supabase.co", WEEKPOST_SUPABASE_KEY: "sb_secret_x" };
    for (const args of [["--write", "--issue"], ["--json", "--write", "--issue"]]) {
      const r = await run(args, { db: fakeDb().db, fetch: w.fetchFn, env });
      expect(r.out + r.err).not.toContain(TOKEN);
      expect(r.out + r.err).not.toContain(GH);
    }
    expect(w.calls.filter((c) => c.url.includes("graph.instagram.com")).every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN))).toBe(true);
  });

  it("--json prints the rows, the attention lines and the markdown", async () => {
    const w = world();
    const r = await run(["--json"], { db: fakeDb().db, fetch: w.fetchFn });
    const j = JSON.parse(r.out);
    expect(j.title).toBe("weekpost metrics: 2026-W45");
    expect(j.rows).toHaveLength(4);
    expect(j.attention).toEqual([]);
    expect(j.markdown).toContain("## Posts (last 14 days)");
  });

  it("missing data stays exit 0 and shows up under Attention", async () => {
    const w = world();
    const failing = (async (i: RequestInfo | URL, init?: RequestInit) =>
      String(i).includes("graph.instagram.com")
        ? new Response(JSON.stringify({ error: { message: "(#10) Application does not have permission", code: 10 } }), { status: 400 })
        : w.fetchFn(i, init)) as typeof fetch;
    const r = await run([], { db: fakeDb().db, fetch: failing });
    expect(r.code).toBe(0);
    expect(r.out).toContain("cannot read Insights");
    expect(r.out).toContain("all three permissions");
  });

  it("asks the queue with the right thresholds: 30 min stuck, 60 min overdue, Monday-to-Monday Stories", async () => {
    const d = fakeDb();
    await run([], { db: d.db, fetch: world().fetchFn });
    expect(d.asked.stuck).toEqual(["2026-11-02T07:47:00.000Z"]);
    expect(d.asked.overdue).toEqual(["2026-11-02T07:17:00.000Z"]);
    expect(d.asked.manualDue).toEqual(["2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z"]);
  });

  it("a failure of the run itself exits 1 without the token", async () => {
    const d = fakeDb({ failed: async () => { throw new Error(`boom ${TOKEN}`.replace(TOKEN, "x")); } });
    const r = await run([], { db: d.db, fetch: world().fetchFn });
    expect(r.code).toBe(1);
    expect(r.err).toContain("error: boom");
  });

  it("--issue without a token or repository fails clearly, after writing nothing to GitHub", async () => {
    const w = world();
    const r = await run(["--issue"], { db: fakeDb().db, fetch: w.fetchFn });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/owner\/name/);
    expect(w.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
  });

  it("rejects an unknown argument", async () => {
    const r = await run(["--wirte"], { db: fakeDb().db, fetch: world().fetchFn });
    expect(r.code).toBe(2);
  });
});
