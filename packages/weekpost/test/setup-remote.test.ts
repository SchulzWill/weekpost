import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/setup/actions.ts";
import { runApply, type ApplyIO } from "../src/setup/apply.ts";
import { remoteActions } from "../src/setup/remote.ts";
import type { RunResult, Runner } from "../src/setup/runner.ts";
import type { SetupContext } from "../src/setup/steps.ts";

const URL_ = "https://abc.supabase.co";
const KEY = "SENTINEL-sb_secret_11aa22bb";
const OPENROUTER = "SENTINEL-sk-or-v1-99ff88ee";
const VALUES: Record<string, string> = { WEEKPOST_SUPABASE_URL: URL_, WEEKPOST_SUPABASE_KEY: KEY, OPENROUTER_API_KEY: OPENROUTER };
const tmp = () => mkdtempSync(join(tmpdir(), "wp-remote-"));

type Call = { cmd: string; args: string[]; input?: string; cwd?: string };
function harness(answer: (c: Call) => Partial<RunResult> = () => ({ status: 0 })) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const dir = tmp();
  const run: Runner = async (cmd, args, opts) => {
    const c = { cmd, args, input: opts?.input, cwd: opts?.cwd };
    calls.push(c);
    const a = answer(c);
    return { status: "status" in a ? (a.status as number | null) : 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  const ctx = { projectRoot: dir, project: "demo", previewLabel: "media-ok", localEnvFile: join(dir, "cfg", "demo.env"), run } as unknown as SetupContext;
  const io: ApplyIO = {
    out: { log: (l) => lines.push(l), error: (l) => lines.push(`ERR ${l}`) },
    confirm: async () => true,
    secret: async (n) => VALUES[n]!,
    context: () => ctx,
    options: {},
  };
  return { io, calls, lines, dir, ctx };
}
const step = { id: "x", title: "", commands: [] } as never;
const act = (id: string) => remoteActions[id]!;
const argv = (c: Call) => [c.cmd, ...c.args].join(" ");

describe("the registry", () => {
  it("covers the Worker, GitHub and local steps", () => {
    for (const id of ["worker.deploy", "worker.secrets", "github.label", "github.secrets", "github.environment", "local.secrets"]) expect(ACTIONS[id]).toBeTypeOf("function");
  });
});

describe("worker", () => {
  it("deploys through npx wrangler in the worker directory", async () => {
    const h = harness();
    await act("worker.deploy")(h.io, step);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ cmd: "npx", args: ["--yes", "wrangler@4", "deploy"], cwd: join(h.dir, "worker") });
  });

  it("puts both secrets with the value on stdin and never in argv", async () => {
    const h = harness();
    await act("worker.secrets")(h.io, step);
    expect(h.calls.map((c) => c.args.slice(-1)[0])).toEqual(["WEEKPOST_SUPABASE_URL", "WEEKPOST_SUPABASE_KEY"]);
    expect(h.calls.map((c) => c.input)).toEqual([`${URL_}\n`, `${KEY}\n`]);
    for (const c of h.calls) {
      expect(argv(c)).not.toContain(KEY);
      expect(argv(c)).not.toContain(URL_);
      expect(c.cwd).toBe(join(h.dir, "worker"));
    }
    expect(h.lines.join("\n")).not.toContain(KEY);
  });

  it("stops at the first failed secret and does not show the value, even if wrangler echoes it", async () => {
    const h = harness((c) => (c.args.includes("WEEKPOST_SUPABASE_URL") ? { status: 1, stderr: `bad value ${URL_}` } : {}));
    const err = (await act("worker.secrets")(h.io, step).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("wrangler secret put WEEKPOST_SUPABASE_URL failed (exit 1)");
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain(URL_);
    expect(h.calls).toHaveLength(1);
  });

  it("says when the program could not run at all", async () => {
    const h = harness(() => ({ status: null }));
    await expect(act("worker.deploy")(h.io, step)).rejects.toThrow(/could not run/);
  });
});

describe("github", () => {
  it("creates the label named in the config and the label of the metrics issue", async () => {
    const h = harness();
    await act("github.label")(h.io, step);
    expect(h.calls).toHaveLength(2);
    expect(argv(h.calls[0]!)).toBe("gh label create media-ok --description Generate the media preview for this pull request");
    expect(argv(h.calls[1]!)).toBe("gh label create metrics --force --description Weekly Instagram metrics report");
  });

  it("sets the Actions secret from stdin", async () => {
    const h = harness();
    await act("github.secrets")(h.io, step);
    expect(h.calls).toHaveLength(1);
    expect(argv(h.calls[0]!)).toBe("gh secret set OPENROUTER_API_KEY");
    expect(h.calls[0]!.input).toBe(OPENROUTER);
    expect(h.lines.join("\n")).not.toContain(OPENROUTER);
  });

  it("an error from gh does not carry the OpenRouter key", async () => {
    const h = harness(() => ({ status: 1, stderr: `rejected ${OPENROUTER}` }));
    const err = (await act("github.secrets")(h.io, step).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(OPENROUTER);
  });

  it("creates the environment, allows main only, and sets both secrets from stdin", async () => {
    const h = harness((c) => (argv(c).includes("deployment-branch-policies") && !c.args.includes("POST") ? { stdout: '{"branch_policies":[]}' } : {}));
    await act("github.environment")(h.io, step);
    const lines = h.calls.map(argv);
    expect(lines[0]).toBe("gh api -X PUT repos/{owner}/{repo}/environments/weekpost --input -");
    expect(JSON.parse(h.calls[0]!.input!)).toEqual({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    expect(lines).toContain("gh api -X POST repos/{owner}/{repo}/environments/weekpost/deployment-branch-policies --input -");
    expect(JSON.parse(h.calls.find((c) => c.args.includes("POST"))!.input!)).toEqual({ name: "main", type: "branch" });
    const sets = h.calls.filter((c) => c.args[0] === "secret");
    expect(sets.map(argv)).toEqual(["gh secret set WEEKPOST_SUPABASE_URL --env weekpost", "gh secret set WEEKPOST_SUPABASE_KEY --env weekpost"]);
    expect(sets.map((c) => c.input)).toEqual([URL_, KEY]);
    for (const l of lines) expect(l).not.toContain(KEY);
  });

  it("does not create the branch policy again when main is already listed", async () => {
    const h = harness((c) => (c.args.length === 2 && c.args[1]!.endsWith("deployment-branch-policies") ? { stdout: '{"branch_policies":[{"name":"main"}]}' } : {}));
    await act("github.environment")(h.io, step);
    expect(h.calls.some((c) => c.args.includes("POST"))).toBe(false);
  });

  it("stops when GitHub refuses the branch restriction, naming the step", async () => {
    const h = harness((c) => (c.args.includes("PUT") ? { status: 1, stderr: "HTTP 422: not available on this plan" } : {}));
    await expect(act("github.environment")(h.io, step)).rejects.toThrow(/create the environment\) failed \(exit 1\): HTTP 422/);
    expect(h.calls).toHaveLength(1);
  });
});

describe("local.secrets", () => {
  it("writes the file with mode 0600 in a private directory", async () => {
    const h = harness();
    await act("local.secrets")(h.io, step);
    const file = h.ctx.localEnvFile;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8")).toBe(`WEEKPOST_SUPABASE_URL=${URL_}\nWEEKPOST_SUPABASE_KEY=${KEY}\n`);
    expect(h.lines.join("\n")).not.toContain(KEY);
  });

  it("keeps other keys already in the file and replaces a file with a wide mode", async () => {
    const h = harness();
    await act("local.secrets")(h.io, step);
    const file = h.ctx.localEnvFile;
    writeFileSync(file, `EXTRA=1\nWEEKPOST_SUPABASE_KEY=old\n`, { mode: 0o600 });
    await act("local.secrets")(h.io, step);
    expect(readFileSync(file, "utf8")).toContain("EXTRA=1");
    expect(readFileSync(file, "utf8")).toContain(`WEEKPOST_SUPABASE_KEY=${KEY}`);
    writeFileSync(file, `EXTRA=1\n`);
    chmodSync(file, 0o644);
    await act("local.secrets")(h.io, step);
    expect(readFileSync(file, "utf8")).not.toContain("EXTRA");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a Supabase URL that is not https", async () => {
    const h = harness();
    const bad = { ...h.io, secret: async (n: string) => (n === "WEEKPOST_SUPABASE_URL" ? "http://x" : KEY) } as ApplyIO;
    await expect(act("local.secrets")(bad, step)).rejects.toThrow(/https/);
  });
});

describe("through the apply loop", () => {
  it("runs the Worker steps in order after a yes, and a failure never prints a secret", async () => {
    const calls: Call[] = [];
    const lines: string[] = [];
    const dir = tmp();
    const run: Runner = async (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      if (args.includes("secret") && args.includes("WEEKPOST_SUPABASE_KEY")) return { status: 1, stdout: "", stderr: `nope ${KEY}` };
      if (args.includes("put")) return { status: 0, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "" }; // probes: everything unknown/todo
    };
    const ctx = { projectRoot: dir, project: "demo", accounts: [], previewLabel: "media-ok", bucket: "b", latestSchema: 3, localEnvFile: join(dir, "x.env"), supabase: {}, env: { WEEKPOST_SUPABASE_URL: URL_, WEEKPOST_SUPABASE_KEY: KEY },
      run, fetch: (async () => new Response("[]", { status: 404 })) as typeof fetch, hasChromium: async () => true } as unknown as SetupContext;
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    const code = await runApply(ctx, out, async () => true, { actions: ACTIONS, only: "worker.secrets", env: ctx.env });
    expect(code).toBe(1);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).toContain("worker.secrets failed");
    expect(calls.filter((c) => c.args.includes("put")).map((c) => c.input)).toEqual([`${URL_}\n`, `${KEY}\n`]);
  });
});
