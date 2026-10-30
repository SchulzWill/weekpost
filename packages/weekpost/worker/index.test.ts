import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { optionsFromEnv, runFromEnv, type WorkerEnv } from "./index.ts";

const env: WorkerEnv = { WEEKPOST_SUPABASE_URL: "https://project.supabase.example", WEEKPOST_SUPABASE_KEY: "sb_secret_test" };

describe("optionsFromEnv", () => {
  it("defaults", () => {
    expect(optionsFromEnv({})).toMatchObject({ maxPostsPerRun: 2, refreshTokens: true, purgeAfterDays: 7, subrequestBudget: 50, graphVersion: "v26.0" });
  });
  it("reads the vars and ignores nonsense", () => {
    const o = optionsFromEnv({ WEEKPOST_MAX_POSTS_PER_RUN: "5", WEEKPOST_REFRESH_TOKENS: "false", WEEKPOST_GRAPH_VERSION: "v25.0", WEEKPOST_PURGE_AFTER_DAYS: "abc" });
    expect(o).toMatchObject({ maxPostsPerRun: 5, refreshTokens: false, graphVersion: "v25.0", purgeAfterDays: 7 });
  });
});

describe("scheduled handler", () => {
  it("runs against Supabase through a counting fetch and logs the subrequest total", async () => {
    const urls: string[] = [];
    const fetchMock = (async (u: string) => { urls.push(String(u)); return new Response("[]", { status: 200 }); }) as unknown as typeof fetch;
    const logs: [string, Record<string, unknown>][] = [];
    const out = await runFromEnv(env, fetchMock, (e, d) => logs.push([e, d]));
    expect(out.claimed).toBe(0);
    expect(urls.every((u) => u.startsWith("https://project.supabase.example/"))).toBe(true);
    expect(logs.find(([e]) => e === "subrequests")![1].total).toBe(urls.length);
  });

  it("a run that throws becomes an ERROR_run log, not an exception", async () => {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron: "*/5 * * * *" }, { WEEKPOST_SUPABASE_URL: "", WEEKPOST_SUPABASE_KEY: "" }, { waitUntil: (p) => pending.push(p) });
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});

describe("Worker template", () => {
  const toml = readFileSync(new URL("../template/worker/wrangler.toml", import.meta.url), "utf8");
  const active = toml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("has one cron, no public URL, observability on", () => {
    expect(active).toContain('crons = ["*/5 * * * *"]');
    expect(active).toContain("workers_dev = false");
    expect(active).toContain("preview_urls = false");
    expect(active).toMatch(/\[observability\]\s+enabled = true/);
  });

  it("carries no account id and no secret value", () => {
    expect(active).not.toMatch(/account_id/);
    expect(active).not.toMatch(/sb_secret_[A-Za-z0-9]/);
    expect(active).not.toMatch(/\[vars\]/);
  });
});
