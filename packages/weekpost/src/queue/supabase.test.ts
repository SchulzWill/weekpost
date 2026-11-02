import { describe, expect, it } from "vitest";
import { supabaseStorage } from "./storage.ts";
import { isBucketPath, supabaseDb } from "./supabase.ts";

const SECRET = "sb_secret_abc123";
const LEGACY = "eyJhbGciOiJIUzI1NiJ9.payload.sig";

type Call = { url: string; init: RequestInit };
function mock(handler: (url: string, init: RequestInit) => unknown | Response) {
  const calls: Call[] = [];
  const fetchFn = (async (u: string, init: RequestInit) => {
    calls.push({ url: u, init });
    const out = handler(u, init);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const headers = (c: Call) => c.init.headers as Record<string, string>;
const body = (c: Call) => JSON.parse(String(c.init.body));

const raw = (over: Record<string, unknown> = {}) => ({
  post_id: "2026-10-26-a", account: "en", type: "carousel", week: "2026-W44", publish_at: "2026-10-26T12:00:00Z",
  caption: "hi", media: ["a.jpg", "b.jpg"], cover: null, link: null, content_hash: "h", status: "scheduled", attempts: 0,
  next_attempt_at: null, claimed_at: null, container_id: null, media_id: null, permalink: null, last_error: null,
  published_at: null, media_purged_at: null, rescheduled_at: null, ...over,
});
const K = { postId: "2026-10-26-a", account: "en" };

describe("supabase keys", () => {
  it("sends an sb_secret_ key only in apikey", async () => {
    const { fetchFn, calls } = mock(() => []);
    await supabaseDb("https://x.supabase.co/", SECRET, fetchFn).claim(1);
    expect(headers(calls[0]!).apikey).toBe(SECRET);
    expect(headers(calls[0]!).authorization).toBeUndefined();
  });

  it("sends a legacy JWT key in apikey and Authorization", async () => {
    const { fetchFn, calls } = mock(() => []);
    await supabaseDb("https://x.supabase.co/", LEGACY, fetchFn).claim(1);
    expect(headers(calls[0]!).apikey).toBe(LEGACY);
    expect(headers(calls[0]!).authorization).toBe(`Bearer ${LEGACY}`);
  });

  it("applies the same rules to storage", async () => {
    const { fetchFn, calls } = mock(() => []);
    await supabaseStorage("https://x.supabase.co", SECRET, "media", fetchFn).remove(["a/b.jpg"]);
    await supabaseStorage("https://x.supabase.co", LEGACY, "media", fetchFn).remove(["a/b.jpg"]);
    expect(headers(calls[0]!).authorization).toBeUndefined();
    expect(headers(calls[1]!).authorization).toBe(`Bearer ${LEGACY}`);
  });

  it("fails before any request when the key or the url is missing", () => {
    const { fetchFn, calls } = mock(() => []);
    expect(() => supabaseDb("https://x.supabase.co", "", fetchFn)).toThrow("WEEKPOST_SUPABASE_KEY");
    expect(() => supabaseDb("", SECRET, fetchFn)).toThrow("WEEKPOST_SUPABASE_URL");
    expect(() => supabaseStorage("https://x.supabase.co", "  ", "media", fetchFn)).toThrow("WEEKPOST_SUPABASE_KEY");
    expect(calls).toHaveLength(0);
  });

  it("never puts the key in an error message", async () => {
    const { fetchFn } = mock(() => new Response("denied", { status: 401 }));
    const err = await supabaseDb("https://x.supabase.co", SECRET, fetchFn).claim(1).catch((e: Error) => e);
    expect((err as Error).message).toBe("Supabase POST /rest/v1/rpc/weekpost_claim -> 401: denied");
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe("error messages never carry row values", () => {
  const FRESH = "new-token-value-0001";
  const violation = {
    code: "23514", message: 'new row for relation "weekpost_tokens" violates check constraint "x"',
    details: `Failing row contains (en, 1, ${FRESH}, 2026-12-01, now).`,
  };

  it("drops the body of a failed token write and does not know the new token", async () => {
    const { fetchFn } = mock(() => new Response(JSON.stringify(violation), { status: 400 }));
    const err = await supabaseDb("https://x.supabase.co", SECRET, fetchFn)
      .saveToken("en", "2026-10-01", FRESH, "2026-12-01").catch((e: Error) => e);
    expect((err as Error).message).toBe("Supabase PATCH /rest/v1/weekpost_tokens -> 400");
    expect((err as Error).message).not.toContain(FRESH);
  });

  it("cuts 'Failing row contains (...)' from other errors, keeping the code and the message", async () => {
    const { fetchFn } = mock(() => new Response(JSON.stringify({ ...violation, message: `${violation.message}. Failing row contains (caption with a secret)` }), { status: 400 }));
    const err = await supabaseDb("https://x.supabase.co", SECRET, fetchFn).insert([
      { postId: "a", account: "en", type: "carousel", week: "2026-W44", publishAt: "x", caption: "c", media: [], cover: null, link: null, contentHash: null },
    ] as never).catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain("23514");
    expect(msg).toContain("violates check constraint");
    expect(msg).not.toMatch(/Failing row/);
    expect(msg).not.toContain("caption with a secret");
    expect(msg).not.toContain(FRESH);
  });

  it("a plain-text body with a failing row is cut as well", async () => {
    const { fetchFn } = mock(() => new Response(`boom Failing row contains (${FRESH})`, { status: 400 }));
    const err = await supabaseDb("https://x.supabase.co", SECRET, fetchFn).claim(1).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(FRESH);
  });

  it("a fetch that throws does not repeat the URL in the message", async () => {
    const fetchFn = (async (u: string) => { throw new TypeError(`Failed to parse URL from ${u}`); }) as unknown as typeof fetch;
    const err = await supabaseDb("https://secret-host.example", SECRET, fetchFn).claim(1).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("secret-host");
    expect((err as Error).message).toContain("network error");
  });
});

describe("PublisherDb", () => {
  const db = (handler: Parameters<typeof mock>[0]) => {
    const m = mock(handler);
    return { ...m, db: supabaseDb("https://x.supabase.co", SECRET, m.fetchFn) };
  };

  it("claim calls the RPC and maps rows to camelCase", async () => {
    const { db: d, calls } = db(() => [raw({ status: "publishing", attempts: 1 })]);
    const rows = await d.claim(2);
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/weekpost_claim");
    expect(body(calls[0]!)).toEqual({ p_limit: 2 });
    expect(rows[0]).toMatchObject({ postId: "2026-10-26-a", publishAt: "2026-10-26T12:00:00Z", status: "publishing", attempts: 1, media: ["a.jpg", "b.jpg"] });
  });

  it("markFailed sends the interval and returns the new status", async () => {
    const { db: d, calls } = db(() => "failed");
    expect(await d.markFailed(K, "boom", 600)).toBe("failed");
    expect(body(calls[0]!)).toEqual({ p_post_id: K.postId, p_account: "en", p_error: "boom", p_retry_in: "600 seconds" });
  });

  it("release and markPublished call their RPCs", async () => {
    const { db: d, calls } = db(() => null);
    await d.release(K, "c1", 300);
    await d.markPublished(K, { containerId: "c1", mediaId: "m1", permalink: "https://i.test/p/1" });
    expect(calls[0]!.url).toMatch(/rpc\/weekpost_release$/);
    expect(body(calls[0]!)).toMatchObject({ p_container_id: "c1", p_retry_in: "300 seconds" });
    expect(calls[1]!.url).toMatch(/rpc\/weekpost_mark_published$/);
    expect(body(calls[1]!)).toMatchObject({ p_media_id: "m1", p_permalink: "https://i.test/p/1" });
  });

  it("setContainer only touches a row that is publishing", async () => {
    const { db: d, calls } = db(() => []);
    await d.setContainer(K, "c1");
    expect(calls[0]!.url).toContain("post_id=eq.2026-10-26-a&account=eq.en&status=eq.publishing");
    expect(calls[0]!.init.method).toBe("PATCH");
  });

  it("saveToken is optimistic: true when a row changed, false when someone refreshed first", async () => {
    const won = db(() => [{ account: "en" }]);
    expect(await won.db.saveToken("en", "2026-10-01T00:00:00+00:00", "tok", "2026-12-01T00:00:00Z")).toBe(true);
    expect(won.calls[0]!.url).toContain("refreshed_at=eq.2026-10-01T00%3A00%3A00%2B00%3A00");
    const lost = db(() => []);
    expect(await lost.db.saveToken("en", "x", "tok", "2026-12-01T00:00:00Z")).toBe(false);
  });

  it("tokens maps rows", async () => {
    const { db: d } = db(() => [{ account: "en", ig_user_id: "1", access_token: "t", expires_at: "e", refreshed_at: "r" }]);
    expect(await d.tokens()).toEqual([{ account: "en", igUserId: "1", accessToken: "t", expiresAt: "e", refreshedAt: "r", login: "instagram" }]);
  });

  it("tokens reads the login mode and a null expiry; a missing or unknown mode counts as instagram", async () => {
    const { db: d, calls } = db(() => [
      { account: "en", ig_user_id: "1", access_token: "t", expires_at: null, refreshed_at: "r", login: "unified" },
      { account: "pt", ig_user_id: "2", access_token: "t", expires_at: "e", refreshed_at: "r", login: "instagram" },
      { account: "es", ig_user_id: "3", access_token: "t", expires_at: "e", refreshed_at: "r" },
    ]);
    const rows = await d.tokens();
    expect(calls[0]!.url).toContain("select=account,ig_user_id,access_token,expires_at,refreshed_at,login");
    expect(rows.map((r) => [r.account, r.login, r.expiresAt])).toEqual([["en", "unified", null], ["pt", "instagram", "e"], ["es", "instagram", "e"]]);
  });

  it("duePurge, markPurged and stuck query published and publishing rows", async () => {
    const { db: d, calls } = db((u) => (u.includes("status=eq.publishing&claimed_at") ? [{ post_id: "p", account: "en" }] : [{ post_id: "p", account: "en", media: ["a.jpg"], cover: null }]));
    expect(await d.duePurge("2026-10-01T00:00:00Z", 5)).toEqual([{ postId: "p", account: "en", media: ["a.jpg"], cover: null }]);
    await d.markPurged(K);
    expect(await d.stuck("2026-10-01T00:00:00Z")).toEqual([{ postId: "p", account: "en" }]);
    expect(calls[0]!.url).toContain("status=eq.published&media_purged_at=is.null&published_at=lt.2026-10-01T00%3A00%3A00Z&order=published_at&limit=5");
    expect(calls[1]!.url).toContain("status=eq.published");
  });
});

describe("OperatorDb", () => {
  function seq(...responses: unknown[]) {
    const queue = [...responses];
    const m = mock(() => queue.shift() ?? []);
    return { ...m, db: supabaseDb("https://x.supabase.co", SECRET, m.fetchFn) };
  }

  it("rows filters by week, status and key", async () => {
    const { db, calls } = seq([raw()]);
    const rows = await db.rows({ week: "2026-W44", status: ["scheduled", "failed"], key: K });
    expect(rows).toHaveLength(1);
    expect(calls[0]!.url).toContain("week=eq.2026-W44");
    expect(calls[0]!.url).toContain("status=in.(scheduled,failed)");
    expect(calls[0]!.url).toContain("post_id=eq.2026-10-26-a&account=eq.en");
  });

  it("insert posts every column in snake_case, and does nothing for an empty list", async () => {
    const { db, calls } = seq(null);
    await db.insert([]);
    expect(calls).toHaveLength(0);
    await db.insert([{ postId: K.postId, account: "en", type: "carousel", week: "2026-W44", publishAt: "2026-10-26T12:00:00Z", caption: "hi", media: ["a.jpg", "b.jpg"], cover: null, link: null, contentHash: "h", mediaHash: "m" }]);
    expect(body(calls[0]!)).toEqual([{ post_id: K.postId, account: "en", type: "carousel", week: "2026-W44", status: "scheduled", publish_at: "2026-10-26T12:00:00Z", caption: "hi", media: ["a.jpg", "b.jpg"], cover: null, link: null, content_hash: "h", media_hash: "m", source_commit: null, source_committed_at: null }]);
  });

  it("insert is an upsert by the key, so a post that moved to another week does not answer 409", async () => {
    const { db, calls } = seq(null);
    await db.insert([{ postId: K.postId, account: "en", type: "carousel", week: "2026-W45", publishAt: "2026-11-02T12:00:00Z", caption: "hi", media: ["a.jpg", "b.jpg"], cover: null, link: null, contentHash: "h", mediaHash: "m" }]);
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/weekpost_posts?on_conflict=post_id,account");
    expect(headers(calls[0]!).prefer).toBe("resolution=merge-duplicates,return=minimal");
  });

  it("updateContent refuses a row that is publishing, published or canceled", async () => {
    const { db } = seq([]);
    await expect(db.updateContent(K, { caption: "x", publishAt: "t", media: ["a.jpg"], cover: null, link: null, contentHash: "h", mediaHash: "m" })).rejects.toThrow("publishing, published or canceled");
  });

  it("cancel goes through weekpost_cancel and returns the previous status", async () => {
    const { db, calls } = seq("manual");
    expect(await db.cancel(K, "operator")).toBe("manual");
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/weekpost_cancel");
    expect(body(calls[0]!)).toEqual({ p_post_id: K.postId, p_account: "en", p_by: "operator", p_source_commit: null, p_source_committed_at: null });
  });

  it("cancel by the enqueue also sends the commit that canceled", async () => {
    const { db, calls } = seq("scheduled");
    await db.cancel(K, "enqueue", { sourceCommit: "a".repeat(40), sourceCommittedAt: "2026-10-12T09:00:00.000Z" });
    expect(body(calls[0]!)).toMatchObject({ p_by: "enqueue", p_source_commit: "a".repeat(40), p_source_committed_at: "2026-10-12T09:00:00.000Z" });
  });

  it("reads who canceled and which commit wrote the row", async () => {
    const { db } = seq([raw({ status: "canceled", canceled_by: "enqueue", source_commit: "b".repeat(40), source_committed_at: "2026-10-12T09:00:00Z" })]);
    expect(await db.rows({})).toMatchObject([{ canceledBy: "enqueue", sourceCommit: "b".repeat(40), sourceCommittedAt: "2026-10-12T09:00:00Z" }]);
  });

  it("updateContent with revive brings back only a row the enqueue canceled, as scheduled with a clean slate", async () => {
    const { db, calls } = seq([raw({ status: "scheduled" })]);
    const c = { caption: "x", publishAt: "t", media: ["a.jpg"], cover: null, link: null, contentHash: "h", mediaHash: "m" };
    await db.updateContent(K, c, { revive: true });
    expect(calls[0]!.url).toContain("status=eq.canceled&canceled_by=eq.enqueue");
    expect(body(calls[0]!)).toMatchObject({ status: "scheduled", attempts: 0, next_attempt_at: null, last_error: null, container_id: null, caption: "x" });
    const story = seq([raw()]);
    await story.db.updateContent(K, { ...c, status: "manual" }, { revive: true });
    expect(body(story.calls[0]!).status).toBe("manual");
    await expect(seq([]).db.updateContent(K, c, { revive: true })).rejects.toThrow("no longer canceled by the enqueue");
  });

  it("a plain updateContent no longer touches a canceled row", async () => {
    const { db, calls } = seq([raw()]);
    await db.updateContent(K, { caption: "x", publishAt: "t", media: ["a.jpg"], cover: null, link: null, contentHash: "h", mediaHash: "m" });
    expect(calls[0]!.url).toContain("status=in.(scheduled,manual,failed)");
    expect(calls[0]!.url).not.toContain("canceled");
  });

  it("restore goes through weekpost_restore and explains a refusal", async () => {
    const ok = seq(null);
    await ok.db.restore(K);
    expect(ok.calls[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/weekpost_restore");
    expect(body(ok.calls[0]!)).toEqual({ p_post_id: K.postId, p_account: "en" });
    const m = mock(() => new Response(JSON.stringify({ code: "P0002", message: "weekpost_posts 2026-10-26-a/en: not canceled" }), { status: 404 }));
    await expect(supabaseDb("https://x.supabase.co", SECRET, m.fetchFn).restore(K)).rejects.toThrow("cannot restore 2026-10-26-a/en: it is not canceled");
  });

  const refused = (message: string) =>
    supabaseDb("https://x.supabase.co", SECRET, mock(() => new Response(JSON.stringify({ code: "23514", message }), { status: 400 })).fetchFn);

  it.each(["publishing", "published"])("cancel refuses %s and says why", async (status) => {
    await expect(refused(`weekpost_posts 2026-10-26-a/en: cannot cancel, status is ${status}`).cancel(K, "operator"))
      .rejects.toThrow(`cannot cancel 2026-10-26-a/en: status is ${status}`);
  });

  it("cancel and reschedule say when the post does not exist", async () => {
    const m = mock(() => new Response(JSON.stringify({ code: "P0002", message: "weekpost_posts 2026-10-26-a/en: not found" }), { status: 404 }));
    const d = supabaseDb("https://x.supabase.co", SECRET, m.fetchFn);
    await expect(d.cancel(K, "operator")).rejects.toThrow("post not found: 2026-10-26-a/en");
    await expect(d.reschedule(K, "t", { rearm: false })).rejects.toThrow("post not found: 2026-10-26-a/en");
  });

  it("reschedule goes through weekpost_reschedule", async () => {
    const { db, calls } = seq(null);
    await db.reschedule(K, "2026-10-27T12:00:00Z", { rearm: true });
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/weekpost_reschedule");
    expect(body(calls[0]!)).toEqual({ p_post_id: K.postId, p_account: "en", p_publish_at: "2026-10-27T12:00:00Z", p_rearm: true });
  });

  it("reschedule refuses published rows, and failed rows without --rearm", async () => {
    await expect(refused("weekpost_posts 2026-10-26-a/en: cannot reschedule, status is published").reschedule(K, "t", { rearm: false })).rejects.toThrow("status is published");
    await expect(refused("weekpost_posts 2026-10-26-a/en: cannot reschedule, status is failed").reschedule(K, "t", { rearm: false })).rejects.toThrow("use --rearm");
  });

  it("rearm refuses a row that has a media id", async () => {
    await expect(refused("weekpost_posts 2026-10-26-a/en: cannot rearm, it has a media id").reschedule(K, "t", { rearm: true })).rejects.toThrow("media id");
  });

  it("resolveStuck goes through weekpost_resolve: published with the permalink, or back to the queue", async () => {
    const pub = seq(null);
    await pub.db.resolveStuck(K, { published: true, permalink: "https://i.test/p/1" });
    expect(pub.calls[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/weekpost_resolve");
    expect(body(pub.calls[0]!)).toEqual({ p_post_id: K.postId, p_account: "en", p_published: true, p_permalink: "https://i.test/p/1" });
    const no = seq(null);
    await no.db.resolveStuck(K, { published: false });
    expect(body(no.calls[0]!)).toEqual({ p_post_id: K.postId, p_account: "en", p_published: false, p_permalink: null });
  });

  it("resolveStuck says the post is not publishing when the function refuses", async () => {
    const m = mock(() => new Response(JSON.stringify({ code: "P0002", message: "weekpost_posts 2026-10-26-a/en: not in publishing" }), { status: 404 }));
    const db = supabaseDb("https://x.supabase.co", SECRET, m.fetchFn);
    await expect(db.resolveStuck(K, { published: false })).rejects.toThrow("cannot resolve 2026-10-26-a/en: it is not publishing");
  });
});

describe("MetricsDb", () => {
  const db = (handler: (u: string, i: RequestInit) => unknown) => {
    const m = mock(handler);
    return { ...m, db: supabaseDb("https://x.supabase.co", SECRET, m.fetchFn) };
  };

  it("publishedSince asks for published rows and maps them", async () => {
    const { db: d, calls } = db(() => [raw({ status: "published", media_id: "999" })]);
    const rows = await d.publishedSince("2026-10-16T00:00:00.000Z");
    expect(rows[0]).toMatchObject({ postId: "2026-10-26-a", mediaId: "999", status: "published" });
    expect(calls[0]!.url).toContain("status=eq.published");
    expect(calls[0]!.url).toContain("published_at=gte.2026-10-16T00%3A00%3A00.000Z");
  });

  it("failed, overdue and manualDue filter by status and time", async () => {
    const { db: d, calls } = db(() => []);
    await d.failed();
    await d.overdue("2026-10-30T07:00:00.000Z");
    await d.manualDue("2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
    expect(calls[0]!.url).toContain("status=eq.failed");
    expect(calls[1]!.url).toContain("status=eq.scheduled");
    expect(calls[1]!.url).toContain("publish_at=lt.2026-10-30T07%3A00%3A00.000Z");
    expect(calls[2]!.url).toContain("status=eq.manual");
    expect(calls[2]!.url).toContain("publish_at=gte.");
    expect(calls[2]!.url).toContain("publish_at=lt.");
  });

  it("upsertMetrics merges on the full key and sends nothing for an empty list", async () => {
    const { db: d, calls } = db(() => null);
    await d.upsertMetrics([]);
    expect(calls).toHaveLength(0);
    await d.upsertMetrics([{ scope: "account", postId: "", account: "en", collectedOn: "2026-10-30", metric: "reach", value: 37 }]);
    expect(calls[0]!.url).toContain("/rest/v1/weekpost_metrics?on_conflict=scope,post_id,account,collected_on,metric");
    expect(headers(calls[0]!).prefer).toContain("resolution=merge-duplicates");
    expect(body(calls[0]!)).toEqual([{ scope: "account", post_id: "", account: "en", collected_on: "2026-10-30", metric: "reach", value: 37 }]);
  });

  it("metricsSince maps rows and converts bigint strings to numbers", async () => {
    const { db: d, calls } = db(() => [{ scope: "post", post_id: "2026-10-26-a", account: "en", collected_on: "2026-10-30", metric: "views", value: "122" }]);
    expect(await d.metricsSince("2026-10-23")).toEqual([
      { scope: "post", postId: "2026-10-26-a", account: "en", collectedOn: "2026-10-30", metric: "views", value: 122 },
    ]);
    expect(calls[0]!.url).toContain("collected_on=gte.2026-10-23");
  });
});

describe("supabaseStorage", () => {
  const st = (handler: Parameters<typeof mock>[0]) => {
    const m = mock(handler);
    return { ...m, st: supabaseStorage("https://x.supabase.co/", SECRET, "media", m.fetchFn) };
  };

  it("put never overwrites: x-upsert is false, and an object that already exists is a success", async () => {
    const dup = st(() => new Response(JSON.stringify({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }), { status: 400 }));
    await expect(dup.st.put("2026-W44/p/en/abc.jpg", new Uint8Array([1]), "image/jpeg")).resolves.toBeUndefined();
    expect(headers(dup.calls[0]!)).toMatchObject({ "x-upsert": "false" });
    const conflict = st(() => new Response("{}", { status: 409 }));
    await expect(conflict.st.put("2026-W44/p/en/abc.jpg", new Uint8Array([1]), "image/jpeg")).resolves.toBeUndefined();
    const bad = st(() => new Response("nope", { status: 500 }));
    await expect(bad.st.put("2026-W44/p/en/abc.jpg", new Uint8Array([1]), "image/jpeg")).rejects.toThrow("500");
  });

  it("put sends the content type", async () => {
    const { st: s, calls } = st(() => ({ Key: "k" }));
    await s.put("2026-W44/p/en/01.jpg", new Uint8Array([1, 2]), "image/jpeg");
    expect(calls[0]!.url).toBe("https://x.supabase.co/storage/v1/object/media/2026-W44/p/en/01.jpg");
    expect(headers(calls[0]!)).toMatchObject({ "content-type": "image/jpeg", "x-upsert": "false" });
  });

  it("sign requests the ttl and builds full URLs in order", async () => {
    const { st: s, calls } = st(() => [
      { path: "b.jpg", error: null, signedURL: "/object/sign/media/b.jpg?token=2" },
      { path: "a.jpg", error: null, signedURL: "/object/sign/media/a.jpg?token=1" },
    ]);
    expect(await s.sign(["a.jpg", "b.jpg"], 3600)).toEqual([
      "https://x.supabase.co/storage/v1/object/sign/media/a.jpg?token=1",
      "https://x.supabase.co/storage/v1/object/sign/media/b.jpg?token=2",
    ]);
    expect(body(calls[0]!)).toEqual({ expiresIn: 3600, paths: ["a.jpg", "b.jpg"] });
  });

  it("a missing object is an error that names the path", async () => {
    const { st: s } = st(() => [{ path: "a.jpg", error: "Object not found", signedURL: null }]);
    await expect(s.sign(["a.jpg"], 60)).rejects.toThrow("media not found in the bucket: a.jpg (Object not found)");
  });

  it("remove uses DELETE with prefixes, and skips an empty list", async () => {
    const { st: s, calls } = st(() => []);
    await s.remove([]);
    expect(calls).toHaveLength(0);
    await s.remove(["a/b.jpg"]);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(body(calls[0]!)).toEqual({ prefixes: ["a/b.jpg"] });
  });

  it("rejects paths outside the bucket alphabet before any request", async () => {
    const { st: s, calls } = st(() => []);
    await expect(s.put("../x.jpg", new Uint8Array(), "image/jpeg")).rejects.toThrow("invalid storage path");
    await expect(s.sign(["a//b.jpg"], 60)).rejects.toThrow("invalid storage path");
    await expect(s.remove(["https://x/y"])).rejects.toThrow("invalid storage path");
    expect(calls).toHaveLength(0);
  });

  it("ensureBucket creates a private bucket and tolerates one that exists", async () => {
    const ok = st(() => ({ name: "media" }));
    await ok.st.ensureBucket();
    expect(ok.calls[0]!.url).toBe("https://x.supabase.co/storage/v1/bucket");
    expect(body(ok.calls[0]!)).toMatchObject({ id: "media", public: false, allowed_mime_types: ["image/jpeg", "video/mp4"] });
    const dup = st(() => new Response(JSON.stringify({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }), { status: 409 }));
    await expect(dup.st.ensureBucket()).resolves.toBeUndefined();
    const bad = st(() => new Response("nope", { status: 500 }));
    await expect(bad.st.ensureBucket()).rejects.toThrow("500");
  });
});

describe("isBucketPath", () => {
  it("accepts generator paths and rejects traversal and URLs", () => {
    expect(isBucketPath("2026-W42/p/en/slide-01.jpg")).toBe(true);
    for (const bad of ["../x", "a/../b", "/abs", "a//b", "a b", "https://x/y", ""]) expect(isBucketPath(bad)).toBe(false);
  });
});
