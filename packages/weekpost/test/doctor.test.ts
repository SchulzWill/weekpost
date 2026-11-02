import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { metricsWorkflowCheck, runDoctor, unpinnedActions, type Check, type DoctorDeps } from "../src/cli/doctor.ts";
import { main } from "../src/cli/main.ts";
import { GRAPH_VERSIONS, graphVersionStatus } from "../src/setup/graphVersions.ts";
import type { RunResult } from "../src/setup/runner.ts";

const SB_KEY = "sb_secret_SENTINEL-4f5e6d7c";
const OR_KEY = "SENTINEL-sk-or-v1-aa11bb22";
const IG_TOKEN = "SENTINEL-IGQVJ-token-0123456789abcdef";
const URL_ = "https://abc.supabase.co";
const NOW = new Date("2026-11-01T00:00:00Z");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

type World = {
  runs: Record<string, Partial<RunResult>>;
  http: Record<string, [number, unknown]>;
  tokens: { account: string; igUserId: string; accessToken: string; expiresAt: string; refreshedAt: string }[];
  uses: string[];
  node: string;
  env: Record<string, string>;
  supabaseKey: string;
};

const BOTH = JSON.stringify([{ name: "WEEKPOST_SUPABASE_URL" }, { name: "WEEKPOST_SUPABASE_KEY" }]);
const RESTRICTED = JSON.stringify({ deployment_branch_policy: { custom_branch_policies: true } });

function greenWorld(): World {
  return {
    runs: {
      "gh auth status": { status: 0 },
      "npx --yes wrangler@4 whoami": { status: 0, stdout: "logged in" },
      "npx --yes wrangler@4 deployments list --json": { status: 0, stdout: '[{"id":"a"}]' },
      "npx --yes wrangler@4 secret list": { status: 0, stdout: BOTH },
      "gh label list --json name --limit 200": { status: 0, stdout: '[{"name":"media-ok"},{"name":"metrics"}]' },
      "gh secret list --json name": { status: 0, stdout: '[{"name":"OPENROUTER_API_KEY"}]' },
      "gh api repos/{owner}/{repo}/environments/weekpost": { status: 0, stdout: RESTRICTED },
      "gh api repos/{owner}/{repo}/environments/weekpost/deployment-branch-policies": { status: 0, stdout: JSON.stringify({ branch_policies: [{ id: 1, name: "main" }] }) },
      "gh secret list --env weekpost --json name": { status: 0, stdout: BOTH },
    },
    http: {
      "/rest/v1/weekpost_schema?select=version": [200, [{ version: 6 }]],
      "/storage/v1/bucket/weekpost-media": [200, { public: false }],
      "https://openrouter.ai/api/v1/key": [200, { data: { limit: 10 } }],
      "/me?fields=user_id%2Cusername": [200, { user_id: "1789", username: "myapp" }],
      "/me?fields=user_id,username": [200, { user_id: "1789", username: "myapp" }],
      "/1789/content_publishing_limit": [200, { data: [] }],
      "/1789/insights": [200, { data: [{ name: "reach", total_value: { value: 3 } }] }],
    },
    tokens: [{ account: "en", igUserId: "1789", accessToken: IG_TOKEN, expiresAt: "2026-12-20T00:00:00Z", refreshedAt: "2026-11-01T00:00:00Z" }],
    uses: [`actions/checkout@${SHA} # v7`],
    node: "22.4.0",
    env: { OPENROUTER_API_KEY: OR_KEY },
    supabaseKey: SB_KEY,
  };
}

async function doctor(w: World, args: string[] = [], envFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), "wp-doctor-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "a.yml"), `jobs:\n  x:\n    steps:\n${w.uses.map((u) => `      - uses: ${u}`).join("\n")}\n`);
  const runCalls: string[] = [];
  const httpCalls: { url: string; method: string }[] = [];
  const lines: string[] = [];
  const deps: DoctorDeps = {
    config: { accounts: { en: { handle: "myapp" } }, ci: { previewLabel: "media-ok" } } as never,
    env: { ...w.env },
    context: { supabase: { url: URL_, key: w.supabaseKey }, localEnvFile: envFile ?? join(dir, "demo.env") },
    run: async (cmd, a) => {
      const key = [cmd, ...a].join(" ");
      runCalls.push(key);
      const hit = w.runs[key];
      return { status: hit?.status ?? 1, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      httpCalls.push({ url: u, method: init?.method ?? "GET" });
      const hit = Object.entries(w.http).find(([k]) => u.endsWith(k) || u.includes(k));
      const [status, body] = hit?.[1] ?? [404, { message: "nope" }];
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
    hasChromium: async () => true,
    now: () => NOW,
    nodeVersion: w.node,
    db: { tokens: async () => w.tokens },
  };
  const code = await runDoctor([`--project=${dir}`, ...args], { log: (l) => lines.push(l), error: (l) => lines.push(`ERR ${l}`) }, process.cwd(), deps);
  const text = lines.join("\n");
  const checks = args.includes("--json") ? (JSON.parse(text) as { checks: Check[] }).checks : [];
  return { code, text, checks, runCalls, httpCalls, dir };
}

// The local secrets file: written for the green case, absent when a test calls doctor() directly.
async function greenDoctor(mutate: (w: World) => void = () => {}) {
  const w = greenWorld();
  mutate(w);
  const file = join(mkdtempSync(join(tmpdir(), "wp-doctor-env-")), "demo.env");
  writeFileSync(file, `WEEKPOST_SUPABASE_URL=${URL_}\nWEEKPOST_SUPABASE_KEY=${w.supabaseKey}\n`, { mode: 0o600 });
  return doctor(w, ["--json"], file);
}
const find = (cs: Check[], id: string) => cs.find((c) => c.id === id)!;

describe("graphVersionStatus", () => {
  const at = (d: string) => new Date(`${d}T00:00:00Z`);
  it("ok when far from the end, ok for the latest, warn in the last 180 days, fail after, warn when unknown", () => {
    expect(graphVersionStatus("v24.0", at("2026-11-01")).level).toBe("ok");
    expect(graphVersionStatus("v26.0", at("2026-11-01")).level).toBe("ok");
    expect(graphVersionStatus("v21.0", at("2026-11-01"))).toMatchObject({ level: "warn", detail: expect.stringContaining("2027-01-21") });
    expect(graphVersionStatus("v19.0", at("2026-11-01"))).toMatchObject({ level: "fail" });
    expect(graphVersionStatus("v99.0", at("2026-11-01")).level).toBe("warn");
  });
  it("ships the pinned version", async () => {
    const { GRAPH_API_VERSION } = await import("../src/publisher/instagram.ts");
    expect(GRAPH_VERSIONS[GRAPH_API_VERSION]).toBeDefined();
  });
});

describe("unpinnedActions", () => {
  it("flags tags and branches, ignores local and docker uses and pinned SHAs", () => {
    const dir = mkdtempSync(join(tmpdir(), "wp-wf-"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "w.yml"), [`- uses: actions/checkout@v4`, `- uses: actions/setup-node@${SHA} # v7`, `- uses: ./local`, `- uses: docker://alpine:3`, `- uses: a/b@main`, `- uses: a/c`].join("\n"));
    expect(unpinnedActions(dir).unpinned).toEqual(["w.yml: actions/checkout@v4", "w.yml: a/b@main", "w.yml: a/c"]);
  });
});

describe("metricsWorkflowCheck", () => {
  const project = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "wp-mwf-"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    for (const f of files) writeFileSync(join(dir, ".github", "workflows", f), "name: x\n");
    return dir;
  };
  it("warns when the other weekpost workflows exist but the metrics one does not", () => {
    expect(metricsWorkflowCheck(project(["weekpost-check.yml", "weekpost-enqueue.yml"]))).toMatchObject({ id: "github.metrics-workflow", level: "warn", fix: expect.stringContaining("gh label create metrics") });
  });
  it("is silent when it is there, or when the project has no weekpost workflows", () => {
    expect(metricsWorkflowCheck(project(["weekpost-check.yml", "weekpost-metrics.yml"]))).toBeUndefined();
    expect(metricsWorkflowCheck(project(["ci.yml"]))).toBeUndefined();
    expect(metricsWorkflowCheck(project([]))).toBeUndefined();
  });
});

describe("weekpost doctor", () => {
  it("exits 0 with every line ok when everything is in place, and only reads", async () => {
    const r = await greenDoctor();
    expect(r.checks.filter((c) => c.level !== "ok")).toEqual([]);
    expect(r.code).toBe(0);
    for (const c of r.runCalls) expect(c).not.toMatch(/\b(put|set|create|deploy|install)\b/);
    for (const h of r.httpCalls) expect(h.method).toBe("GET");
  });

  it("fails when an older environment policy lets another branch deploy, even though the flag is on", async () => {
    const r = await greenDoctor((w) => {
      w.runs["gh api repos/{owner}/{repo}/environments/weekpost/deployment-branch-policies"] = { status: 0, stdout: JSON.stringify({ branch_policies: [{ id: 1, name: "main" }, { id: 2, name: "*" }] }) };
    });
    expect(find(r.checks, "secrets.environment").level).toBe("fail");
  });

  it("prints no key and no token, in text or JSON, even when Instagram echoes the token", async () => {
    const r = await greenDoctor((w) => {
      w.http["/me?fields=user_id%2Cusername"] = [400, { error: { message: `bad token ${IG_TOKEN}` } }];
      w.http["/me?fields=user_id,username"] = [400, { error: { message: `bad token ${IG_TOKEN}` } }];
    });
    for (const s of [SB_KEY, OR_KEY, IG_TOKEN]) expect(r.text).not.toContain(s);
    expect(find(r.checks, "token.en").level).toBe("fail");
  });

  it("fails with the fix command for each missing piece", async () => {
    const r = await greenDoctor((w) => {
      w.http["/rest/v1/weekpost_schema?select=version"] = [200, [{ version: 1 }]];
      w.http["/storage/v1/bucket/weekpost-media"] = [404, {}];
      w.runs["npx --yes wrangler@4 deployments list --json"] = { status: 1 };
      w.runs["npx --yes wrangler@4 secret list"] = { status: 0, stdout: "[]" };
      w.runs["gh label list --json name --limit 200"] = { status: 0, stdout: "[]" };
      w.runs["gh secret list --json name"] = { status: 0, stdout: "[]" };
    });
    expect(r.code).toBe(1);
    expect(find(r.checks, "supabase.schema")).toMatchObject({ level: "fail", fix: "npx weekpost setup --apply --only=db.migrate" });
    expect(find(r.checks, "supabase.bucket")).toMatchObject({ level: "fail", fix: "npx weekpost setup --apply --only=storage.bucket" });
    expect(find(r.checks, "worker.deployed")).toMatchObject({ level: "fail", fix: "npx weekpost setup --apply --only=worker.deploy" });
    expect(find(r.checks, "secrets.worker")).toMatchObject({ level: "fail", fix: "npx weekpost setup --apply --only=worker.secrets" });
    expect(find(r.checks, "github.label")).toMatchObject({ level: "fail", fix: "npx weekpost setup --apply --only=github.label" });
    expect(find(r.checks, "secrets.actions")).toMatchObject({ level: "fail", fix: "npx weekpost setup --apply --only=github.secrets" });
  });

  it("reports the local secrets file as missing with the step to run", async () => {
    const w = greenWorld();
    const r = await doctor(w, ["--json"]);
    expect(find(r.checks, "secrets.local")).toMatchObject({ level: "fail", fix: "npx weekpost setup --apply --only=local.secrets" });
  });

  it("checks each token: missing, wrong account, cannot publish, expiring, expired", async () => {
    const t = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
    const row = (over: object = {}) => ({ account: "en", igUserId: "1789", accessToken: IG_TOKEN, expiresAt: t(40), refreshedAt: NOW.toISOString(), ...over });
    const cases: [string, (w: World) => void, string][] = [
      ["missing", (w) => (w.tokens = []), "no token saved"],
      ["wrong account", (w) => ((w.http["/me?fields=user_id%2Cusername"] = [200, { user_id: "1", username: "other" }]), (w.http["/me?fields=user_id,username"] = [200, { user_id: "1", username: "other" }])), "belongs to @other"],
      ["cannot publish", (w) => (w.http["/1789/content_publishing_limit"] = [403, { error: { message: "permission" } }]), "cannot publish"],
      ["expiring", (w) => (w.tokens = [row({ expiresAt: t(5) })]), "expires in 5 day"],
      ["expired", (w) => (w.tokens = [row({ expiresAt: t(-1) })]), "expired"],
    ];
    for (const [, mutate, text] of cases) {
      const r = await greenDoctor(mutate);
      const c = find(r.checks, "token.en");
      expect(c.level).toBe("fail");
      expect(c.detail).toContain(text);
      expect(c.fix).toBe("npx weekpost token en");
      expect(r.code).toBe(1);
    }
    expect(find((await greenDoctor((w) => (w.tokens = [row({ expiresAt: t(8) })]))).checks, "token.en").level).toBe("ok");
  });

  it("warns, without failing, when the token cannot read Insights", async () => {
    const r = await greenDoctor((w) => (w.http["/1789/insights"] = [400, { error: { message: "(#10) Application does not have permission for this action", code: 10 } }]));
    const c = find(r.checks, "token.en.insights");
    expect(c.level).toBe("warn");
    expect(c.detail).toBe("the token cannot read Insights; `weekpost metrics` needs `instagram_business_manage_insights` (posts still publish)");
    expect(c.fix).toBe("generate the token again with all three permissions (setup step 4, item 5), then: npx weekpost token en");
    expect(find(r.checks, "token.en").level).toBe("ok");
    expect(r.code).toBe(0);
  });

  it("does not warn when the token can read Insights or the check is inconclusive", async () => {
    expect(find((await greenDoctor()).checks, "token.en.insights")).toBeUndefined();
    const r = await greenDoctor((w) => (w.http["/1789/insights"] = [500, { error: { message: "boom", code: 2 } }]));
    expect(r.checks.some((c) => c.id === "token.en.insights")).toBe(false);
    expect(r.code).toBe(0);
  });

  it("OpenRouter: 401 fails, no credit limit warns, not set warns", async () => {
    expect(find((await greenDoctor((w) => (w.http["https://openrouter.ai/api/v1/key"] = [401, {}]))).checks, "openrouter").level).toBe("fail");
    const noLimit = await greenDoctor((w) => (w.http["https://openrouter.ai/api/v1/key"] = [200, { data: { limit: null } }]));
    expect(find(noLimit.checks, "openrouter").level).toBe("warn");
    expect(noLimit.code).toBe(0);
    expect(find((await greenDoctor((w) => (w.env = {}))).checks, "openrouter").level).toBe("warn");
  });

  it("Supabase key type: secret ok, publishable fails, legacy JWT warns", async () => {
    expect(find((await greenDoctor((w) => (w.supabaseKey = "sb_publishable_abc"))).checks, "supabase.key").level).toBe("fail");
    expect(find((await greenDoctor((w) => (w.supabaseKey = "aaa.bbb.ccc"))).checks, "supabase.key").level).toBe("warn");
  });

  it("an old Node and an unpinned action fail", async () => {
    const r = await greenDoctor((w) => {
      w.node = "20.11.0";
      w.uses = ["actions/checkout@v4"];
    });
    expect(find(r.checks, "node")).toMatchObject({ level: "fail" });
    expect(find(r.checks, "github.workflows")).toMatchObject({ level: "fail", detail: expect.stringContaining("actions/checkout@v4") });
  });

  it("a probe that cannot read (no gh login) is a warning, not a failure", async () => {
    const r = await greenDoctor((w) => (w.runs["gh label list --json name --limit 200"] = { status: 1 }));
    expect(find(r.checks, "github.label").level).toBe("warn");
  });

  it("a config that does not load is one failing line and exit 1", async () => {
    const lines: string[] = [];
    const code = await runDoctor([`--project=${mkdtempSync(join(tmpdir(), "wp-nocfg-"))}`], { log: (l) => lines.push(l), error: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("fail  config:");
  });

  it("is wired in the dispatcher", async () => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await main(["doctor", `--project=${mkdtempSync(join(tmpdir(), "wp-nocfg-"))}`])).toBe(1);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});
