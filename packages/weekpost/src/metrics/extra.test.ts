import { describe, expect, it } from "vitest";
import { runExtra, parseDotenv, type ExtraResult } from "./extra.ts";
import { runMetrics } from "../cli/metrics.ts";
import { buildReport } from "./report.ts";

const node = (code: string) => [process.execPath, "-e", code];
const run = (command: string[], over: Partial<Parameters<typeof runExtra>[0]> = {}): Promise<ExtraResult> =>
  runExtra({ command, cwd: process.cwd(), from: "2026-10-26T00:00:00Z", to: "2026-11-02T00:00:00Z", accounts: ["en", "pt"], ...over });

describe("runExtra", () => {
  it("returns the rows of a command that prints valid JSON", async () => {
    const r = await run(node('console.log(JSON.stringify([{label:"Sign-ups",value:12},{label:"Plan",value:"pro"}]))'));
    expect(r).toEqual({ lines: [{ label: "Sign-ups", value: 12 }, { label: "Plan", value: "pro" }] });
  });

  it("gives the command the window, the accounts and only WEEKPOST_METRICS_EXTRA_ENV as secrets", async () => {
    process.env.WEEKPOST_DB_KEY = "must-stay-out";
    const r = await run(
      node('const e=process.env;console.log(JSON.stringify([{label:"v",value:[e.WEEKPOST_METRICS_FROM,e.WEEKPOST_METRICS_ACCOUNTS,e.API_KEY,e.WEEKPOST_DB_KEY].join("|")}]))'),
      { envText: '# comment\nAPI_KEY="abc"\n' },
    );
    delete process.env.WEEKPOST_DB_KEY;
    expect(r).toEqual({ lines: [{ label: "v", value: "2026-10-26T00:00:00Z|en,pt|abc|" }] });
  });

  it("does not use a shell", async () => {
    const r = await run([process.execPath, "-e", "console.log(process.argv[1])", "; echo pwned"]);
    expect(r).toEqual({ error: expect.stringContaining("not JSON") });
  });

  it("fails on timeout", async () => {
    const r = await run(node("setTimeout(()=>{},60000)"), { timeoutMs: 200 });
    expect(r).toEqual({ error: expect.stringContaining("timed out") });
  });

  it("fails on invalid output", async () => {
    expect(await run(node('console.log("hello")'))).toEqual({ error: expect.stringContaining("not JSON") });
    expect(await run(node('console.log("{}")'))).toEqual({ error: expect.stringContaining("not a JSON array") });
    expect(await run(node('console.log(JSON.stringify([{label:"x"}]))'))).toEqual({ error: expect.stringContaining("row 1") });
  });

  it("fails on more than 10 rows", async () => {
    const r = await run(node('console.log(JSON.stringify(Array.from({length:11},(_, i)=>({label:"n"+i,value:i}))))'));
    expect(r).toEqual({ error: expect.stringContaining("11 rows") });
  });

  it("fails on a non-zero exit and on a missing program, without echoing output", async () => {
    expect(await run(node('console.log("secret-token");process.exit(3)'))).toEqual({ error: "exited with code 3" });
    expect(await run(["/nonexistent/program-xyz"])).toEqual({ error: expect.stringContaining("could not start") });
  });

  it("rejects bad dotenv text", async () => {
    expect(await run(node("1"), { envText: "not a pair" })).toEqual({ error: expect.stringContaining("dotenv") });
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
    const { out } = await exec({ metrics: { extra: { command: node('console.log(JSON.stringify([{label:"Sign-ups",value:12}]))') } } });
    expect(out.markdown).toContain("- Sign-ups: 12");
  });

  it("turns a failing hook into an Attention line and still exits 0", async () => {
    const { code, out } = await exec({ metrics: { extra: { command: node("process.exit(1)") } } });
    expect(code).toBe(0);
    expect(out.attention.join("\n")).toContain("hook failed");
  });
});
