import { describe, expect, it } from "vitest";
import { testConfig } from "../content/fixtures.ts";
import { supabaseDb } from "../queue/supabase.ts";
import { runToken, type TokenDeps } from "./token.ts";

const SENTINEL = "IGAA-SENTINEL-t0k3n-9f8e7d6c5b4a";
const KEY = "sb_secret_SENTINEL_service_key_123";
const NOW = new Date("2026-10-30T12:00:00Z");
const config = testConfig();

const UNIFIED = "EAAG-SENTINEL-un1f13d-1a2b3c4d5e6f";

type Upsert = { account: string; igUserId: string; accessToken: string; expiresAt: string | null; login?: string };
type Page = { data: { id: string; username: string }[]; paging?: { cursors?: { after?: string }; next?: string } };

function setup(over: {
  me?: unknown; meStatus?: number; limitStatus?: number; insightsStatus?: number; clip?: string; typed?: string; upsertFails?: boolean;
  /** Pages of /me/assigned_instagram_accounts; absent: graph.facebook.com rejects the token (190). */
  assigned?: Page[]; choose?: string[]; schema?: number | null;
} = {}) {
  const lines: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) };
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const saved: Upsert[] = [];
  const state = { cleared: 0, asked: 0, chosen: 0, schemaRead: 0 };
  const reject = () => new Response(JSON.stringify({ error: { message: `Invalid OAuth access token ${SENTINEL} ${UNIFIED}`, code: 190 } }), { status: 400 });
  const fetchFn = (async (u: string, init?: RequestInit) => {
    requests.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
    if (u.includes("graph.facebook.com") && u.includes("/me/assigned_instagram_accounts?")) {
      if (!over.assigned) return reject();
      const after = new URL(u).searchParams.get("after");
      const page = after ? Number(after) : 0;
      return new Response(JSON.stringify(over.assigned[page] ?? { data: [] }), { status: 200 });
    }
    if (u.includes("graph.instagram.com") && u.includes("/me?")) {
      const status = over.meStatus ?? 200;
      const body = status === 200 ? (over.me ?? { user_id: "9000000001", username: "shop.a" }) : { error: { message: `Invalid OAuth access token ${SENTINEL}`, code: 190 } };
      return new Response(JSON.stringify(body), { status });
    }
    if (u.includes("content_publishing_limit")) {
      const status = over.limitStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { data: [] } : { error: { message: "permission (#10) missing", code: 10 } }), { status });
    }
    if (u.includes("/insights")) {
      const status = over.insightsStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { data: [{ name: "reach", total_value: { value: 3 } }] } : { error: { message: "(#10) Application does not have permission for this action", code: 10 } }), { status });
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
    choose: async () => (over.choose ?? [])[state.chosen++] ?? "",
    schemaVersion: async () => (state.schemaRead++, over.schema === undefined ? 6 : over.schema),
  };
  return { deps, out, lines, requests, saved, state };
}

const expectNoSecret = (lines: string[]) => {
  expect(lines.join("\n")).not.toContain(SENTINEL);
  expect(lines.join("\n")).not.toContain(UNIFIED);
};

describe("weekpost token", () => {
  it("checks the account, saves with ~59 days, clears the clipboard and prints no secret", async () => {
    const t = setup();
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.saved).toEqual([{ account: "a", igUserId: "9000000001", accessToken: SENTINEL, expiresAt: new Date(NOW.getTime() + 59 * 86_400_000).toISOString(), login: "instagram" }]);
    expect(t.state.cleared).toBe(1);
    expect(t.lines.join("\n")).toContain("@shop.a");
    expectNoSecret(t.lines);
  });

  it("sends the token in the Authorization header, never in the URL", async () => {
    const t = setup();
    await runToken(["a"], t.out, "/x", t.deps);
    expect(t.requests.length).toBe(3);
    for (const r of t.requests) {
      expect(r.url).not.toContain(SENTINEL);
      expect(r.headers.authorization).toBe(`Bearer ${SENTINEL}`);
    }
    expect(t.requests[0]!.url).toContain("/me?fields=user_id%2Cusername");
    expect(t.requests[1]!.url).toContain("/9000000001/content_publishing_limit");
    expect(t.requests[2]!.url).toContain("/9000000001/insights");
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

  it("saves a token that cannot read Insights and warns", async () => {
    const t = setup({ insightsStatus: 400 });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.saved).toHaveLength(1);
    expect(t.lines).toContain("warning: the token for `a` cannot read Insights, so `weekpost metrics` will have no numbers (posts still publish). Generate it again in Meta's \"API setup with Instagram login\" with all three permissions (setup step 4, item 5), then run `npx weekpost token a`.");
    expectNoSecret(t.lines);
  });

  it("does not warn when the token can read Insights", async () => {
    const t = setup();
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.lines.join("\n")).not.toContain("Insights");
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

describe("weekpost token: login mode", () => {
  const unified = (over: Parameters<typeof setup>[0] = {}) => setup({ clip: UNIFIED, meStatus: 400, assigned: [{ data: [{ id: "70001", username: "shop.a" }] }], ...over });

  it("an EAA token tries the Unified login first and saves it without expiry", async () => {
    const t = unified();
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.saved).toEqual([{ account: "a", igUserId: "70001", accessToken: UNIFIED, expiresAt: null, login: "unified" }]);
    expect(new URL(t.requests[0]!.url).host).toBe("graph.facebook.com");
    expect(t.requests[0]!.url).toContain("/me/assigned_instagram_accounts?fields=id%2Cusername");
    expect(t.requests.every((r) => new URL(r.url).host === "graph.facebook.com")).toBe(true);
    expect(t.requests[1]!.url).toContain("/70001/content_publishing_limit");
    for (const r of t.requests) {
      expect(r.url).not.toContain(UNIFIED);
      expect(r.headers.authorization).toBe(`Bearer ${UNIFIED}`);
    }
    const text = t.lines.join("\n");
    expect(text).toContain("Unified login");
    expect(text).toContain("does not expire");
    expect(t.state.chosen).toBe(1);
    expectNoSecret(t.lines);
  });

  it("an EAA token that the Unified login rejects (190) falls back to the Instagram Login", async () => {
    const t = setup({ clip: "EAA-but-really-an-instagram-login-token-123" });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.requests.map((r) => new URL(r.url).host).slice(0, 2)).toEqual(["graph.facebook.com", "graph.instagram.com"]);
    expect(t.saved[0]).toMatchObject({ igUserId: "9000000001", login: "instagram" });
    expect(t.saved[0]!.expiresAt).not.toBeNull();
    expect(t.state.chosen).toBe(0);
  });

  it("an IG token that the Instagram Login rejects (190) falls back to the Unified login", async () => {
    const t = unified({ clip: SENTINEL });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.requests.map((r) => new URL(r.url).host).slice(0, 2)).toEqual(["graph.instagram.com", "graph.facebook.com"]);
    expect(t.saved[0]).toMatchObject({ login: "unified", expiresAt: null });
    expectNoSecret(t.lines);
  });

  it("both APIs reject the token: says so and saves nothing", async () => {
    const t = setup({ meStatus: 400 });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    expect(t.lines.join("\n")).toContain("token not accepted by Instagram Login nor Unified login");
    expect(t.saved).toEqual([]);
    expect(t.state.cleared).toBe(0);
    expectNoSecret(t.lines);
  });

  it("matches the handle among several accounts, ignoring case, across pages", async () => {
    const t = unified({
      assigned: [
        { data: [{ id: "70009", username: "other.shop" }], paging: { cursors: { after: "1" }, next: "https://graph.facebook.com/next" } },
        { data: [{ id: "70002", username: "Shop.A" }] },
      ],
    });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.saved[0]).toMatchObject({ igUserId: "70002", login: "unified" });
    expect(t.requests[1]!.url).toContain("after=1");
  });

  it("no account with the handle: lists the handles the token sees and saves nothing", async () => {
    const t = unified({ assigned: [{ data: [{ id: "1", username: "other.shop" }, { id: "2", username: "third.shop" }] }] });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    const text = t.lines.join("\n");
    expect(text).toContain("@other.shop, @third.shop");
    expect(text).toContain("@shop.a");
    expect(t.saved).toEqual([]);
    expect(t.requests).toHaveLength(1); // the Instagram Login is not asked: the token was accepted
  });

  it("a token that sees no account at all says so and saves nothing", async () => {
    const t = unified({ assigned: [{ data: [] }] });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    expect(t.lines.join("\n")).toContain("sees no Instagram account");
    expect(t.saved).toEqual([]);
  });

  it("--login skips the detection", async () => {
    const t = unified({ clip: SENTINEL });
    expect(await runToken(["a", "--login=unified"], t.out, "/x", t.deps)).toBe(0);
    expect(t.requests.every((r) => new URL(r.url).host === "graph.facebook.com")).toBe(true);
    const i = setup({ clip: UNIFIED });
    expect(await runToken(["a", "--login=instagram"], i.out, "/x", i.deps)).toBe(0);
    expect(i.requests.every((r) => new URL(r.url).host === "graph.instagram.com")).toBe(true);
    expect(i.saved[0]!.login).toBe("instagram");
  });

  it("--login with a single rejected mode does not try the other one", async () => {
    const t = setup({ meStatus: 400 });
    expect(await runToken(["a", "--login=instagram"], t.out, "/x", t.deps)).toBe(1);
    expect(t.requests).toHaveLength(1);
    expect(t.lines.join("\n")).toContain("Instagram did not accept the token");
    expectNoSecret(t.lines);
  });

  it("refuses an unknown --login value", async () => {
    const t = setup();
    expect(await runToken(["a", "--login=facebook"], t.out, "/x", t.deps)).toBe(2);
    expect(t.lines.join("\n")).toContain("--login=instagram|unified");
    expect(t.requests).toEqual([]);
  });

  it("refuses to save a Unified login token on a database below schema 6", async () => {
    const t = unified({ schema: 5 });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    expect(t.lines.join("\n")).toMatch(/schema 5.*schema 6/);
    expect(t.saved).toEqual([]);
    const u = unified({ schema: null });
    expect(await runToken(["a"], u.out, "/x", u.deps)).toBe(1);
    expect(u.saved).toEqual([]);
    // The Instagram Login does not depend on it.
    const i = setup({ schema: 5 });
    expect(await runToken(["a"], i.out, "/x", i.deps)).toBe(0);
    expect(i.state.schemaRead).toBe(0);
  });

  it('"60 days" saves an expiry and warns that it will not be renewed', async () => {
    const t = unified({ choose: ["60 days"] });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.saved[0]!.expiresAt).toBe(new Date(NOW.getTime() + 59 * 86_400_000).toISOString());
    expect(t.lines.join("\n")).toContain("cannot renew a Unified login token");
  });

  it("asks again on an answer that is neither, and gives up after three", async () => {
    const t = unified({ choose: ["maybe", "never"] });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(0);
    expect(t.saved[0]!.expiresAt).toBeNull();
    const u = unified({ choose: ["a", "b", "c"] });
    expect(await runToken(["a"], u.out, "/x", u.deps)).toBe(1);
    expect(u.saved).toEqual([]);
  });

  it("names the Unified login permissions in its messages", async () => {
    const t = unified({ limitStatus: 403 });
    expect(await runToken(["a"], t.out, "/x", t.deps)).toBe(1);
    expect(t.lines.join("\n")).toContain("instagram_content_publish permission");
    expect(t.lines.join("\n")).not.toContain("instagram_business_");
    const u = unified({ insightsStatus: 400 });
    expect(await runToken(["a"], u.out, "/x", u.deps)).toBe(0);
    expect(u.lines.join("\n")).toContain("instagram_manage_insights");
    expect(u.lines.join("\n")).toContain("Unified login");
    expectNoSecret(u.lines);
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

    expect(JSON.parse(String(calls[0]!.init.body)).login).toBe("instagram"); // default for callers that do not say

    await supabaseDb("https://x.supabase.co", KEY, ok).upsertToken({ account: "a", igUserId: "90001", accessToken: SENTINEL, expiresAt: null, login: "unified" });
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ login: "unified", expires_at: null });

    const bad = (async () => new Response(JSON.stringify({ message: `x ${SENTINEL}` }), { status: 400 })) as unknown as typeof fetch;
    const err = await supabaseDb("https://x.supabase.co", KEY, bad).upsertToken({ account: "a", igUserId: "1", accessToken: SENTINEL, expiresAt: "x" }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(SENTINEL);
    expect((err as Error).message).not.toContain(KEY);
  });
});
