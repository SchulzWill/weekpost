import { describe, expect, it, vi } from "vitest";
import { FakeDb, FakeMeta, FakeStorage, post, token } from "../../test/publisher-fakes.ts";
import { MAINTENANCE_SUBREQUESTS, POST_SUBREQUESTS, resolveOptions, run, type RunDeps } from "./run.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

function setup(rows: ReturnType<typeof post>[] = [], accounts = ["main", "second"]) {
  const db = new FakeDb();
  const meta = new FakeMeta();
  const storage = new FakeStorage();
  db.now = () => NOW;
  db.rows = rows;
  db.tokensRows = accounts.map((a) => token(a, { refreshedAt: new Date(NOW - 10 * DAY).toISOString(), expiresAt: new Date(NOW + 50 * DAY).toISOString() }));
  const logs: string[] = [];
  const deps: RunDeps = { db, storage, graph: meta.graph(), now: () => NOW, sleep: async () => {}, log: (e, d) => logs.push(`${e} ${JSON.stringify(d)}`) };
  return { db, meta, storage, deps, logs };
}

const carousel = (id: string, n = 10) =>
  post({ postId: id, media: Array.from({ length: n }, (_, i) => `2026-W42/${id}/main/slide-${String(i + 1).padStart(2, "0")}.jpg`) });

describe("run", () => {
  it("touches no global clock: with Date.now forbidden it still publishes", async () => {
    const { db, deps } = setup([post({ postId: "a", media: ["2026-W42/a/main/s.jpg"] })]);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Date.now is forbidden in run"); });
    try {
      const out = await run({}, deps);
      expect(out).toEqual({ claimed: 1, outcomes: ["published"] });
    } finally {
      spy.mockRestore();
    }
    expect(db.rows[0]!.status).toBe("published");
  });

  it("refreshTokens: false does not call Meta to renew, only reports", async () => {
    const { db, meta, deps, logs } = setup();
    db.tokensRows[0]!.expiresAt = new Date(NOW + 3 * DAY).toISOString();
    await run({ refreshTokens: false }, deps);
    expect(meta.calls).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("ERROR_token_expiring"))).toBe(true);
  });

  it("renews a token close to expiry by default", async () => {
    const { db, meta, deps } = setup();
    db.tokensRows[0]!.expiresAt = new Date(NOW + 20 * DAY).toISOString();
    await run({}, deps);
    expect(meta.count(/refresh_access_token/)).toBe(1);
  });

  it("an account id outside any fixed list is just a string", async () => {
    const { db, deps } = setup([post({ postId: "a", account: "my-brand_2", media: ["2026-W42/a/s.jpg"] })], ["my-brand_2"]);
    await run({}, deps);
    expect(db.rows[0]!.status).toBe("published");
  });

  it("cleans old media and flags stuck posts in the same run", async () => {
    const { db, storage, deps, logs } = setup([post({ postId: "x", status: "published", media: ["2026-W40/a.jpg"] })]);
    db.rows[0]!.publishedAtMs = NOW - 9 * DAY;
    db.stuckList = [{ postId: "y", account: "main" }];
    await run({}, deps);
    expect(storage.removed).toEqual(["2026-W40/a.jpg"]);
    expect(logs.some((l) => l.startsWith("ERROR_post_stuck_publishing"))).toBe(true);
  });

  it("a maintenance failure is logged and does not undo the publishing", async () => {
    const { db, deps, logs } = setup([post({ postId: "a", media: ["2026-W42/a/s.jpg"] })]);
    db.duePurge = async () => { throw new Error("database down"); };
    const out = await run({}, deps);
    expect(out.outcomes).toEqual(["published"]);
    expect(logs.some((l) => l.startsWith("ERROR_maintenance"))).toBe(true);
  });

  it("a post that throws past markFailed is logged and the next one still goes", async () => {
    const { db, deps, logs } = setup([post({ postId: "a", media: ["2026-W42/a/s.jpg"], publishAtMs: 0 }), post({ postId: "b", media: ["2026-W42/b/s.jpg"], publishAtMs: 1 })]);
    const real = db.markFailed.bind(db);
    db.markFailed = async (k, e, r) => (k.postId === "a" ? Promise.reject(new Error("database down")) : real(k, e, r));
    const meta = deps.graph; void meta;
    // make "a" fail on Meta so that markFailed is reached
    (deps.graph as unknown as { fetchFn: typeof fetch }).fetchFn = (async (u: string) => {
      if (String(u).includes("/media")) return new Response(JSON.stringify({ error: { message: "x", code: 1 } }), { status: 400 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const out = await run({}, deps);
    expect(logs.some((l) => l.startsWith("ERROR_post "))).toBe(true);
    expect(out.claimed).toBe(2);
    expect(db.rows[0]!.status).toBe("publishing");
  });

  it("clamps maxPostsPerRun to 1..10", () => {
    expect(resolveOptions({ maxPostsPerRun: 0 }).maxPostsPerRun).toBe(2);
    expect(resolveOptions({ maxPostsPerRun: 99 }).maxPostsPerRun).toBe(10);
    expect(resolveOptions({ maxPostsPerRun: 3 }).maxPostsPerRun).toBe(3);
  });
});

describe("subrequest budget (Workers Free: 50 per invocation)", () => {
  // Unhappy path of one carousel of 10: Meta answers IN_PROGRESS twice before FINISHED (3 status checks) and the
  // first `markPublished` of each post fails (2 attempts). That is the worst case the budget must price in.
  // Installed before the counters so the failed attempt (still a subrequest in production) is counted too.
  function makeSlow(s: ReturnType<typeof setup>) {
    s.meta.defaultScript = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const real = s.db.markPublished.bind(s.db);
    const failed = new Set<string>();
    s.db.markPublished = async (k, r) => {
      if (!failed.has(k.postId)) {
        failed.add(k.postId);
        throw new Error("transient");
      }
      return real(k, r);
    };
  }

  /** Counts every Meta call and every db/storage call the way the adapter counts `fetch`. */
  function counted(rows: ReturnType<typeof post>[], slowPath = false) {
    const s = setup(rows);
    if (slowPath) makeSlow(s);
    let n = 0;
    const tick = <T extends object>(obj: T, names: (keyof T)[]) => {
      for (const k of names) {
        const f = obj[k] as unknown as (...a: unknown[]) => unknown;
        (obj as Record<keyof T, unknown>)[k] = (...a: unknown[]) => (n++, f.apply(obj, a));
      }
    };
    tick(s.db, ["tokens", "claim", "setContainer", "markPublished", "markFailed", "release", "saveToken", "duePurge", "markPurged", "stuck"]);
    tick(s.storage, ["sign", "remove"]);
    const realFetch = s.meta.fetch;
    s.meta.fetch = (async (...a: Parameters<typeof fetch>) => (n++, realFetch(...a))) as typeof s.meta.fetch;
    s.deps.graph = s.meta.graph();
    s.deps.subrequests = () => n;
    return { ...s, used: () => n };
  }

  it("two carousels of 10 fit in 50 and the third is not claimed", async () => {
    const s = counted([carousel("a"), carousel("b"), carousel("c")].map((p, i) => ({ ...p, publishAtMs: i })));
    const out = await run({ maxPostsPerRun: 3 }, s.deps);
    expect(out.claimed).toBe(2);
    expect(s.db.rows.map((r) => r.status)).toEqual(["published", "published", "scheduled"]);
    expect(s.used()).toBeLessThanOrEqual(50);
    expect(s.logs.some((l) => l.startsWith("ERROR_budget"))).toBe(true);
    expect(s.logs.some((l) => l.startsWith("subrequests"))).toBe(true);
  });

  it("the default of 2 carousels of 10 stays under 50 with a token refresh included", async () => {
    const s = counted([carousel("a"), carousel("b")].map((p, i) => ({ ...p, publishAtMs: i })));
    s.db.tokensRows[0]!.expiresAt = new Date(NOW + 20 * DAY).toISOString();
    const out = await run({}, s.deps);
    expect(out.claimed).toBe(2);
    expect(s.used()).toBeLessThanOrEqual(50);
    expect(s.logs.some((l) => l.startsWith("ERROR_budget"))).toBe(false);
  });

  it("claims nothing when the budget leaves no room", async () => {
    const s = counted([carousel("a")]);
    const out = await run({ subrequestBudget: 20 }, s.deps);
    expect(out.claimed).toBe(0);
    expect(s.db.rows[0]!.status).toBe("scheduled");
    expect(s.logs.some((l) => l.startsWith("ERROR_budget"))).toBe(true);
  });

  it("prices a post at what the code really spends in the worst case", async () => {
    const s = counted([carousel("a")], true);
    await run({ maxPostsPerRun: 1 }, s.deps);
    expect(s.db.rows[0]!.status).toBe("published");
    const fixed = 1 /* tokens */ + 1 /* claim */ + 1 /* duePurge */ + 1 /* stuck */;
    expect(s.used() - fixed).toBe(POST_SUBREQUESTS);
  });

  it("two carousels of 10 on the slow path plus one token renewal stay within 50", async () => {
    const s = counted([carousel("a"), carousel("b")].map((p, i) => ({ ...p, publishAtMs: i })), true);
    s.db.tokensRows[0]!.expiresAt = new Date(NOW + 20 * DAY).toISOString();
    const out = await run({}, s.deps);
    expect(out.claimed).toBe(2);
    expect(s.db.rows.map((r) => r.status)).toEqual(["published", "published"]);
    expect(s.used() + (MAINTENANCE_SUBREQUESTS - 2)).toBeLessThanOrEqual(50); // the test's maintenance is 2 of the 6 reserved
  });

  it("two renewals leave room for one carousel only, and the slow path still stays within 50", async () => {
    const s = counted([carousel("a"), carousel("b")].map((p, i) => ({ ...p, publishAtMs: i })), true);
    for (const t of s.db.tokensRows) t.expiresAt = new Date(NOW + 20 * DAY).toISOString();
    const out = await run({}, s.deps);
    expect(out.claimed).toBe(1);
    expect(s.db.claimLimits).toEqual([1]);
    expect(s.used()).toBeLessThanOrEqual(50);
    expect(s.logs.some((l) => l.startsWith("ERROR_budget"))).toBe(true);
  });
});
