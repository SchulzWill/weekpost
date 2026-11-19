import { describe, expect, it } from "vitest";
import type { OperatorDb, QueueRow, Status } from "../queue/types.ts";
import { runStories } from "./stories.ts";

const GH = "ghs_actionsTokenValue1234567890";
const NOW = new Date("2026-10-26T11:07:00Z");
const ENV = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: GH };

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  postId: "2026-10-26-s", account: "en", type: "story", week: "2026-W44", publishAt: "2026-10-26T11:30:00Z", caption: "c", media: ["a.jpg"],
  cover: null, link: "https://example.com/p", contentHash: null, status: "manual", attempts: 0, nextAttemptAt: null, claimedAt: null, containerId: null,
  mediaId: null, permalink: null, lastError: null, publishedAt: null, mediaPurgedAt: null, rescheduledAt: null, publishMode: "manual", fallbackAt: "2026-10-26T12:30:00Z", ...over,
});

const dbOf = (rows: QueueRow[]) => ({ rows: async (f: { week?: string; status?: Status[] }) => rows.filter((r) => (!f.week || r.week === f.week) && (!f.status || f.status.includes(r.status))) }) as unknown as OperatorDb;

type Issue = { number: number; title: string; body: string; state: "open" | "closed"; labels: string[]; comments: string[] };
function world(seed: Issue[] = []) {
  const issues = [...seed];
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (method === "GET") {
      const state = url.searchParams.get("state");
      return json(issues.filter((i) => i.labels.includes(url.searchParams.get("labels")!) && (state === "all" || i.state === state)).map((i) => ({ ...i, html_url: `https://github.com/o/r/issues/${i.number}` })));
    }
    const body = JSON.parse(String(init!.body ?? "{}"));
    if (method === "POST" && url.pathname.endsWith("/issues")) {
      issues.push({ number: issues.length + 1, title: body.title, body: body.body, state: "open", labels: body.labels, comments: [] });
      return json({ number: issues.length, html_url: `https://github.com/o/r/issues/${issues.length}` }, 201);
    }
    const n = Number(url.pathname.split("/").at(-(url.pathname.endsWith("/comments") ? 2 : 1)));
    const issue = issues.find((i) => i.number === n)!;
    if (method === "POST") issue.comments.push(body.body);
    else issue.state = body.state;
    return json({ number: n });
  }) as typeof fetch;
  return { issues, calls, fetchFn };
}

function run(args: string[], rows: QueueRow[], fetchFn: typeof fetch = world().fetchFn, env: Record<string, string> = ENV) {
  const lines: string[] = [];
  const errs: string[] = [];
  return runStories(args, { log: (l: string) => lines.push(l), error: (l: string) => errs.push(l) } as never, "/nope", { db: dbOf(rows), zones: { en: "America/New_York" }, now: () => NOW, env, fetch: fetchFn, tty: false, home: "/nope" })
    .then((code) => ({ code, out: lines.join("\n"), err: errs.join("\n") }));
}

const TITLE = "weekpost story: 2026-10-26-s/en";
const open = (over: Partial<Issue> = {}): Issue => ({ number: 7, title: TITLE, body: "", state: "open", labels: ["story"], comments: [], ...over });

describe("weekpost stories --remind", () => {
  it("needs --remind and knows no other flag", async () => {
    expect((await run([], [])).code).toBe(2);
    expect((await run(["--remind", "--now"], [])).code).toBe(2);
  });

  it("without --issue only prints, touches no GitHub and needs no token", async () => {
    const w = world();
    const r = await run(["--remind"], [row()], w.fetchFn, {});
    expect(r.code).toBe(0);
    expect(r.out).toContain("2026-10-26 07:30 America/New_York  2026-10-26-s/en: post it by hand");
    expect(w.calls).toEqual([]);
    expect(r.err).toContain("nothing written");
  });

  it("only lists manual Stories due in the next hour", async () => {
    const rows = [row(), row({ postId: "2026-10-26-late", publishAt: "2026-10-26T12:07:00Z" }), row({ postId: "2026-10-26-past", publishAt: "2026-10-26T11:06:00Z" }), row({ postId: "2026-10-26-sched", status: "scheduled" })];
    const r = await run(["--remind", "--json"], rows);
    expect(JSON.parse(r.out).reminders.map((x: { postId: string }) => x.postId)).toEqual(["2026-10-26-s"]);
  });

  it("--issue creates one issue with the time, the link and the commands, and creates it only once", async () => {
    const w = world();
    const first = await run(["--remind", "--issue"], [row()], w.fetchFn);
    expect(first.code).toBe(0);
    expect(w.issues).toHaveLength(1);
    const [i] = w.issues;
    expect(i).toMatchObject({ title: TITLE, labels: ["story"] });
    expect(i!.body).toContain("2026-10-26 07:30 America/New_York");
    expect(i!.body).toContain("https://example.com/p");
    expect(i!.body).toContain("npx weekpost package 2026-W44 --post=2026-10-26-s");
    expect(i!.body).toContain("npx weekpost resolve 2026-10-26-s --account=en --published[=<link>]");
    expect(i!.body).toContain("npx weekpost resolve 2026-10-26-s --account=en --not-published");
    expect(i!.body).not.toMatch(/fallback|automatic/i);
    expect(first.out).toContain("issue created: https://github.com/o/r/issues/1");

    const second = await run(["--remind", "--issue"], [row()], w.fetchFn);
    expect(w.issues).toHaveLength(1);
    expect(w.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(second.out).toContain("issue exists");
  });

  it("does not open a second issue when the first one was already closed", async () => {
    const w = world([open({ state: "closed" })]);
    await run(["--remind", "--issue"], [row()], w.fetchFn);
    expect(w.issues).toHaveLength(1);
  });

  it.each<[Status, string]>([["published", "Recorded as published."], ["canceled", "Recorded as canceled"]])("closes the issue when the row is %s", async (status, comment) => {
    const w = world([open()]);
    const r = await run(["--remind", "--issue"], [row({ status, publishAt: "2026-10-26T09:00:00Z" })], w.fetchFn);
    expect(r.code).toBe(0);
    expect(w.issues[0]!.state).toBe("closed");
    expect(w.issues[0]!.comments[0]).toContain(comment);
    expect(r.out).toContain("closed #7");
  });

  it.each<[string, Partial<QueueRow>]>([
    ["publishing", { status: "publishing" }],
    ["scheduled with publishMode manual", { status: "scheduled", publishMode: "manual" }],
    ["failed", { status: "failed" }],
    ["manual", { status: "manual" }],
  ])("keeps the issue open when the row is %s", async (_n, over) => {
    const w = world([open()]);
    await run(["--remind", "--issue"], [row({ publishAt: "2026-10-26T09:00:00Z", ...over })], w.fetchFn);
    expect(w.issues[0]!.state).toBe("open");
    expect(w.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("leaves an issue alone when its row is gone or its title is not ours", async () => {
    const w = world([open(), open({ number: 8, title: "something else" })]);
    await run(["--remind", "--issue"], [], w.fetchFn);
    expect(w.issues.map((i) => i.state)).toEqual(["open", "open"]);
  });

  it("never prints the token, and says what is missing without it", async () => {
    const w = world();
    const r = await run(["--remind", "--issue", "--json"], [row()], w.fetchFn);
    expect(r.out + r.err).not.toContain(GH);
    expect(w.calls.every((c) => c.auth === `Bearer ${GH}`)).toBe(true);
    const bad = await run(["--remind", "--issue"], [row()], w.fetchFn, { GITHUB_REPOSITORY: "o/r" });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("GITHUB_TOKEN is not set");
  });

  it("prints a GitHub error without the token", async () => {
    const failing = (async () => new Response(JSON.stringify({ message: `bad ${GH}` }), { status: 403 })) as typeof fetch;
    const r = await run(["--remind", "--issue"], [row()], failing);
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain(GH);
  });
});
