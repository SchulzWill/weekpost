import { describe, expect, it } from "vitest";
import { runCancel } from "../cli/cancel.ts";
import { runReschedule } from "../cli/reschedule.ts";
import { runResolve } from "../cli/resolve.ts";
import { runRestore } from "../cli/restore.ts";
import { runStatus } from "../cli/status.ts";
import type { OperateDeps } from "../cli/queueCommon.ts";
import { formatLocal, parseLocalTime, planCancel, planReschedule, planResolve, planRestore, statusLine, weekOfPostId } from "./operate.ts";
import type { Key, OperatorDb, QueueRow, Status } from "./types.ts";

const NOW = new Date("2026-10-12T10:00:00Z");
const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  postId: "2026-10-14-tip", account: "a", type: "carousel", week: "2026-W42", publishAt: "2026-10-14T08:30:00.000Z", caption: "c", media: ["a.jpg"], cover: null,
  link: null, contentHash: "h", mediaHash: null, status: "scheduled", attempts: 0, nextAttemptAt: null, claimedAt: null, containerId: null, mediaId: null, permalink: null,
  lastError: null, publishedAt: null, mediaPurgedAt: null, rescheduledAt: null, ...over,
});
const zones = { a: "Europe/Lisbon", b: "America/Sao_Paulo" };

function fake(rows: QueueRow[]) {
  const calls: string[] = [];
  const db: OperatorDb = {
    rows: async (f) => rows.filter((r) => (!f.week || r.week === f.week) && (!f.status || f.status.includes(r.status))),
    insert: async () => {},
    updateContent: async () => {},
    cancel: async (k: Key, by) => { calls.push(`cancel ${k.postId}/${k.account} by=${by}`); return rows.find((r) => r.account === k.account)!.status; },
    restore: async (k: Key) => { calls.push(`restore ${k.postId}/${k.account}`); },
    reschedule: async (k, at, o) => { calls.push(`reschedule ${k.postId}/${k.account} ${at} rearm=${o.rearm}`); },
    resolveStuck: async (k, o) => { calls.push(`resolve ${k.postId}/${k.account} ${JSON.stringify(o)}`); },
    upsertToken: async () => {},
  };
  return { db, calls };
}
const cap = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) } };
};
const deps = (db: OperatorDb, over: Partial<OperateDeps> = {}): OperateDeps => ({ db, zones, now: () => NOW, ...over });

describe("pure rules", () => {
  it("derives the week from the post id and refuses ids without a date", () => {
    expect(weekOfPostId("2026-10-14-tip")).toBe("2026-W42");
    expect(() => weekOfPostId("tip")).toThrow(/is not a post id/);
  });
  it("formats the stored instant in the account zone", () => {
    expect(formatLocal("2026-10-14T08:30:00.000Z", "Europe/Lisbon")).toBe("2026-10-14 09:30");
    expect(formatLocal("2026-10-14T08:30:00.000Z", undefined)).toBe("2026-10-14 08:30");
  });
  it("status line carries local time, zone, and the CLI time mark", () => {
    const line = statusLine(row({ rescheduledAt: "2026-10-10T00:00:00Z" }), zones);
    expect(line).toContain("2026-10-14 09:30 Europe/Lisbon");
    expect(line).toContain("time set by the CLI");
  });
  it.each<[Status, boolean]>([["scheduled", true], ["manual", true], ["failed", true], ["publishing", false], ["published", false], ["canceled", false]])("cancel from %s allowed=%s", (status, ok) => {
    expect(planCancel(row({ status })).ok).toBe(ok);
  });
  it("cancel refusals say why", () => {
    expect(planCancel(row({ status: "published", permalink: "https://x/p" }))).toMatchObject({ reason: expect.stringContaining("already published (https://x/p)") });
    expect(planCancel(row({ status: "publishing" }))).toMatchObject({ reason: expect.stringContaining("being published right now") });
  });
  it("parses --at in the account zone and rejects impossible dates", () => {
    expect(parseLocalTime("2026-10-14 09:30", "Europe/Lisbon")).toBe("2026-10-14T08:30:00.000Z");
    expect(() => parseLocalTime("2026-02-30 09:30", "Europe/Lisbon")).toThrow(/real date/);
    expect(() => parseLocalTime("tomorrow", "Europe/Lisbon")).toThrow(/YYYY-MM-DD HH:MM/);
  });
  const at = "2026-10-15T08:30:00.000Z";
  const opts = { rearm: false, zone: "Europe/Lisbon", now: NOW };
  it("reschedule allows scheduled only; failed needs --rearm", () => {
    expect(planReschedule(row(), at, opts).ok).toBe(true);
    expect(planReschedule(row({ status: "failed", attempts: 3 }), at, opts)).toMatchObject({ ok: false, reason: expect.stringContaining("--rearm") });
    expect(planReschedule(row({ status: "failed", attempts: 3 }), at, { ...opts, rearm: true })).toMatchObject({ ok: true, after: expect.stringContaining("attempts reset to 0") });
  });
  it.each<Status>(["publishing", "published", "canceled", "manual"])("reschedule refuses %s", (status) => {
    expect(planReschedule(row({ status }), at, opts)).toMatchObject({ ok: false, reason: expect.stringContaining(`status is ${status}`) });
  });
  it("rearm refuses a row that already has a media id", () => {
    expect(planReschedule(row({ status: "failed", mediaId: "17" }), at, { ...opts, rearm: true })).toMatchObject({ ok: false, reason: expect.stringContaining("media id") });
  });
  it("reschedule refuses a time in the past", () => {
    expect(planReschedule(row(), "2026-10-12T09:00:00.000Z", opts)).toMatchObject({ ok: false, reason: expect.stringContaining("in the past") });
  });
  it("resolve only after 30 minutes of publishing", () => {
    const young = row({ status: "publishing", claimedAt: "2026-10-12T09:45:00Z" });
    const old = row({ status: "publishing", claimedAt: "2026-10-12T09:20:00Z" });
    expect(planResolve(young, { published: false }, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("15 min") });
    expect(planResolve(old, { published: false }, NOW).ok).toBe(true);
    expect(planResolve(row(), { published: false }, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("only a row stuck in publishing") });
    expect(planResolve(old, { published: true, permalink: "not a link" }, NOW).ok).toBe(false);
  });
});

describe("weekpost status", () => {
  it("lists open rows without --week and counts them", async () => {
    const { db } = fake([row(), row({ account: "b", status: "published" }), row({ account: "en", status: "failed", lastError: "boom" })]);
    const { lines, out } = cap();
    expect(await runStatus([], out, ".", deps(db))).toBe(0);
    expect(lines.join("\n")).toContain("2 row(s): 1 scheduled, 1 failed");
    expect(lines.join("\n")).not.toContain("published");
  });
  it("--failed shows only failed rows and --json is parseable with local time", async () => {
    const { db } = fake([row(), row({ account: "en", status: "failed" })]);
    const { lines, out } = cap();
    await runStatus(["--failed", "--json"], out, ".", deps(db));
    const json = JSON.parse(lines.join("\n"));
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ status: "failed", timeZone: "UTC" });
  });
  it("rejects a malformed --week", async () => {
    const { out } = cap();
    expect(await runStatus(["--week=42"], out, ".", deps(fake([]).db))).toBe(2);
  });
});

describe("weekpost cancel", () => {
  it("cancels the cancelable accounts of a post, shows before and after, and reports the refused ones", async () => {
    const { db, calls } = fake([row(), row({ account: "b", status: "published" })]);
    const { lines, out } = cap();
    expect(await runCancel(["2026-10-14-tip", "--yes"], out, ".", deps(db))).toBe(1);
    expect(calls).toEqual(["cancel 2026-10-14-tip/a by=operator"]);
    expect(lines.join("\n")).toMatch(/before: scheduled[\s\S]*after:  canceled/);
    expect(lines.join("\n")).toContain("ERR cannot cancel 2026-10-14-tip/b: it is already published");
  });
  it("--account limits the change", async () => {
    const { db, calls } = fake([row(), row({ account: "b" })]);
    expect(await runCancel(["2026-10-14-tip", "--account=b", "--yes"], cap().out, ".", deps(db))).toBe(0);
    expect(calls).toEqual(["cancel 2026-10-14-tip/b by=operator"]);
  });
  it("asks before changing and does nothing on 'no'", async () => {
    const { db, calls } = fake([row()]);
    expect(await runCancel(["2026-10-14-tip"], cap().out, ".", deps(db, { confirm: async () => false }))).toBe(1);
    expect(calls).toEqual([]);
    expect(await runCancel(["2026-10-14-tip"], cap().out, ".", deps(db, { confirm: async () => true }))).toBe(0);
    expect(calls).toHaveLength(1);
  });
  it("fails clearly when nothing is queued for the post", async () => {
    const { lines, out } = cap();
    expect(await runCancel(["2026-10-14-tip", "--yes"], out, ".", deps(fake([]).db))).toBe(1);
    expect(lines[0]).toContain("no queued row for 2026-10-14-tip");
  });
});

describe("weekpost reschedule", () => {
  it("converts --at to UTC in the account zone and sends rearm", async () => {
    const { db, calls } = fake([row({ status: "failed", attempts: 3 })]);
    const { lines, out } = cap();
    expect(await runReschedule(["2026-10-14-tip", "--account=a", "--at=2026-10-15 09:30", "--rearm", "--yes"], out, ".", deps(db))).toBe(0);
    expect(calls).toEqual(["reschedule 2026-10-14-tip/a 2026-10-15T08:30:00.000Z rearm=true"]);
    expect(lines.join("\n")).toContain("after:  scheduled, 2026-10-15 09:30 Europe/Lisbon, attempts reset to 0");
  });
  it("refuses a published row without writing", async () => {
    const { db, calls } = fake([row({ status: "published" })]);
    const { lines, out } = cap();
    expect(await runReschedule(["2026-10-14-tip", "--account=a", "--at=2026-10-15 09:30", "--yes"], out, ".", deps(db))).toBe(1);
    expect(calls).toEqual([]);
    expect(lines[0]).toContain("status is published");
  });
  it("requires --account and --at, and an account that is in the config", async () => {
    expect(await runReschedule(["2026-10-14-tip"], cap().out, ".", deps(fake([]).db))).toBe(2);
    const { lines, out } = cap();
    expect(await runReschedule(["2026-10-14-tip", "--account=xx", "--at=2026-10-15 09:30", "--yes"], out, ".", deps(fake([]).db))).toBe(1);
    expect(lines[0]).toContain('account "xx" is not in the config');
  });
});

describe("weekpost restore", () => {
  const canceled = (over: Partial<QueueRow> = {}) => row({ status: "canceled", canceledBy: "operator", ...over });
  const FUTURE = { zone: "Europe/Lisbon", now: NOW, allowPast: false };

  it("plans the way back to scheduled, or manual for a Story", () => {
    expect(planRestore(canceled(), FUTURE)).toMatchObject({ ok: true, before: "canceled (by the operator)", after: "scheduled, 2026-10-14 09:30 Europe/Lisbon" });
    expect(planRestore(canceled({ type: "story" }), FUTURE)).toMatchObject({ ok: true, after: expect.stringContaining("manual") });
    expect(planRestore(canceled({ canceledBy: "enqueue" }), FUTURE)).toMatchObject({ ok: true, before: "canceled (by the enqueue)" });
  });
  it.each<Status>(["scheduled", "manual", "failed", "publishing", "published"])("refuses %s: only a canceled post can be restored", (status) => {
    expect(planRestore(row({ status }), FUTURE)).toMatchObject({ ok: false, reason: expect.stringContaining(`status is ${status}`) });
  });
  it("refuses a time in the past unless --allow-past, because the post would go out at once", () => {
    const past = canceled({ publishAt: "2026-10-12T09:00:00.000Z" });
    expect(planRestore(past, FUTURE)).toMatchObject({ ok: false, reason: expect.stringContaining("--allow-past") });
    expect(planRestore(past, { ...FUTURE, allowPast: true })).toMatchObject({ ok: true, after: expect.stringContaining("goes out at the next publisher run") });
    expect(planRestore(canceled({ type: "story", publishAt: "2026-10-12T09:00:00.000Z" }), FUTURE).ok).toBe(true);
  });
  it("restores the post, shows before and after, and asks first", async () => {
    const { db, calls } = fake([canceled()]);
    const { lines, out } = cap();
    expect(await runRestore(["2026-10-14-tip", "--account=a"], out, ".", deps(db, { confirm: async () => false }))).toBe(1);
    expect(calls).toEqual([]);
    expect(await runRestore(["2026-10-14-tip", "--account=a", "--yes"], out, ".", deps(db))).toBe(0);
    expect(calls).toEqual(["restore 2026-10-14-tip/a"]);
    expect(lines.join("\n")).toMatch(/before: canceled \(by the operator\)[\s\S]*after:  scheduled/);
  });
  it("reports the accounts that are not canceled and fails when nothing is queued", async () => {
    const { db, calls } = fake([canceled(), row({ account: "b" })]);
    const { lines, out } = cap();
    expect(await runRestore(["2026-10-14-tip", "--yes"], out, ".", deps(db))).toBe(1);
    expect(calls).toEqual(["restore 2026-10-14-tip/a"]);
    expect(lines.join("\n")).toContain("ERR cannot restore 2026-10-14-tip/b: status is scheduled");
    const none = cap();
    expect(await runRestore(["2026-10-14-tip", "--yes"], none.out, ".", deps(fake([]).db))).toBe(1);
    expect(none.lines[0]).toContain("no queued row for 2026-10-14-tip");
    expect(await runRestore([], cap().out, ".", deps(db))).toBe(2);
  });
  it("status shows who canceled", () => {
    expect(statusLine(canceled(), zones)).toContain("canceled by the operator");
    expect(statusLine(canceled({ canceledBy: null }), zones)).toContain("canceled by the operator");
    expect(statusLine(canceled({ canceledBy: "enqueue" }), zones)).toContain("canceled by the enqueue");
  });
});

describe("weekpost resolve", () => {
  const stuck = row({ status: "publishing", claimedAt: "2026-10-12T09:00:00Z" });
  it("records a published post with its link", async () => {
    const { db, calls } = fake([stuck]);
    expect(await runResolve(["2026-10-14-tip", "--account=a", "--published=https://www.instagram.com/p/abc/", "--yes"], cap().out, ".", deps(db))).toBe(0);
    expect(calls[0]).toContain('"published":true');
  });
  it("sends a not-published post back to the queue", async () => {
    const { db, calls } = fake([stuck]);
    expect(await runResolve(["2026-10-14-tip", "--account=a", "--not-published", "--yes"], cap().out, ".", deps(db))).toBe(0);
    expect(calls[0]).toContain('"published":false');
  });
  it("needs exactly one of --published and --not-published", async () => {
    expect(await runResolve(["2026-10-14-tip", "--account=a", "--yes"], cap().out, ".", deps(fake([stuck]).db))).toBe(2);
    expect(await runResolve(["2026-10-14-tip", "--account=a", "--not-published", "--published=https://x/y"], cap().out, ".", deps(fake([stuck]).db))).toBe(2);
  });
  it("refuses a row that is not stuck", async () => {
    const { db, calls } = fake([row()]);
    expect(await runResolve(["2026-10-14-tip", "--account=a", "--not-published", "--yes"], cap().out, ".", deps(db))).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe("connection", () => {
  it("fails with the variable name when the Supabase env is missing, before any request", async () => {
    const { lines, out } = cap();
    expect(await runStatus([], out, ".", { zones, env: {} })).toBe(1);
    expect(lines[0]).toContain("WEEKPOST_SUPABASE_URL");
  });
});
