// Test doubles: a stateful Meta (mocked fetch) and an in-memory PublisherDb with the same semantics as the SQL functions.
import type { Key, PublisherDb, QueueRow, Storage, Token } from "../src/queue/types.ts";
import { InstagramGraph } from "../src/publisher/instagram.ts";

export const TOKEN = "IGAAtoken-secret-1234567890abcdef";
export const IG_USER = "ig-user-1";

export class FakeMeta {
  calls: { method: string; path: string; params: Record<string, string>; authorization: string | null; url: string }[] = [];
  /** Per-container state; the script defines what each status check returns (the last one repeats). */
  containers = new Map<string, { script: string[]; published?: string }>();
  nextId = 1;
  publishCount = 0;
  failNext: { match: RegExp; body: unknown; status?: number } | null = null;
  defaultScript: string[] = ["FINISHED"];

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const params = Object.fromEntries(new URLSearchParams(init?.body ? String(init.body) : url.search));
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization");
    this.calls.push({ method, path: url.pathname, params, authorization, url: url.href });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (this.failNext && this.failNext.match.test(url.pathname)) {
      const f = this.failNext;
      this.failNext = null;
      return json(f.body, f.status ?? 400);
    }
    if (url.pathname === "/refresh_access_token") return json({ access_token: "IGAAnew-refreshed-token-0987654321", token_type: "bearer", expires_in: 5183944 });
    if (url.pathname.endsWith("/media") && method === "POST") {
      const id = `cont-${this.nextId++}`;
      this.containers.set(id, { script: [...this.defaultScript] });
      return json({ id });
    }
    if (url.pathname.endsWith("/media_publish")) {
      const c = this.containers.get(params.creation_id!);
      if (!c) return json({ error: { message: "unknown container", code: 100 } }, 400);
      this.publishCount++;
      c.published = `media-${this.publishCount}`;
      c.script = ["PUBLISHED"];
      return json({ id: c.published });
    }
    const id = url.pathname.split("/").pop()!;
    if (params.fields === "status_code") {
      const c = this.containers.get(id);
      if (!c) return json({ error: { message: "unknown container", code: 100 } }, 400);
      return json({ status_code: c.script.length > 1 ? c.script.shift() : c.script[0], id });
    }
    if (params.fields === "permalink") return json({ permalink: `https://www.instagram.com/p/${id}/`, id });
    return json({ error: { message: "unknown route" } }, 404);
  };
  graph = () => new InstagramGraph(this.fetch as typeof fetch);
  count = (re: RegExp) => this.calls.filter((c) => re.test(c.path)).length;
}

export type Row = QueueRow & { nextAttemptMs: number; publishAtMs: number; publishedAtMs?: number; purged?: boolean };

export function post(over: Partial<Row> & { postId: string }): Row {
  return {
    account: "main", type: "carousel", week: "2026-W42", publishAt: "1970-01-01T00:00:00.000Z", caption: "Caption",
    media: ["2026-W42/p/main/slide-01.jpg", "2026-W42/p/main/slide-02.jpg"], cover: null, link: null, contentHash: null,
    status: "scheduled", attempts: 0, nextAttemptAt: null, claimedAt: null, containerId: null, mediaId: null, permalink: null,
    lastError: null, publishedAt: null, mediaPurgedAt: null, rescheduledAt: null,
    nextAttemptMs: 0, publishAtMs: 0, ...over,
  };
}

export class FakeDb implements PublisherDb {
  rows: Row[] = [];
  tokensRows: Token[] = [];
  now = () => Date.now();
  claimLimits: number[] = [];

  find = (k: Key) => this.rows.find((r) => r.postId === k.postId && r.account === k.account)!;
  // Synchronous claim: never returns the same row twice (the `for update skip locked` of Postgres).
  async claim(limit: number) {
    this.claimLimits.push(limit);
    await Promise.resolve();
    const due = this.rows.filter((r) => r.status === "scheduled" && r.publishAtMs <= this.now() && r.nextAttemptMs <= this.now()).slice(0, limit);
    for (const r of due) { r.status = "publishing"; r.attempts++; }
    return due.map((r) => ({ ...r }));
  }
  async markPublished(k: Key, r: { containerId: string | null; mediaId: string | null; permalink: string | null }) {
    const row = this.find(k);
    if (row.status !== "publishing") throw new Error("not in publishing");
    Object.assign(row, { status: "published", containerId: r.containerId, mediaId: r.mediaId, permalink: r.permalink, publishedAtMs: this.now() });
  }
  async markFailed(k: Key, error: string, retryInSeconds: number) {
    const r = this.find(k);
    if (r.status !== "publishing") throw new Error("not in publishing");
    r.status = r.attempts >= 3 ? "failed" : "scheduled";
    r.nextAttemptMs = r.status === "failed" ? 0 : this.now() + retryInSeconds * 1000;
    r.lastError = error;
    return r.status as "scheduled" | "failed";
  }
  async release(k: Key, containerId: string | null, retryInSeconds: number) {
    const r = this.find(k);
    Object.assign(r, { status: "scheduled", attempts: Math.max(r.attempts - 1, 0), containerId: containerId ?? r.containerId, nextAttemptMs: this.now() + retryInSeconds * 1000 });
  }
  async setContainer(k: Key, containerId: string | null) { this.find(k).containerId = containerId; }
  async tokens() { return this.tokensRows.map((t) => ({ ...t })); }
  async saveToken(account: string, expected: string, access: string, expiresAt: string) {
    const t = this.tokensRows.find((x) => x.account === account && x.refreshedAt === expected);
    if (!t) return false;
    Object.assign(t, { accessToken: access, expiresAt, refreshedAt: new Date(this.now()).toISOString() });
    return true;
  }
  async duePurge(olderThanIso: string, limit: number) {
    return this.rows.filter((r) => r.status === "published" && !r.purged && r.publishedAtMs! < Date.parse(olderThanIso)).slice(0, limit);
  }
  async markPurged(k: Key) { this.find(k).purged = true; }
  stuckList: Key[] = [];
  async stuck() { return this.stuckList; }
}

export class FakeStorage implements Pick<Storage, "sign" | "remove"> {
  removed: string[] = [];
  signed: string[] = [];
  async sign(paths: string[]) { this.signed.push(...paths); return paths.map((p) => `https://signed.example/${p}?token=abc`); }
  async remove(paths: string[]) { this.removed.push(...paths); }
}

export function token(account = "main", over: Partial<Token> = {}): Token {
  const now = Date.now();
  return { account, igUserId: IG_USER, accessToken: TOKEN, expiresAt: new Date(now + 50 * 86_400_000).toISOString(), refreshedAt: new Date(now - 10 * 86_400_000).toISOString(), ...over };
}
