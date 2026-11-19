import { describe, expect, it } from "vitest";
import type { OperatorDb, QueueRow, Status } from "../queue/types.ts";
import { runStories } from "./stories.ts";

const GH = "ghs_actionsTokenValue1234567890";
const NOW = new Date("2026-10-26T11:07:00Z");
const ENV = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: GH, GITHUB_ACTIONS: "true" };

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  postId: "2026-10-26-s", account: "en", type: "story", week: "2026-W44", publishAt: "2026-10-26T11:30:00Z", caption: "c", media: ["a.jpg"],
  cover: null, link: "https://example.com/p", contentHash: null, status: "manual", attempts: 0, nextAttemptAt: null, claimedAt: null, containerId: null,
  mediaId: null, permalink: null, lastError: null, publishedAt: null, mediaPurgedAt: null, rescheduledAt: null, publishMode: "manual", fallbackAt: "2026-10-26T12:30:00Z", ...over,
});

const dbOf = (rows: QueueRow[]) => ({
  rows: async (f: { week?: string; status?: Status[] }) => rows.filter((r) => (!f.week || r.week === f.week) && (!f.status || f.status.includes(r.status))),
  manualDue: async (a: string, b: string) => rows.filter((r) => r.status === "manual" && Date.parse(r.publishAt) >= Date.parse(a) && Date.parse(r.publishAt) < Date.parse(b)),
}) as unknown as OperatorDb;

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

  it("only lists manual Stories due within the next hour or still unresolved from the last 24 hours", async () => {
    const rows = [row(), row({ postId: "2026-10-26-late", publishAt: "2026-10-26T12:07:00Z" }), row({ postId: "2026-10-26-past", publishAt: "2026-10-26T11:06:00Z" }), row({ postId: "2026-10-26-sched", status: "scheduled" })];
    const r = await run(["--remind", "--json"], rows);
    expect(JSON.parse(r.out).reminders.map((x: { postId: string }) => x.postId)).toEqual(["2026-10-26-s", "2026-10-26-past"]);
  });

  it("--issue creates one issue with the time, the link and the commands, and creates it only once", async () => {
    const w = world();
    const first = await run(["--remind", "--issue"], [row()], w.fetchFn);
    expect(first.code).toBe(0);
    expect(w.issues).toHaveLength(1);
    const [i] = w.issues;
    expect(i).toMatchObject({ title: TITLE, labels: ["story"] });
    expect(i!.body).toContain("2026-10-26 07:30 America/New_York");
    expect(i!.body).toContain("`https://example.com/p`");
    expect(i!.body).toContain("npx weekpost generate 2026-W44");
    expect(i!.body).toContain("--published=https://www.instagram.com/stories/...");
    expect(i!.body).not.toContain("[=");
    expect(i!.body).toContain("npx weekpost package 2026-W44 --post=2026-10-26-s");
    expect(i!.body).toContain("npx weekpost resolve 2026-10-26-s --account=en --published`");
    expect(i!.body).toContain("npx weekpost resolve 2026-10-26-s --account=en --not-published");
    expect(i!.body).not.toMatch(/fallback|automatic/i);
    expect(first.out).toContain("issue created: https://github.com/o/r/issues/1");

    const second = await run(["--remind", "--issue"], [row()], w.fetchFn);
    expect(w.issues).toHaveLength(1);
    expect(w.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(second.out).toContain("issue exists");
  });

  it("reopens a closed issue when the Story is manual again, without opening a second one", async () => {
    const w = world([open({ state: "closed" })]);
    const r = await run(["--remind", "--issue"], [row()], w.fetchFn);
    expect(w.issues).toHaveLength(1);
    expect(w.issues[0]!.state).toBe("open");
    expect(r.out).toContain("issue reopened");
  });

  it("reminds about a Story that was due up to 24 hours ago, but not older ones", async () => {
    const rows = [row({ postId: "2026-10-25-a", publishAt: "2026-10-25T13:00:00+00:00" }), row({ postId: "2026-10-24-b", publishAt: "2026-10-24T10:00:00Z" })];
    const r = await run(["--remind", "--json"], rows);
    expect(JSON.parse(r.out).reminders.map((x: { postId: string }) => x.postId)).toEqual(["2026-10-25-a"]);
  });

  it("closes the issue of a Story that no longer exists", async () => {
    const w = world([open()]);
    const r = await run(["--remind", "--issue"], [], w.fetchFn);
    expect(w.issues[0]!.state).toBe("closed");
    expect(w.issues[0]!.comments[0]).toBe("The queued Story no longer exists.");
    expect(r.out).toContain("closed #7");
  });

  it("puts the link in code so a mention or a reference in it does nothing", async () => {
    const w = world();
    await run(["--remind", "--issue"], [row({ link: "https://x.test/@user #123`\nhi" })], w.fetchFn);
    expect(w.issues[0]!.body).toContain("`https://x.test/@user #123hi`");
  });

  it("refuses --issue outside the workflow, before touching anything", async () => {
    const w = world();
    for (const env of [{ GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: GH } as Record<string, string>, { GITHUB_REPOSITORY: "o/r", GITHUB_ACTIONS: "true" }]) {
      const r = await run(["--remind", "--issue"], [row()], w.fetchFn, env);
      expect(r.code).toBe(1);
      expect(r.err).toContain("only in the weekpost-stories workflow");
    }
    expect(w.calls).toEqual([]);
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

  it("leaves an issue alone when its title is not ours", async () => {
    const w = world([open({ number: 8, title: "something else" })]);
    await run(["--remind", "--issue"], [], w.fetchFn);
    expect(w.issues.map((i) => i.state)).toEqual(["open"]);
  });

  it("never prints the token, and sends it only as the Authorization header", async () => {
    const w = world();
    const r = await run(["--remind", "--issue", "--json"], [row()], w.fetchFn);
    expect(r.out + r.err).not.toContain(GH);
    expect(w.calls.every((c) => c.auth === `Bearer ${GH}`)).toBe(true);
  });

  it("prints a GitHub error without the token", async () => {
    const failing = (async () => new Response(JSON.stringify({ message: `bad ${GH}` }), { status: 403 })) as typeof fetch;
    const r = await run(["--remind", "--issue"], [row()], failing);
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain(GH);
  });
});
