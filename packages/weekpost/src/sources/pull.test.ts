import { describe, expect, it } from "vitest";
import { normalizeItem, previousWeekWindow, pullSources, sourceEnv, SourceError } from "./pull.ts";
import type { SourceAdapter, SourceItem } from "./types.ts";

const item = (over: Partial<SourceItem> = {}): SourceItem => ({
  id: "1", title: "A title", url: "https://example.com/a", publishedAt: "2026-10-20T10:00:00Z", ...over,
});
const adapter = (name: string, items: SourceItem[] | Error): SourceAdapter => ({
  name,
  pull: async () => {
    if (items instanceof Error) throw items;
    return items;
  },
});
const run = (adapters: SourceAdapter[], over: Partial<Parameters<typeof pullSources>[0]> = {}) =>
  pullSources({ adapters, week: "2026-W44", limit: 20, projectDir: "/p", env: {}, ...over });

describe("previousWeekWindow", () => {
  it("is the ISO week before the target, Monday to Monday in UTC", () => {
    expect(previousWeekWindow("2026-W44")).toEqual({ from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z" });
  });
  it("crosses the ISO year: W01 2026 follows W53 of 2025", () => {
    expect(previousWeekWindow("2026-W01")).toEqual({ from: "2025-12-22T00:00:00.000Z", to: "2025-12-29T00:00:00.000Z" });
    expect(previousWeekWindow("2021-W01")).toEqual({ from: "2020-12-28T00:00:00.000Z", to: "2021-01-04T00:00:00.000Z" });
  });
  it("rejects a malformed week", () => {
    expect(() => previousWeekWindow("2026-44")).toThrow(/YYYY-Www/);
  });
});

describe("sourceEnv", () => {
  it("keeps only WEEKPOST_SOURCE_* and drops infrastructure secrets", () => {
    const env = sourceEnv({ WEEKPOST_SOURCE_X: "1", WEEKPOST_SUPABASE_KEY: "k", CLOUDFLARE_API_TOKEN: "t", DATABASE_URL: "d", PATH: "/bin", WEEKPOST_SOURCE_EMPTY: "" });
    expect(env).toEqual({ WEEKPOST_SOURCE_X: "1" });
  });
});

describe("normalizeItem", () => {
  it("strips HTML and control characters, applies NFC and trims", () => {
    const n = normalizeItem(item({ title: "  <b>Café</b>\u0000 <script>x()</script>news\n ", summary: "<p>One</p>\u0007 two" }))!;
    expect(n.title).toBe("Café x()news");
    expect(n.summary).toBe("One two");
  });
  it("cuts the title at 300 and the summary at 1200 characters", () => {
    const n = normalizeItem(item({ title: "t".repeat(400), summary: "s".repeat(2000) }))!;
    expect(n.title).toHaveLength(300);
    expect(n.summary).toHaveLength(1200);
  });
  it("accepts only https URLs, in url and originalUrl", () => {
    expect(normalizeItem(item({ url: "http://example.com" }))).toBeNull();
    expect(normalizeItem(item({ url: "javascript:alert(1)" }))).toBeNull();
    expect(normalizeItem(item({ url: "not a url" }))).toBeNull();
    expect(normalizeItem(item({ originalUrl: "http://example.com/o" }))!.originalUrl).toBeUndefined();
    expect(normalizeItem(item({ originalUrl: "https://example.com/o" }))!.originalUrl).toBe("https://example.com/o");
  });
  it("requires a title and an ISO date with a time zone, and writes the date in UTC", () => {
    expect(normalizeItem(item({ title: " <i></i> " }))).toBeNull();
    expect(normalizeItem(item({ publishedAt: "2026-10-20" }))).toBeNull();
    expect(normalizeItem(item({ publishedAt: "2026-10-20T10:00:00" }))).toBeNull();
    expect(normalizeItem(item({ publishedAt: "2026-10-20T10:00:00+02:00" }))!.publishedAt).toBe("2026-10-20T08:00:00.000Z");
  });
  it("cleans outlet and tags and drops what is not text", () => {
    const n = normalizeItem(item({ outlet: " <a>Wired</a> ", tags: ["<b>ai</b>", "", "x"] }))!;
    expect(n.outlet).toBe("Wired");
    expect(n.tags).toEqual(["ai", "x"]);
  });
});

describe("pullSources", () => {
  it("gives each adapter the previous-week window, the limit and only the source env", async () => {
    let seen: unknown;
    const a: SourceAdapter = { name: "a", pull: async (q, ctx) => ((seen = { q, ctx }), []) };
    await run([a], { env: { WEEKPOST_SOURCE_K: "v" }, limit: 7 });
    expect(seen).toEqual({
      q: { week: "2026-W44", from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z", limit: 7 },
      ctx: { projectDir: "/p", env: { WEEKPOST_SOURCE_K: "v" } },
    });
  });
  it("merges adapters, removes duplicate URLs, tags the source and sorts by date", async () => {
    const r = await run([
      adapter("one", [item({ id: "1", url: "https://e.com/late", publishedAt: "2026-10-22T00:00:00Z" }), item({ id: "2", url: "https://e.com/dup", publishedAt: "2026-10-20T00:00:00Z" })]),
      adapter("two", [item({ id: "9", url: "https://e.com/dup", publishedAt: "2026-10-21T00:00:00Z" }), item({ id: "3", url: "https://e.com/early", publishedAt: "2026-10-19T12:00:00Z" })]),
    ]);
    expect(r.items.map((i) => [i.source, i.id])).toEqual([["two", "3"], ["one", "2"], ["one", "1"]]);
  });
  it("counts what it dropped", async () => {
    const r = await run([adapter("a", [item(), item({ url: "http://bad.example" })])]);
    expect(r.items).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });
  it("keeps the newest items when over the limit", async () => {
    const many = [1, 2, 3].map((n) => item({ id: String(n), url: `https://e.com/${n}`, publishedAt: `2026-10-2${n}T00:00:00Z` }));
    const r = await run([adapter("a", many)], { limit: 2 });
    expect(r.items.map((i) => i.id)).toEqual(["2", "3"]);
  });
  it("names the adapter when it fails and hides the source variables from the message", async () => {
    const err = await run([adapter("db", new Error("connect postgres://u:SECRETPASS@h/db failed"))], { env: { WEEKPOST_SOURCE_DB_URL: "postgres://u:SECRETPASS@h/db" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("db");
    expect((err as Error).message).not.toContain("SECRETPASS");
  });
  it("accepts a sync-throwing adapter and a non-array answer as failures", async () => {
    const bad: SourceAdapter = { name: "bad", pull: () => { throw new Error("boom"); } };
    await expect(run([bad])).rejects.toThrow(/bad.*boom/);
    const notArray = { name: "na", pull: async () => ({}) } as unknown as SourceAdapter;
    await expect(run([notArray])).rejects.toThrow(/na.*list/);
  });
});

describe("limits on what an adapter can hand to the agent", () => {
  it("drops a URL longer than 2048 characters", () => {
    expect(normalizeItem(item({ url: `https://example.com/${"a".repeat(2100)}` }))).toBeNull();
    expect(normalizeItem(item({ url: `https://example.com/${"a".repeat(100)}` }))).not.toBeNull();
    expect(normalizeItem(item({ originalUrl: `https://example.com/${"a".repeat(2100)}` }))?.originalUrl).toBeUndefined();
  });
  it("keeps at most 10 tags", () => {
    const tags = Array.from({ length: 25 }, (_, i) => `t${i}`);
    expect(normalizeItem(item({ tags }))?.tags).toEqual(tags.slice(0, 10));
  });
  it("removes variation selectors that can carry hidden bytes, and keeps the emoji presentation selector", () => {
    const hidden = `Hi${String.fromCodePoint(0xe0100, 0xe0101)}\ufe00\ufe01 there`;
    expect(normalizeItem(item({ title: hidden }))?.title).toBe("Hi there");
    expect(normalizeItem(item({ title: "Heart \u2764\ufe0f ok" }))?.title).toBe("Heart \u2764\ufe0f ok");
  });
  it("cuts an adapter's error message to 300 characters", async () => {
    const err = await run([adapter("x", new Error("boom ".repeat(200)))]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message.length).toBeLessThanOrEqual(300);
  });
});
