import { describe, expect, it } from "vitest";
import { purgeOldMedia } from "./cleanup.ts";
import { FakeDb, FakeMeta, FakeStorage, post, token } from "../../test/publisher-fakes.ts";
import { needsRefresh, refreshTokens } from "./tokens.ts";

const DAY = 86_400_000;

describe("media cleanup", () => {
  it("deletes what was published more than 7 days ago, once, and leaves the recent one", async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    const now = Date.now();
    db.rows = [
      post({ postId: "old", status: "published", media: ["2026-W40/v/main/s1.jpg", "2026-W40/v/main/s2.jpg"], cover: "2026-W40/v/main/cover.jpg" }),
      post({ postId: "new", status: "published", media: ["2026-W41/n/main/s1.jpg"] }),
    ];
    db.rows[0]!.publishedAtMs = now - 8 * DAY;
    db.rows[1]!.publishedAtMs = now - 6 * DAY;
    expect(await purgeOldMedia(db, storage, now, () => {})).toBe(1);
    expect(storage.removed).toEqual(["2026-W40/v/main/s1.jpg", "2026-W40/v/main/s2.jpg", "2026-W40/v/main/cover.jpg"]);
    expect(await purgeOldMedia(db, storage, now, () => {})).toBe(0); // idempotent
    expect(storage.removed).toHaveLength(3);
  });

  it("honors a custom number of days", async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    const now = Date.now();
    db.rows = [post({ postId: "x", status: "published", media: ["2026-W40/a.jpg"] })];
    db.rows[0]!.publishedAtMs = now - 2 * DAY;
    expect(await purgeOldMedia(db, storage, now, () => {}, 1)).toBe(1);
  });

  it("never deletes an external URL or a path outside the bucket format", async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    db.rows = [post({ postId: "x", status: "published", media: ["https://cdn.example/a.jpg", "../x.jpg", "2026-W40/ok.jpg"] })];
    db.rows[0]!.publishedAtMs = Date.now() - 9 * DAY;
    await purgeOldMedia(db, storage, Date.now(), () => {});
    expect(storage.removed).toEqual(["2026-W40/ok.jpg"]);
  });
});

describe("token refresh", () => {
  const now = Date.now();
  const logger = () => { const logs: string[] = []; return { logs, log: (e: string, d: Record<string, unknown>) => logs.push(e + JSON.stringify(d)) }; };

  it("refreshes with under 30 days of validity and over 24 h of age", () => {
    expect(needsRefresh(token("main", { expiresAt: new Date(now + 29 * DAY).toISOString() }), now)).toBe(true);
    expect(needsRefresh(token("main", { expiresAt: new Date(now + 31 * DAY).toISOString() }), now)).toBe(false);
    expect(needsRefresh(token("main", { expiresAt: new Date(now + 10 * DAY).toISOString(), refreshedAt: new Date(now - 3_600_000).toISOString() }), now)).toBe(false);
  });

  it("never refreshes or alerts for a token without expiry, nor refreshes a unified login token", async () => {
    const db = new FakeDb();
    const meta = new FakeMeta();
    db.tokensRows = [
      token("a", { expiresAt: null, login: "unified" }),
      token("b", { expiresAt: new Date(now + 2 * DAY).toISOString(), login: "unified", refreshedAt: new Date(now - 10 * DAY).toISOString() }),
      token("c", { expiresAt: null }),
    ];
    const tokens = new Map((await db.tokens()).map((t) => [t.account, t]));
    const { logs, log } = logger();
    await refreshTokens(tokens, db, meta.graph(), now, log);
    expect(meta.calls).toEqual([]);
    expect(logs.filter((l) => l.startsWith("ERROR_token_expiring")).length).toBe(1); // only "b" has a date and it is close
    expect(needsRefresh(tokens.get("a")!, now)).toBe(false);
    expect(needsRefresh(tokens.get("c")!, now)).toBe(false);
  });

  it("stores the new token and the new expiry (60 days); the old one is gone", async () => {
    const db = new FakeDb();
    const meta = new FakeMeta();
    db.now = () => now;
    db.tokensRows = [token("main", { expiresAt: new Date(now + 20 * DAY).toISOString() }), token("second")];
    const tokens = new Map((await db.tokens()).map((t) => [t.account, t]));
    const { logs, log } = logger();
    await refreshTokens(tokens, db, meta.graph(), now, log);
    const saved = db.tokensRows.find((t) => t.account === "main")!;
    expect(saved.accessToken).toBe("IGAAnew-refreshed-token-0987654321");
    expect(Date.parse(saved.expiresAt!)).toBeGreaterThan(now + 59 * DAY);
    expect(tokens.get("main")!.accessToken).toBe(saved.accessToken);
    expect(meta.count(/refresh_access_token/)).toBe(1); // only "main"; "second" has 50 days
    expect(meta.calls.find((c) => c.path === "/refresh_access_token")!.params.grant_type).toBe("ig_refresh_token");
    expect(logs.join("\n")).not.toContain("IGAAnew");
  });

  it("refresh disabled: never calls Meta, only warns about a token close to expiry", async () => {
    const db = new FakeDb();
    const meta = new FakeMeta();
    db.tokensRows = [token("main", { expiresAt: new Date(now + 3 * DAY).toISOString() })];
    const tokens = new Map((await db.tokens()).map((t) => [t.account, t]));
    const { logs, log } = logger();
    await refreshTokens(tokens, db, meta.graph(), now, log, { refresh: false });
    expect(meta.calls).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("ERROR_token_expiring"))).toBe(true);
  });

  it("a failed refresh is logged and does not throw", async () => {
    const db = new FakeDb();
    const meta = new FakeMeta();
    meta.failNext = { match: /refresh/, body: { error: { message: "token expired", code: 190 } } };
    db.tokensRows = [token("main", { expiresAt: new Date(now + 20 * DAY).toISOString() })];
    const tokens = new Map((await db.tokens()).map((t) => [t.account, t]));
    const { logs, log } = logger();
    await refreshTokens(tokens, db, meta.graph(), now, log);
    expect(logs.some((l) => l.startsWith("ERROR_token_refresh"))).toBe(true);
    expect(tokens.get("main")!.accessToken).toBe(token().accessToken);
  });

  it("someone else refreshed first (optimistic save lost): keeps the stored token", async () => {
    const db = new FakeDb();
    const meta = new FakeMeta();
    db.tokensRows = [token("main", { expiresAt: new Date(now + 20 * DAY).toISOString() })];
    const tokens = new Map((await db.tokens()).map((t) => [t.account, t]));
    db.tokensRows[0]!.refreshedAt = new Date(now - 1000).toISOString(); // changed under our feet
    const { logs, log } = logger();
    await refreshTokens(tokens, db, meta.graph(), now, log);
    expect(logs.some((l) => l.startsWith("token_refresh_lost_race"))).toBe(true);
    expect(tokens.get("main")!.accessToken).toBe(token().accessToken);
  });
});
