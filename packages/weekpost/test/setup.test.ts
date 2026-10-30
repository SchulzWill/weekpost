import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.ts";
import { latestMigration, runSetup, type SetupDeps } from "../src/cli/setup.ts";
import { ApplyError, runApply, type Actions } from "../src/setup/apply.ts";
import { planSteps, probe } from "../src/setup/probes.ts";
import type { RunResult, Runner } from "../src/setup/runner.ts";
import { stepsFor, type SetupContext } from "../src/setup/steps.ts";

const SECRET = "SENTINEL-sb_secret_9f8e7d6c5b4a";
const URL_ = "https://abc.supabase.co";
const tmp = () => mkdtempSync(join(tmpdir(), "wp-setup-"));
const cap = () => {
  const lines: string[] = [];
  return { lines, text: () => lines.join("\n"), out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) } };
};

type RunCall = { cmd: string; args: string[]; input?: string; cwd?: string };
/** A runner that answers by the command line ("gh auth status"); anything not listed fails with status 1. */
function fakeRun(answers: Record<string, Partial<RunResult>>): { run: Runner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input, cwd: opts?.cwd });
    const key = [cmd, ...args].filter((a) => a !== "--yes").join(" ");
    const hit = answers[key];
    return { status: hit?.status ?? 1, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
  };
  return { run, calls };
}

type FetchCall = { url: string; method: string };
/** A fetch that answers by path ("/rest/v1/weekpost_schema?select=version" -> [status, body]). */
function fakeFetch(answers: Record<string, [number, unknown]>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET" });
    const hit = answers[u.replace(URL_, "")];
    const [status, body] = hit ?? [404, { message: "nope" }];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function ctxOf(over: Partial<SetupContext> & { runs?: Record<string, Partial<RunResult>>; fetches?: Record<string, [number, unknown]> } = {}) {
  const r = fakeRun(over.runs ?? {});
  const f = fakeFetch(over.fetches ?? {});
  const dir = tmp();
  const ctx: SetupContext = {
    projectRoot: dir,
    project: "demo",
    accounts: [{ id: "en", handle: "myapp" }],
    previewLabel: "media-ok",
    bucket: "weekpost-media",
    latestSchema: 3,
    localEnvFile: join(dir, "demo.env"),
    supabase: { url: URL_, key: SECRET },
    env: {},
    run: r.run,
    fetch: f.fetch,
    hasChromium: async () => true,
    ...over,
  };
  return { ctx, runCalls: r.calls, fetchCalls: f.calls, dir };
}

describe("latestMigration", () => {
  it("reads the highest number that ships with the package", () => {
    expect(latestMigration()).toBe(5);
  });
});

describe("stepsFor", () => {
  it("lists the steps in apply order with one token step per account and no secret value in a command", () => {
    const steps = stepsFor({ accounts: [{ id: "pt", handle: "a" }, { id: "en", handle: "b" }], previewLabel: "media-ok", bucket: "weekpost-media", project: "demo", latestSchema: 3 });
    expect(steps.map((s) => s.id)).toEqual([
      "prereq.logins", "project.deps", "db.migrate", "storage.bucket", "local.secrets", "worker.deploy", "worker.secrets",
      "github.label", "github.secrets", "github.environment", "token.pt", "token.en",
    ]);
    for (const s of steps) for (const c of s.commands) expect(c).not.toMatch(/sb_secret|--body|--value/);
  });
});

describe("probes", () => {
  it("prereq.logins: ok, and needs-you for each missing login", async () => {
    const good = { "gh auth status": { status: 0 }, "npx wrangler@4 whoami": { status: 0, stdout: "You are logged in" } };
    expect((await probe(ctxOf({ runs: good }).ctx, "prereq.logins")).state).toBe("ok");
    const noGh = await probe(ctxOf({ runs: { "npx wrangler@4 whoami": { status: 0 } } }).ctx, "prereq.logins");
    expect(noGh).toMatchObject({ state: "needs-you" });
    expect(noGh.detail).toContain("gh auth login");
    const noCf = await probe(ctxOf({ runs: { ...good, "npx wrangler@4 whoami": { status: 0, stdout: "You are not authenticated" } } }).ctx, "prereq.logins");
    expect(noCf.detail).toContain("wrangler login");
  });

  it("project.deps", async () => {
    expect((await probe(ctxOf().ctx, "project.deps")).state).toBe("ok");
    expect((await probe(ctxOf({ hasChromium: async () => false }).ctx, "project.deps")).state).toBe("todo");
  });

  it("db.migrate: unknown without credentials, todo when absent or behind, ok when current, unknown on a rejected key", async () => {
    const path = "/rest/v1/weekpost_schema?select=version";
    expect((await probe(ctxOf({ supabase: {} }).ctx, "db.migrate")).state).toBe("unknown");
    expect(await probe(ctxOf({ fetches: { [path]: [404, { code: "PGRST205", message: "missing" }] } }).ctx, "db.migrate")).toMatchObject({ state: "todo", detail: expect.stringContaining("0 of 3") });
    expect(await probe(ctxOf({ fetches: { [path]: [200, [{ version: 1 }]] } }).ctx, "db.migrate")).toMatchObject({ state: "todo", detail: expect.stringContaining("2 migration(s) pending") });
    expect(await probe(ctxOf({ fetches: { [path]: [200, [{ version: 3 }]] } }).ctx, "db.migrate")).toMatchObject({ state: "ok", detail: "schema 3 of 3" });
    expect((await probe(ctxOf({ fetches: { [path]: [401, {}] } }).ctx, "db.migrate")).state).toBe("unknown");
  });

  it("storage.bucket: ok when private, todo when missing or public, unknown without credentials", async () => {
    const path = "/storage/v1/bucket/weekpost-media";
    expect((await probe(ctxOf({ fetches: { [path]: [200, { public: false }] } }).ctx, "storage.bucket")).state).toBe("ok");
    expect((await probe(ctxOf({ fetches: { [path]: [200, { public: true }] } }).ctx, "storage.bucket")).state).toBe("todo");
    expect((await probe(ctxOf({ fetches: { [path]: [400, { message: "Bucket not found" }] } }).ctx, "storage.bucket")).state).toBe("todo");
    expect((await probe(ctxOf({ supabase: {} }).ctx, "storage.bucket")).state).toBe("unknown");
  });

  it("worker.deploy is always unknown", async () => {
    expect((await probe(ctxOf().ctx, "worker.deploy")).state).toBe("unknown");
  });

  it("worker.secrets: ok, todo with the missing name, unknown when wrangler fails", async () => {
    const cmd = "npx wrangler@4 secret list";
    const both = JSON.stringify([{ name: "WEEKPOST_SUPABASE_URL" }, { name: "WEEKPOST_SUPABASE_KEY" }]);
    expect((await probe(ctxOf({ runs: { [cmd]: { status: 0, stdout: both } } }).ctx, "worker.secrets")).state).toBe("ok");
    const one = await probe(ctxOf({ runs: { [cmd]: { status: 0, stdout: JSON.stringify([{ name: "WEEKPOST_SUPABASE_URL" }]) } } }).ctx, "worker.secrets");
    expect(one).toMatchObject({ state: "todo", detail: expect.stringContaining("WEEKPOST_SUPABASE_KEY") });
    expect((await probe(ctxOf().ctx, "worker.secrets")).state).toBe("unknown");
    expect((await probe(ctxOf({ runs: { [cmd]: { status: 0, stdout: "not json" } } }).ctx, "worker.secrets")).state).toBe("unknown");
  });

  it("github.label and github.secrets", async () => {
    const label = "gh label list --json name --limit 200";
    expect((await probe(ctxOf({ runs: { [label]: { status: 0, stdout: '[{"name":"media-ok"}]' } } }).ctx, "github.label")).state).toBe("ok");
    expect((await probe(ctxOf({ runs: { [label]: { status: 0, stdout: '[{"name":"bug"}]' } } }).ctx, "github.label")).state).toBe("todo");
    expect((await probe(ctxOf().ctx, "github.label")).state).toBe("unknown");
    const sec = "gh secret list --json name";
    expect((await probe(ctxOf({ runs: { [sec]: { status: 0, stdout: '[{"name":"OPENROUTER_API_KEY"}]' } } }).ctx, "github.secrets")).state).toBe("ok");
    expect((await probe(ctxOf({ runs: { [sec]: { status: 0, stdout: "[]" } } }).ctx, "github.secrets")).state).toBe("todo");
    expect((await probe(ctxOf().ctx, "github.secrets")).state).toBe("unknown");
  });

  it("github.environment: todo when absent, todo when unrestricted or without secrets, ok, unknown on other errors", async () => {
    const env = "gh api repos/{owner}/{repo}/environments/weekpost";
    const secrets = "gh secret list --env weekpost --json name";
    const restricted = JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    const both = JSON.stringify([{ name: "WEEKPOST_SUPABASE_URL" }, { name: "WEEKPOST_SUPABASE_KEY" }]);
    const pol = "gh api repos/{owner}/{repo}/environments/weekpost/deployment-branch-policies";
    const onlyMain = { status: 0, stdout: JSON.stringify({ branch_policies: [{ id: 1, name: "main" }] }) };
    expect(await probe(ctxOf({ runs: { [env]: { status: 1, stderr: "gh: Not Found (HTTP 404)" } } }).ctx, "github.environment")).toMatchObject({ state: "todo" });
    expect((await probe(ctxOf({ runs: { [env]: { status: 1, stderr: "HTTP 401" } } }).ctx, "github.environment")).state).toBe("unknown");
    const open = await probe(ctxOf({ runs: { [env]: { status: 0, stdout: "{}" }, [secrets]: { status: 0, stdout: both } } }).ctx, "github.environment");
    expect(open).toMatchObject({ state: "todo", detail: expect.stringContaining("not restricted") });
    const bare = await probe(ctxOf({ runs: { [env]: { status: 0, stdout: restricted }, [pol]: onlyMain, [secrets]: { status: 0, stdout: "[]" } } }).ctx, "github.environment");
    expect(bare).toMatchObject({ state: "todo", detail: expect.stringContaining("WEEKPOST_SUPABASE_URL") });
    expect((await probe(ctxOf({ runs: { [env]: { status: 0, stdout: restricted }, [pol]: onlyMain, [secrets]: { status: 0, stdout: both } } }).ctx, "github.environment")).state).toBe("ok");
  });

  it("local.secrets: todo when missing or too open, ok at 0600 with both values", async () => {
    const { ctx } = ctxOf();
    expect((await probe(ctx, "local.secrets")).state).toBe("todo");
    writeFileSync(ctx.localEnvFile, `WEEKPOST_SUPABASE_URL=${URL_}\nWEEKPOST_SUPABASE_KEY=${SECRET}\n`, { mode: 0o644 });
    chmodSync(ctx.localEnvFile, 0o644);
    const wide = await probe(ctx, "local.secrets");
    expect(wide.state).toBe("todo");
    expect(wide.detail).not.toContain(SECRET);
    chmodSync(ctx.localEnvFile, 0o600);
    expect((await probe(ctx, "local.secrets")).state).toBe("ok");
    writeFileSync(ctx.localEnvFile, `WEEKPOST_SUPABASE_URL=${URL_}\n`, { mode: 0o600 });
    expect(await probe(ctx, "local.secrets")).toMatchObject({ state: "todo", detail: expect.stringContaining("WEEKPOST_SUPABASE_KEY") });
  });

  it("token.<account>: ok with a row, needs-you without, unknown without credentials; never asks for the token column", async () => {
    const path = "/rest/v1/weekpost_tokens?select=account&account=eq.en";
    const a = ctxOf({ fetches: { [path]: [200, [{ account: "en" }]] } });
    expect((await probe(a.ctx, "token.en")).state).toBe("ok");
    expect(a.fetchCalls[0]!.url).not.toContain("access_token");
    expect((await probe(ctxOf({ fetches: { [path]: [200, []] } }).ctx, "token.en")).state).toBe("needs-you");
    expect((await probe(ctxOf({ supabase: {} }).ctx, "token.en")).state).toBe("unknown");
  });

  it("a probe that throws is unknown, with a fixed message", async () => {
    const { ctx } = ctxOf({ hasChromium: async () => { throw new Error(`boom ${SECRET}`); } });
    expect(await probe(ctx, "project.deps")).toEqual({ state: "unknown", detail: "the check failed unexpectedly" });
  });
});

describe("setup --plan", () => {
  const WRITING = /\b(put|set|create|deploy|install|PUT|POST|DELETE)\b/;
  const base = (over: Partial<SetupDeps> = {}): SetupDeps => ({
    config: { accounts: { en: { handle: "myapp" } }, ci: { previewLabel: "media-ok" } } as never,
    tty: false,
    env: {},
    context: { supabase: { url: URL_, key: SECRET } },
    ...over,
  });

  it("only reads: no write verb in any command or request, and works without a terminal", async () => {
    const r = fakeRun({ "gh auth status": { status: 0 }, "gh label list --json name --limit 200": { status: 0, stdout: "[]", } });
    const f = fakeFetch({ "/rest/v1/weekpost_schema?select=version": [200, [{ version: 1 }]] });
    const { out, text } = cap();
    expect(await runSetup(["--plan", `--project=${tmp()}`], out, process.cwd(), base({ run: r.run, fetch: f.fetch, hasChromium: async () => false }))).toBe(0);
    for (const c of r.calls) expect([c.cmd, ...c.args.filter((a) => a !== "--yes")].join(" ")).not.toMatch(WRITING);
    for (const c of f.calls) expect(c.method).toBe("GET");
    expect(r.calls.every((c) => c.input === undefined || c.input === "")).toBe(true);
    expect(text()).toContain("nothing is written");
    expect(text()).toContain("[todo     ] db.migrate");
    expect(text()).toContain("npx playwright install chromium");
  });

  it("does not print a secret in the text or the --json, even when a command's output holds one", async () => {
    const r = fakeRun({
      "gh auth status": { status: 0, stdout: `token ${SECRET}`, stderr: SECRET },
      "npx wrangler@4 whoami": { status: 0, stdout: SECRET },
      "gh secret list --json name": { status: 0, stdout: SECRET },
    });
    for (const json of [false, true]) {
      const { out, text } = cap();
      await runSetup(["--plan", ...(json ? ["--json"] : []), `--project=${tmp()}`], out, process.cwd(), base({ run: r.run, fetch: fakeFetch({}).fetch }));
      expect(text()).not.toContain(SECRET);
    }
  });

  it("--json is one parsable document with every step and its state", async () => {
    const { out, text } = cap();
    await runSetup(["--plan", "--json", `--project=${tmp()}`], out, process.cwd(), base({ run: fakeRun({}).run, fetch: fakeFetch({}).fetch }));
    const doc = JSON.parse(text()) as { steps: { id: string; state: string; commands: string[] }[] };
    expect(doc.steps.map((s) => s.id)).toContain("token.en");
    expect(doc.steps.every((s) => ["ok", "todo", "needs-you", "unknown"].includes(s.state))).toBe(true);
  });

  it("marks what is already done as ok (idempotent plan)", async () => {
    const c = ctxOf({
      runs: { "gh auth status": { status: 0 }, "npx wrangler@4 whoami": { status: 0, stdout: "ok" } },
      fetches: { "/rest/v1/weekpost_schema?select=version": [200, [{ version: 3 }]], "/storage/v1/bucket/weekpost-media": [200, { public: false }] },
    });
    const steps = await planSteps(c.ctx);
    expect(steps.filter((s) => s.state === "ok").map((s) => s.id)).toEqual(["prereq.logins", "project.deps", "db.migrate", "storage.bucket"]);
  });

  it("asks for exactly one of --plan and --apply, and has no --yes", async () => {
    for (const args of [[], ["--plan", "--apply"], ["--bogus"]]) {
      const { out } = cap();
      expect(await runSetup(args, out, process.cwd(), base())).toBe(2);
    }
    const { out, text } = cap();
    expect(await runSetup(["--apply", "--yes"], out, process.cwd(), base({ tty: true }))).toBe(2);
    expect(text()).toContain("no --yes");
  });

  it("is wired in the dispatcher", async () => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await main(["setup"])).toBe(2);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});

describe("setup --apply", () => {
  const cfg = { accounts: { en: { handle: "myapp" } }, ci: { previewLabel: "media-ok" } } as never;

  it("exits 2 without a terminal, before reading the config or calling anything", async () => {
    const r = fakeRun({});
    const f = fakeFetch({});
    const { out, text } = cap();
    expect(await runSetup(["--apply"], out, process.cwd(), { tty: false, config: cfg, run: r.run, fetch: f.fetch })).toBe(2);
    expect(text()).toContain("interactive terminal");
    expect(r.calls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  const apply = async (c: ReturnType<typeof ctxOf>, actions: Actions, confirm: (q: string) => Promise<boolean>, more: object = {}) => {
    const { out, text } = cap();
    const code = await runApply(c.ctx, out, confirm, { actions, ...more });
    return { code, text: text() };
  };
  const doneCtx = () =>
    ctxOf({
      runs: { "gh auth status": { status: 0 }, "npx wrangler@4 whoami": { status: 0, stdout: "ok" } },
      fetches: { "/rest/v1/weekpost_schema?select=version": [200, [{ version: 3 }]], "/storage/v1/bucket/weekpost-media": [200, { public: false }] },
    });

  it("skips done steps without asking, asks before an action, and runs it only on yes", async () => {
    const ran: string[] = [];
    const asked: string[] = [];
    const actions = { "project.deps": async () => void ran.push("deps"), "db.migrate": async () => void ran.push("migrate") };
    const c = ctxOf({ hasChromium: async () => false, runs: { "gh auth status": { status: 0 }, "npx wrangler@4 whoami": { status: 0, stdout: "ok" } }, fetches: { "/rest/v1/weekpost_schema?select=version": [200, [{ version: 3 }]] } });
    const r = await apply(c, actions, async (q) => (asked.push(q), true), { only: "project.deps" });
    expect(r.code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(ran).toEqual(["deps"]);
    expect(r.text).toContain("npx playwright install chromium");

    const again = await apply(doneCtx(), actions, async () => { throw new Error("must not ask"); }, { only: "db.migrate" });
    expect(again.text).toContain("already done");
    expect(ran).toEqual(["deps"]);
  });

  it("a no skips the step and lists it as still open", async () => {
    const ran: string[] = [];
    const c = ctxOf({ hasChromium: async () => false });
    const r = await apply(c, { "project.deps": async () => void ran.push("x") }, async () => false, { only: "project.deps" });
    expect(ran).toEqual([]);
    expect(r.text).toContain("skipped");
    expect(r.text).toContain("still open: project.deps");
  });

  it("stops at the first failure, undoes nothing, and never prints a secret the run learned", async () => {
    const ran: string[] = [];
    const actions = {
      "project.deps": async (io: { secret(n: "OPENROUTER_API_KEY"): Promise<string> }) => {
        const key = await io.secret("OPENROUTER_API_KEY");
        throw new ApplyError(`rejected ${key}`);
      },
      "storage.bucket": async () => void ran.push("bucket"),
    };
    const c = ctxOf({ hasChromium: async () => false, supabase: {} });
    const r = await apply(c, actions as never, async () => true, { env: { OPENROUTER_API_KEY: SECRET } });
    expect(r.code).toBe(1);
    expect(r.text).toContain("project.deps failed: rejected [redacted]");
    expect(r.text).not.toContain(SECRET);
    expect(r.text).toContain("continues from here");
    expect(ran).toEqual([]);
  });

  it("an unexpected error shows a fixed message, not its text", async () => {
    const c = ctxOf({ hasChromium: async () => false });
    const r = await apply(c, { "project.deps": async () => { throw new Error(`raw ${SECRET}`); } }, async () => true, { only: "project.deps" });
    expect(r.code).toBe(1);
    expect(r.text).toContain("the step failed");
    expect(r.text).not.toContain(SECRET);
  });

  it("reports needs-you steps with their guide, and a step without an action", async () => {
    const c = ctxOf({ supabase: { url: URL_, key: SECRET }, fetches: { "/rest/v1/weekpost_tokens?select=account&account=eq.en": [200, []] } });
    const r = await apply(c, {}, async () => true, { only: "token.en" });
    expect(r.text).toContain("needs you");
    expect(r.text).toContain("npx weekpost token en");
    const none = await apply(ctxOf({ hasChromium: async () => false }), {}, async () => true, { only: "project.deps" });
    expect(none.text).toContain("no automatic action");
  });

  it("rejects an unknown --only", async () => {
    const r = await apply(ctxOf(), {}, async () => true, { only: "nope" });
    expect(r.code).toBe(1);
    expect(r.text).toContain('unknown step "nope"');
  });
});
