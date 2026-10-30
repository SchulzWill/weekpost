import { describe, expect, it } from "vitest";
import { testConfig } from "../content/fixtures.ts";
import { supabaseDb } from "../queue/supabase.ts";
import { runToken, type TokenDeps } from "./token.ts";

const SENTINEL = "IGAA-SENTINEL-t0k3n-9f8e7d6c5b4a";
const KEY = "sb_secret_SENTINEL_service_key_123";
const NOW = new Date("2026-10-30T12:00:00Z");
const config = testConfig();

type Upsert = { account: string; igUserId: string; accessToken: string; expiresAt: string };

function setup(over: { me?: unknown; meStatus?: number; limitStatus?: number; clip?: string; typed?: string; upsertFails?: boolean } = {}) {
  const lines: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) };
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const saved: Upsert[] = [];
  const state = { cleared: 0, asked: 0 };
  const fetchFn = (async (u: string, init?: RequestInit) => {
    requests.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
    if (u.includes("/me?")) {
      const status = over.meStatus ?? 200;
      const body = status === 200 ? (over.me ?? { user_id: "9000000001", username: "shop.a" }) : { error: { message: `Invalid OAuth access token ${SENTINEL}`, code: 190 } };
      return new Response(JSON.stringify(body), { status });
    }
    if (u.includes("content_publishing_limit")) {
      const status = over.limitStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { data: [] } : { error: { message: "permission (#10) missing", code: 10 } }), { status });
    }
    throw new Error(`unexpected request ${u}`);
  }) as unknown as typeof fetch;
  const deps: TokenDeps = {
    config,
    env: { WEEKPOST_SUPABASE_KEY: KEY },
    tty: true,
    fetch: fetchFn,
    now: () => NOW,
    db: {
      upsertToken: async (t) => {
        if (over.upsertFails) throw new Error(`Supabase POST /rest/v1/weekpost_tokens -> 500 (key ${KEY})`);
        saved.push(t);
      },
    },
    clipboard: {
      read: async () => over.clip ?? ` ${SENTINEL}\n`,
      clear: async () => {
        state.cleared += 1;
      },
    },
    ask: async () => {
      state.asked += 1;
      return over.typed ?? SENTINEL;
    },
  };
  return { deps, out, lines, requests, saved, state };
}

const expectNoSecret = (lines: string[]) => expect(lines.join("\n")).not.toContain(SENTINEL);

describe("weekpost token", () => {
  it("checks the account, saves with ~59 days, clears the clipboard and prints no secret", async () => {
    const t = setup();
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.saved).toEqual([{ account: "a", igUserId: "9000000001", accessToken: SENTINEL, expiresAt: new Date(NOW.getTime() + 59 * 86_400_000).toISOString() }]);
    expect(t.state.cleared).toBe(1);
    expect(t.lines.join("\n")).toContain("@shop.a");
    expectNoSecret(t.lines);
  });

  it("sends the token in the Authorization header, never in the URL", async () => {
    const t = setup();
    await runToken(["a"], t.out, "/x", t.deps);
    expect(t.requests.length).toBe(2);
    for (const r of t.requests) {
      expect(r.url).not.toContain(SENTINEL);
      expect(r.headers.authorization).toBe(`Bearer ${SENTINEL}`);
    }
    expect(t.requests[0]!.url).toContain("/me?fields=user_id%2Cusername");
    expect(t.requests[1]!.url).toContain("/9000000001/content_publishing_limit");
  });

  it("refuses the wrong account, names both, saves nothing and keeps the clipboard", async () => {
    const t = setup({ me: { user_id: "9000000002", username: "someone.else" } });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    const text = t.lines.join("\n");
    expect(text).toContain("someone.else");
    expect(text).toContain("shop.a");
    expect(t.saved).toEqual([]);
    expect(t.state.cleared).toBe(0);
    expectNoSecret(t.lines);
  });

  it("compares the handle ignoring case", async () => {
    const t = setup({ me: { user_id: "90001", username: "Shop.A" } });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
  });

  it("reports a rejected token without echoing it", async () => {
    const t = setup({ meStatus: 400 });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    expect(t.saved).toEqual([]);
    expectNoSecret(t.lines);
  });

  it("points at the permission step when publishing is not allowed", async () => {
    const t = setup({ limitStatus: 403 });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    expect(t.lines.join("\n")).toMatch(/instagram_business_content_publish/);
    expect(t.saved).toEqual([]);
    expectNoSecret(t.lines);
  });

  it("refuses without a terminal, before reading anything", async () => {
    const t = setup();
    expect(await runToken(["a"], t.out, "/x", { ...t.deps, tty: false })).toBe(2);
    expect(t.requests).toEqual([]);
    expect(t.state.asked).toBe(0);
  });

  it("refuses an unknown account and lists the known ones", async () => {
    const t = setup();
    expect(await runToken(["zz"], t.out, "/x", t.deps)).toBe(1);
    expect(t.lines.join("\n")).toContain("a, b, en");
    expect(t.requests).toEqual([]);
  });

  it("asks for the account when none is given", async () => {
    const t = setup();
    expect(await runToken([], t.out, "/x", t.deps)).toBe(2);
    expect(t.lines.join("\n")).toContain("usage: weekpost token <account>");
  });

  it("--prompt uses the hidden prompt and leaves the clipboard alone", async () => {
    const t = setup({ clip: "something else entirely long enough 1234" });
    expect(await runToken(["a", "--prompt"], t.out, "/x", t.deps)).toBe(0);
    expect(t.state.asked).toBe(1);
    expect(t.state.cleared).toBe(0);
    expect(t.saved[0]!.accessToken).toBe(SENTINEL);
  });

  it("falls back to the prompt when the clipboard does not look like a token", async () => {
    const t = setup({ clip: "hello" });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.state.asked).toBe(1);
  });

  it("refuses a pasted value that is not a token and never prints it", async () => {
    const t = setup({ typed: "not a token because it has spaces and is long enough" });
    expect(await runToken(["a", "--prompt"], t.out, "/x", t.deps)).toBe(1);
    expect(t.requests).toEqual([]);
    expect(t.lines.join("\n")).not.toContain("not a token because");
  });

  it("keeps the token out of the output or the key when the save fails", async () => {
    const t = setup({ upsertFails: true });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    expect(t.state.cleared).toBe(0);
    const text = t.lines.join("\n");
    expect(text).not.toContain(KEY);
    expectNoSecret(t.lines);
  });
});

describe("supabase upsertToken", () => {
  it("posts a merge-duplicates upsert and keeps the token out of errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (u: string, init: RequestInit) => (calls.push({ url: u, init }), new Response(null, { status: 201 }))) as unknown as typeof fetch;
    await supabaseDb("https://x.supabase.co", KEY, ok).upsertToken({ account: "a", igUserId: "90001", accessToken: SENTINEL, expiresAt: "2026-12-28T12:00:00.000Z" });
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/weekpost_tokens?on_conflict=account");
    expect((calls[0]!.init.headers as Record<string, string>).prefer).toContain("merge-duplicates");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ account: "a", ig_user_id: "90001", access_token: SENTINEL });

    const bad = (async () => new Response(JSON.stringify({ message: `x ${SENTINEL}` }), { status: 400 })) as unknown as typeof fetch;
    const err = await supabaseDb("https://x.supabase.co", KEY, bad).upsertToken({ account: "a", igUserId: "1", accessToken: SENTINEL, expiresAt: "x" }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(SENTINEL);
    expect((err as Error).message).not.toContain(KEY);
  });
});
