import { describe, expect, it } from "vitest";
import { runExtra, parseDotenv, type ExtraHook, type ExtraResult } from "./extra.ts";
import { runMetrics } from "../cli/metrics.ts";
import { buildReport } from "./report.ts";

const run = (hook: ExtraHook, over: Partial<Parameters<typeof runExtra>[0]> = {}): Promise<ExtraResult> =>
  runExtra({ hook, from: "2026-10-26T00:00:00Z", to: "2026-11-02T00:00:00Z", accounts: ["en", "pt"], ...over });

describe("runExtra", () => {
  it("returns the rows of a hook, with the window, the accounts and the parsed env", async () => {
    const r = await run(async ({ from, to, accounts, env }) => [{ label: "Sign-ups", value: 12 }, { label: "Ctx", value: [from, to, accounts.join(","), env.API_KEY].join("|") }], { envText: '# comment\nAPI_KEY="abc"\n' });
    expect(r).toEqual({ lines: [{ label: "Sign-ups", value: 12 }, { label: "Ctx", value: "2026-10-26T00:00:00Z|2026-11-02T00:00:00Z|en,pt|abc" }], warnings: [] });
  });

  it("gives an empty env without the secret", async () => {
    expect(await run(({ env }) => [{ label: "n", value: Object.keys(env).length }])).toEqual({ lines: [{ label: "n", value: 0 }], warnings: [] });
  });

  it("fails on timeout and aborts the signal", async () => {
    let signal: AbortSignal | undefined;
    const r = await run((ctx) => { signal = ctx.signal; return new Promise(() => {}); }, { timeoutMs: 100 });
    expect(r).toEqual({ error: "timed out after 0 s" });
    expect(signal?.aborted).toBe(true);
  });

  it("turns an exception or a rejection into an error without echoing its message", async () => {
    expect(await run(async () => { throw new Error("secret-token"); })).toEqual({ error: "the hook threw or rejected" });
    expect(await run(() => { throw new Error("secret-token"); })).toEqual({ error: "the hook threw or rejected" });
    expect(await run(() => Promise.reject("secret-token"))).toEqual({ error: "the hook threw or rejected" });
  });

  it("keeps the first 10 rows and warns about the rest", async () => {
    const r = await run(() => Array.from({ length: 12 }, (_, i) => ({ label: "n" + i, value: i })));
    expect(r).toMatchObject({ lines: expect.arrayContaining([{ label: "n9", value: 9 }]), warnings: [expect.stringContaining("12 rows")] });
    expect("lines" in r && r.lines).toHaveLength(10);
  });

  it("drops a label or value that is too long, with a warning", async () => {
    const r = await run(() => [{ label: "x".repeat(61), value: 1 }, { label: "ok", value: "y".repeat(121) }, { label: "x".repeat(60), value: "y".repeat(120) }]);
    expect(r).toEqual({ lines: [{ label: "x".repeat(60), value: "y".repeat(120) }], warnings: [expect.stringContaining("row 1 dropped: the label"), expect.stringContaining("row 2 dropped: the value")] });
  });

  it("drops rows of an invalid type, with a warning", async () => {
    const r = await run(() => [{ label: "a" }, { label: 1, value: 1 }, { label: "b", value: NaN }, { label: "c", value: { x: 1 } }, null, { label: " ", value: 1 }, { label: "ok", value: 0 }]);
    expect(r).toMatchObject({ lines: [{ label: "ok", value: 0 }] });
    expect("warnings" in r && r.warnings).toHaveLength(6);
  });

  it("fails when the hook does not return an array", async () => {
    expect(await run(() => ({ label: "a", value: 1 }))).toEqual({ error: expect.stringContaining("array") });
    expect(await run(() => undefined)).toEqual({ error: expect.stringContaining("array") });
  });

  it("rejects bad dotenv text", async () => {
    expect(await run(() => [], { envText: "not a pair" })).toEqual({ error: expect.stringContaining("dotenv") });
    expect(parseDotenv("A=1\nB='x y'")).toEqual({ A: "1", B: "x y" });
  });
});

describe("metrics report with the hook", () => {
  const base = { collected: { rows: [], issues: [], accounts: [], posts: [] }, failed: [], stuck: [], overdue: [], manual: [], tokens: [], graph: { version: "v26.0", level: "ok", detail: "" } } as never;
  const input = (extra: never, extraError?: string) => ({ ...(base as object), now: new Date("2026-11-02T08:00:00Z"), extra, ...(extraError ? { extraError } : {}) }) as unknown as Parameters<typeof buildReport>[0];

  it("is off by default", () => {
    expect(buildReport(input(null as never))).toContain("Not configured");
  });

  it("cleans external text and shows a failure under Attention", () => {
    const ok = buildReport(input([{ label: "A [x](http://e) @all", value: "`1`|2" }] as never));
    expect(ok).toContain("- A (x)(http://e) (at)all: '1'/2");
    const bad = buildReport(input([] as never, "exited with code 3"));
    expect(bad).toContain("**The `metrics.extra` hook failed:** exited with code 3");
    expect(bad).toContain("The hook failed; see Attention.");
  });
});

describe("weekpost metrics with the hook", () => {
  const db = {
    tokens: async () => [], stuck: async () => [], publishedSince: async () => [], metricsSince: async () => [],
    upsertMetrics: async () => {}, failed: async () => [], overdue: async () => [], manualDue: async () => [],
  };
  const exec = async (config: object | undefined, env: Record<string, string> = {}) => {
    const logs: string[] = [];
    const code = await runMetrics(["--json", "--project=."], { log: (m: string) => logs.push(m), error: () => {} } as never, process.cwd(), { db, fetch: (async () => new Response("{}")) as never, now: () => new Date("2026-11-02T08:00:00Z"), env: { WEEKPOST_SUPABASE_URL: "u", WEEKPOST_DB_KEY: "k", ...env }, tty: false, config: config as never });
    return { code, out: JSON.parse(logs[0]!) as { markdown: string; attention: string[] } };
  };

  it("runs nothing by default", async () => {
    const { code, out } = await exec({});
    expect(code).toBe(0);
    expect(out.markdown).toContain("Not configured");
  });

  it("shows the rows on success", async () => {
    const { out } = await exec({ metrics: { extra: async () => [{ label: "Sign-ups", value: 12 }] } });
    expect(out.markdown).toContain("- Sign-ups: 12");
  });

  it("turns a failing hook into an Attention line and still exits 0", async () => {
    const { code, out } = await exec({ metrics: { extra: async () => { throw new Error("boom"); } } });
    expect(code).toBe(0);
    expect(out.attention.join("\n")).toContain("hook failed");
  });

  it("reads WEEKPOST_METRICS_EXTRA_ENV into env and warns about a row that is too long", async () => {
    const { code, out } = await exec({ metrics: { extra: async ({ env }: { env: Record<string, string> }) => [{ label: "Key", value: env.API_KEY ?? "none" }, { label: "x".repeat(61), value: 1 }] } }, { WEEKPOST_METRICS_EXTRA_ENV: "API_KEY=abc" });
    expect(code).toBe(0);
    expect(out.markdown).toContain("- Key: abc");
    expect(out.attention.join("\n")).toContain("row 2 dropped");
  });
});
