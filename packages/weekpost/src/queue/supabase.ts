// Supabase through plain REST (PostgREST + RPC), with a server-side secret key. No supabase-js on
// purpose: every call counts as a subrequest on a Worker (50 per run on the free plan) and a fetch
// does the same job. The SQL functions in migrations/ own every state transition;
// this file only calls them.
//   RPC: POST /rest/v1/rpc/<fn>  https://supabase.com/docs/guides/api
//   Keys: https://supabase.com/docs/guides/api/api-keys
import type { Db, Fetch, Key, NewRow, QueueRow, SourceStamp, Status, Token } from "./types.ts";

/** Auth headers for a server key. `sb_secret_...` goes only in `apikey`; a legacy JWT goes in both. */
export function authHeaders(key: string | undefined): Record<string, string> {
  if (!key?.trim()) throw new Error("Supabase key is missing: set WEEKPOST_SUPABASE_KEY");
  return key.startsWith("sb_secret_") ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
}

export function baseUrl(url: string | undefined): string {
  if (!url?.trim()) throw new Error("Supabase URL is missing: set WEEKPOST_SUPABASE_URL");
  return url.trim().replace(/\/+$/, "");
}

/** Object path accepted in the bucket: no `..`, no double slash, only the alphabet the generator produces. */
export function isBucketPath(p: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(p) && !p.includes("..") && !p.includes("//");
}

/** Extra protection for one request: values the message must never contain, and whether to drop the body. */
export interface RequestGuard {
  /** Replaced by `[redacted]` anywhere in an error message (e.g. the new token during `saveToken`). */
  secrets?: string[];
  /** Never include the response body in the message (token writes: the body can echo the row). */
  omitBody?: boolean;
}

const TOKEN_TABLE = "/rest/v1/weekpost_tokens";

/** Message and code of a PostgREST error; `details`/`hint` hold row values ("Failing row contains (...)") and are dropped. */
function errorDetail(text: string): string {
  let out = text;
  try {
    const j = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof j.message === "string") out = `${typeof j.code === "string" ? `${j.code}: ` : ""}${j.message}`;
  } catch {
    /* not JSON: use the text */
  }
  return out.replace(/Failing row contains[\s\S]*$/i, "[row omitted]").slice(0, 200);
}

/** One request with error handling shared by the Db and Storage adapters. Never puts the key or row values in a message. */
export async function request(
  fetchFn: Fetch, base: string, key: string, path: string, init: RequestInit = {}, guard: RequestGuard = {},
): Promise<{ status: number; body: unknown }> {
  const route = `Supabase ${init.method ?? "GET"} ${path.split("?")[0]}`;
  const scrub = (m: string) => [key, ...(guard.secrets ?? [])].filter(Boolean).reduce((acc, v) => acc.split(v).join("[redacted]"), m);
  let res: Response;
  try {
    res = await fetchFn(`${base}${path}`, { ...init, headers: { ...authHeaders(key), "content-type": "application/json", ...init.headers } });
  } catch {
    // The runtime message repeats the URL ("Failed to parse URL from <url>"), and the URL carries the project host.
    throw new SupabaseError(`${route} -> network error`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    const omit = guard.omitBody || path.startsWith(TOKEN_TABLE);
    throw new SupabaseError(scrub(`${route} -> ${res.status}${omit ? "" : `: ${errorDetail(text)}`}`), res.status);
  }
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Turns a refusal of weekpost_cancel / weekpost_reschedule into the operator-facing message; anything else passes through. */
function refusal(e: unknown, k: Key, verb: "cancel" | "reschedule"): unknown {
  if (!(e instanceof SupabaseError)) return e;
  if (/: not found/.test(e.message)) return new Error(`post not found: ${label(k)}`);
  const status = /status is (\w+)/.exec(e.message)?.[1];
  if (status) return new Error(`cannot ${verb} ${label(k)}: status is ${status}` + (verb === "reschedule" && status === "failed" ? " (use --rearm)" : ""));
  if (/has a media id/.test(e.message)) return new Error(`cannot rearm ${label(k)}: it already has a media id, check Instagram first`);
  return e;
}

export class SupabaseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TABLE = "weekpost_posts";
const keyQuery = (k: Key) => `post_id=eq.${encodeURIComponent(k.postId)}&account=eq.${encodeURIComponent(k.account)}`;
const label = (k: Key) => `${k.postId}/${k.account}`;

type Raw = Record<string, unknown>;

function toRow(r: Raw): QueueRow {
  return {
    postId: r.post_id as string,
    account: r.account as string,
    type: r.type as QueueRow["type"],
    week: r.week as string,
    publishAt: r.publish_at as string,
    caption: r.caption as string,
    media: r.media as string[],
    cover: (r.cover as string | null) ?? null,
    link: (r.link as string | null) ?? null,
    contentHash: (r.content_hash as string | null) ?? null,
    mediaHash: (r.media_hash as string | null) ?? null,
    status: r.status as Status,
    attempts: r.attempts as number,
    nextAttemptAt: (r.next_attempt_at as string | null) ?? null,
    claimedAt: (r.claimed_at as string | null) ?? null,
    containerId: (r.container_id as string | null) ?? null,
    mediaId: (r.media_id as string | null) ?? null,
    permalink: (r.permalink as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    publishedAt: (r.published_at as string | null) ?? null,
    mediaPurgedAt: (r.media_purged_at as string | null) ?? null,
    rescheduledAt: (r.rescheduled_at as string | null) ?? null,
    sourceCommit: (r.source_commit as string | null) ?? null,
    sourceCommittedAt: (r.source_committed_at as string | null) ?? null,
    canceledBy: (r.canceled_by as QueueRow["canceledBy"]) ?? null,
  };
}

const stampColumns = (c: Partial<SourceStamp>) => ({ source_commit: c.sourceCommit ?? null, source_committed_at: c.sourceCommittedAt ?? null });

const contentColumns = (c: Pick<NewRow, "caption" | "publishAt" | "media" | "cover" | "link" | "contentHash" | "mediaHash"> & Partial<SourceStamp>) => ({
  publish_at: c.publishAt, caption: c.caption, media: c.media, cover: c.cover, link: c.link, content_hash: c.contentHash, media_hash: c.mediaHash,
  ...stampColumns(c),
});

export function supabaseDb(url: string, key: string, fetchFn: Fetch = fetch): Db {
  const base = baseUrl(url);
  authHeaders(key); // fail early, before any request
  const req = (path: string, init?: RequestInit, guard?: RequestGuard) => request(fetchFn, base, key, path, init, guard).then((r) => r.body);
  const rpc = (fn: string, args: Record<string, unknown>) => req(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  /** PATCH returning the changed rows, so the caller knows whether the status guard matched. */
  const patch = async (query: string, body: Raw): Promise<Raw[]> =>
    (await req(`/rest/v1/${TABLE}?${query}`, { method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify(body) })) as Raw[];
  const one = async (k: Key): Promise<QueueRow> => {
    const found = (await req(`/rest/v1/${TABLE}?select=*&${keyQuery(k)}`)) as Raw[];
    if (!found[0]) throw new Error(`post not found: ${label(k)}`);
    return toRow(found[0]);
  };

  return {
    async claim(limit) {
      return ((await rpc("weekpost_claim", { p_limit: limit })) as Raw[]).map(toRow);
    },
    async setContainer(k, containerId) {
      await patch(`${keyQuery(k)}&status=eq.publishing`, { container_id: containerId });
    },
    async markPublished(k, r) {
      await rpc("weekpost_mark_published", {
        p_post_id: k.postId, p_account: k.account, p_container_id: r.containerId, p_media_id: r.mediaId, p_permalink: r.permalink,
      });
    },
    async markFailed(k, error, retryInSeconds) {
      return (await rpc("weekpost_mark_failed", {
        p_post_id: k.postId, p_account: k.account, p_error: error, p_retry_in: `${retryInSeconds} seconds`,
      })) as "scheduled" | "failed";
    },
    async release(k, containerId, retryInSeconds) {
      await rpc("weekpost_release", {
        p_post_id: k.postId, p_account: k.account, p_container_id: containerId, p_retry_in: `${retryInSeconds} seconds`,
      });
    },
    async tokens() {
      const rows = (await req("/rest/v1/weekpost_tokens?select=account,ig_user_id,access_token,expires_at,refreshed_at")) as Raw[];
      return rows.map((r): Token => ({
        account: r.account as string, igUserId: r.ig_user_id as string, accessToken: r.access_token as string,
        expiresAt: r.expires_at as string, refreshedAt: r.refreshed_at as string,
      }));
    },
    async saveToken(account, expectedRefreshedAt, accessToken, expiresAt) {
      const now = new Date().toISOString();
      const changed = (await req(
        `/rest/v1/weekpost_tokens?account=eq.${encodeURIComponent(account)}&refreshed_at=eq.${encodeURIComponent(expectedRefreshedAt)}`,
        {
          method: "PATCH", headers: { prefer: "return=representation" },
          body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt, refreshed_at: now, updated_at: now }),
        },
        { secrets: [accessToken], omitBody: true },
      )) as Raw[];
      return changed.length > 0;
    },
    async duePurge(olderThanIso, limit) {
      const rows = (await req(
        `/rest/v1/${TABLE}?select=post_id,account,media,cover&status=eq.published&media_purged_at=is.null` +
          `&published_at=lt.${encodeURIComponent(olderThanIso)}&order=published_at&limit=${limit}`,
      )) as Raw[];
      return rows.map((r) => ({ postId: r.post_id as string, account: r.account as string, media: r.media as string[], cover: (r.cover as string | null) ?? null }));
    },
    async markPurged(k) {
      await patch(`${keyQuery(k)}&status=eq.published`, { media_purged_at: new Date().toISOString() });
    },
    async stuck(olderThanIso) {
      const rows = (await req(
        `/rest/v1/${TABLE}?select=post_id,account&status=eq.publishing&claimed_at=lt.${encodeURIComponent(olderThanIso)}&limit=5`,
      )) as Raw[];
      return rows.map((r) => ({ postId: r.post_id as string, account: r.account as string }));
    },

    async rows(filter) {
      const q = ["select=*", "order=publish_at,post_id,account"];
      if (filter.week) q.push(`week=eq.${encodeURIComponent(filter.week)}`);
      if (filter.status?.length) q.push(`status=in.(${filter.status.join(",")})`);
      if (filter.key) q.push(keyQuery(filter.key));
      return ((await req(`/rest/v1/${TABLE}?${q.join("&")}`)) as Raw[]).map(toRow);
    },
    async insert(rows) {
      if (!rows.length) return;
      // PostgREST needs the same keys in every object of the array, so `status` is always sent.
      const body = rows.map((r) => ({ post_id: r.postId, account: r.account, type: r.type, week: r.week, status: r.status ?? "scheduled", ...contentColumns(r) }));
      // Upsert by the key: a post that moved to another week keeps its (post_id, account) and would answer 409 otherwise.
      // The SQL trigger refuses to rewrite a row that is publishing or published, and to change its status (migration 0003),
      // so an upsert that races a publisher fails instead of reopening the post.
      await req(`/rest/v1/${TABLE}?on_conflict=post_id,account`, {
        method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(body),
      });
    },
    async updateContent(k, c, opts) {
      if (opts?.revive) {
        // Only a row the enqueue itself canceled; the SQL trigger refuses the operator's cancels as well.
        const set = { ...contentColumns(c), status: c.status ?? "scheduled", attempts: 0, next_attempt_at: null, last_error: null, container_id: null };
        const back = await patch(`${keyQuery(k)}&status=eq.canceled&canceled_by=eq.enqueue`, set);
        if (!back.length) throw new Error(`cannot bring back ${label(k)}: it is no longer canceled by the enqueue`);
        return;
      }
      // Only while the row is still editable; the SQL trigger refuses the rest as well.
      const changed = await patch(`${keyQuery(k)}&status=in.(scheduled,manual,failed)`, contentColumns(c));
      if (!changed.length) throw new Error(`cannot update ${label(k)}: it is publishing, published or canceled`);
    },
    async cancel(k, by, stamp) {
      // A function, not a PATCH: the status guard and the write happen under one row lock (migration 0004).
      try {
        return (await rpc("weekpost_cancel", {
          p_post_id: k.postId, p_account: k.account, p_by: by,
          p_source_commit: stamp?.sourceCommit ?? null, p_source_committed_at: stamp?.sourceCommittedAt ?? null,
        })) as Status;
      } catch (e) {
        throw refusal(e, k, "cancel");
      }
    },
    async restore(k) {
      try {
        await rpc("weekpost_restore", { p_post_id: k.postId, p_account: k.account });
      } catch (e) {
        if (e instanceof SupabaseError && /not canceled/.test(e.message)) throw new Error(`cannot restore ${label(k)}: it is not canceled`);
        throw e;
      }
    },
    async reschedule(k, publishAt, opts) {
      try {
        await rpc("weekpost_reschedule", { p_post_id: k.postId, p_account: k.account, p_publish_at: publishAt, p_rearm: opts.rearm });
      } catch (e) {
        throw refusal(e, k, "reschedule");
      }
    },
    async resolveStuck(k, outcome) {
      // A function, not a PATCH: only the publisher functions may move a row out of `publishing` (migration 0003).
      try {
        await rpc("weekpost_resolve", {
          p_post_id: k.postId, p_account: k.account, p_published: outcome.published, p_permalink: outcome.published ? outcome.permalink : null,
        });
      } catch (e) {
        if (e instanceof SupabaseError && /not in publishing/.test(e.message)) throw new Error(`cannot resolve ${label(k)}: it is not publishing`);
        throw e;
      }
    },
    async upsertToken(t) {
      const now = new Date().toISOString();
      await req(
        "/rest/v1/weekpost_tokens?on_conflict=account",
        {
          method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ account: t.account, ig_user_id: t.igUserId, access_token: t.accessToken, expires_at: t.expiresAt, refreshed_at: now, updated_at: now }),
        },
        { secrets: [t.accessToken], omitBody: true },
      );
    },
  };
}
