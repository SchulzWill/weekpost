// weekpost doctor [--json] [--project=<dir>]
// Checks, item by item and without writing anything, that everything `setup` and `token` put in place is there and
// working. Every line is ok, warn or fail; a failing line says what to run. Exits 0 when nothing fails (warnings are
// things to look at, not blockers). No secret is ever printed: not a key, not a token, not a command's output.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../config/parse.ts";
import { GRAPH_API_VERSION, GraphError, InstagramGraph, redact } from "../publisher/instagram.ts";
import { supabaseDb } from "../queue/supabase.ts";
import type { PublisherDb } from "../queue/types.ts";
import { probe } from "../setup/probes.ts";
import { WRANGLER_PKG } from "../setup/runner.ts";
import { graphVersionStatus } from "../setup/graphVersions.ts";
import { stepsFor, type SetupContext, type StepId } from "../setup/steps.ts";
import { projectPaths, type Out } from "./check.ts";
import { buildContext, type SetupDeps } from "./setup.ts";
import { SecretError } from "./secrets.ts";

export type Level = "ok" | "warn" | "fail";
export type Check = { id: string; level: Level; detail: string; fix?: string };

export type DoctorDeps = SetupDeps & {
  now?: () => Date;
  nodeVersion?: string;
  /** Token rows. Default: read from Supabase with the server key. */
  db?: Pick<PublisherDb, "tokens">;
};

const DAY = 86_400_000;
const MIN_TOKEN_DAYS = 7;
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const SHA = /^[0-9a-f]{40}$/;
const setupFix = (id: string) => `npx weekpost setup --apply --only=${id}`;

/** A step probe as a doctor line: done is ok, undone is a failure with the command, unreadable is a warning. */
async function fromProbe(ctx: SetupContext, id: StepId, label: string = id): Promise<Check> {
  const p = await probe(ctx, id);
  if (p.state === "ok") return { id: label, level: "ok", detail: p.detail };
  if (p.state === "unknown") return { id: label, level: "warn", detail: p.detail };
  const guide = stepsFor(ctx).find((s) => s.id === id)?.guide;
  return { id: label, level: "fail", detail: p.detail, fix: p.state === "needs-you" && guide ? guide : setupFix(id) };
}

function nodeCheck(version: string): Check {
  const major = Number(version.split(".")[0]);
  return major >= 22 ? { id: "node", level: "ok", detail: `Node ${version}` } : { id: "node", level: "fail", detail: `Node ${version}; weekpost needs 22 or newer`, fix: "install Node 22 or newer" };
}

async function openrouterCheck(ctx: SetupContext): Promise<Check> {
  const id = "openrouter";
  const key = ctx.env.OPENROUTER_API_KEY?.trim();
  if (!key) return { id, level: "warn", detail: "OPENROUTER_API_KEY is not set in this shell, so the key was not checked (it is set as an Actions secret)", fix: "export OPENROUTER_API_KEY=... and run doctor again" };
  try {
    const res = await ctx.fetch(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${key}` } });
    if (res.status === 401 || res.status === 403) return { id, level: "fail", detail: "OpenRouter rejected the key", fix: "create a new key at https://openrouter.ai/settings/keys, then: npx weekpost setup --apply --only=github.secrets" };
    if (!res.ok) return { id, level: "warn", detail: `OpenRouter answered ${res.status}; the key was not checked` };
    const data = ((await res.json()) as { data?: { limit?: number | null } }).data;
    if (data?.limit == null) return { id, level: "warn", detail: "the key is valid but has no credit limit", fix: "set a credit limit on the key at https://openrouter.ai/settings/keys" };
    return { id, level: "ok", detail: "the key is valid and has a credit limit" };
  } catch {
    return { id, level: "warn", detail: "could not reach OpenRouter; the key was not checked" };
  }
}

function keyTypeCheck(ctx: SetupContext): Check {
  const id = "supabase.key";
  const key = ctx.supabase.key;
  if (!key) return { id, level: "warn", detail: "no Supabase key found (WEEKPOST_SUPABASE_KEY or the local secrets file)", fix: setupFix("local.secrets") };
  if (key.startsWith("sb_secret_")) return { id, level: "ok", detail: "a secret key (sb_secret_...)" };
  if (key.startsWith("sb_publishable_")) return { id, level: "fail", detail: "this is a publishable key; weekpost needs the secret key", fix: "copy the sb_secret_... key from the API keys page of your Supabase project" };
  if (key.split(".").length === 3) return { id, level: "warn", detail: "a legacy JWT key; it works, but a secret key (sb_secret_...) can be rotated on its own", fix: "create a secret key in the API keys page of your Supabase project" };
  return { id, level: "fail", detail: "the key is not in a format Supabase uses", fix: "copy the sb_secret_... key from the API keys page of your Supabase project" };
}

async function workerCheck(ctx: SetupContext): Promise<Check> {
  const id = "worker.deployed";
  const fix = "npx weekpost setup --apply --only=worker.deploy";
  const r = await ctx.run("npx", ["--yes", WRANGLER_PKG, "deployments", "list", "--json"], { cwd: join(ctx.projectRoot, "worker") });
  if (r.status !== 0) return { id, level: "fail", detail: "could not list the Worker deployments (not deployed yet, or not logged in to Cloudflare)", fix };
  try {
    const list = JSON.parse(r.stdout) as unknown;
    if (Array.isArray(list)) return list.length ? { id, level: "ok", detail: `the Worker has ${list.length} deployment(s)` } : { id, level: "fail", detail: "the Worker has no deployments", fix };
  } catch {
    /* not JSON */
  }
  return { id, level: "warn", detail: "wrangler answered, but its list could not be read" };
}

async function tokenChecks(ctx: SetupContext, deps: DoctorDeps, now: Date): Promise<Check[]> {
  const out: Check[] = [];
  const { url, key } = ctx.supabase;
  if (!url || !key) return ctx.accounts.map((a) => ({ id: `token.${a.id}`, level: "warn" as const, detail: "no Supabase credentials, so the token was not checked" }));
  let tokens;
  try {
    tokens = await (deps.db ?? supabaseDb(url, key, ctx.fetch)).tokens();
  } catch {
    return ctx.accounts.map((a) => ({ id: `token.${a.id}`, level: "warn" as const, detail: "could not read weekpost_tokens" }));
  }
  const graph = new InstagramGraph(ctx.fetch);
  for (const a of ctx.accounts) {
    const id = `token.${a.id}`;
    const fix = `npx weekpost token ${a.id}`;
    const row = tokens.find((t) => t.account === a.id);
    if (!row) {
      out.push({ id, level: "fail", detail: `no token saved for @${a.handle}`, fix });
      continue;
    }
    const secret = row.accessToken;
    const safe = (e: unknown) => redact(String((e as Error)?.message ?? e), secret).slice(0, 200);
    const days = Math.floor((Date.parse(row.expiresAt) - now.getTime()) / DAY);
    let me: { userId: string; username: string };
    try {
      me = await graph.me(secret);
    } catch (e) {
      out.push({ id, level: "fail", detail: `Instagram did not accept the saved token: ${safe(e)}`, fix });
      continue;
    }
    if (me.username.toLowerCase() !== a.handle.toLowerCase()) {
      out.push({ id, level: "fail", detail: `the saved token belongs to @${me.username}, not @${a.handle}`, fix });
      continue;
    }
    try {
      await graph.publishingLimit(me.userId, secret);
    } catch (e) {
      out.push({ id, level: "fail", detail: e instanceof GraphError ? `the token cannot publish: ${safe(e)}` : "could not check publishing permission", fix });
      continue;
    }
    if (!(days > MIN_TOKEN_DAYS)) {
      out.push({ id, level: "fail", detail: days < 0 ? "the saved token has expired" : `the saved token expires in ${days} day(s)`, fix });
      continue;
    }
    out.push({ id, level: "ok", detail: `@${a.handle}: token works, can publish, ${days} days left` });
  }
  return out;
}

/** Workflow `uses:` lines that name a tag or branch instead of a full commit SHA. */
export function unpinnedActions(projectRoot: string): { files: number; unpinned: string[] } {
  const dir = join(projectRoot, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return { files: 0, unpinned: [] };
  }
  const unpinned: string[] = [];
  for (const f of names) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      const m = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line);
      const ref = m?.[1];
      if (!ref || ref.startsWith("./") || ref.startsWith("docker://")) continue;
      const at = ref.lastIndexOf("@");
      if (at < 0 || !SHA.test(ref.slice(at + 1))) unpinned.push(`${f}: ${ref}`);
    }
  }
  return { files: names.length, unpinned };
}

function workflowCheck(ctx: SetupContext): Check {
  const id = "github.workflows";
  const { files, unpinned } = unpinnedActions(ctx.projectRoot);
  if (!files) return { id, level: "warn", detail: "no workflow files in .github/workflows", fix: "npx weekpost init   (copies the workflows)" };
  if (unpinned.length) return { id, level: "fail", detail: `actions not pinned to a commit SHA: ${unpinned.join("; ")}`, fix: "replace each tag with the full commit SHA of that release (the jobs run with your secrets)" };
  return { id, level: "ok", detail: "every action is pinned to a commit SHA" };
}

/** Runs every check. Read-only. */
export async function runChecks(ctx: SetupContext, deps: DoctorDeps = {}): Promise<Check[]> {
  const now = (deps.now ?? (() => new Date()))();
  const checks: Check[] = [nodeCheck(deps.nodeVersion ?? process.versions.node)];
  checks.push(await fromProbe(ctx, "project.deps", "chromium"));
  checks.push(await fromProbe(ctx, "prereq.logins", "logins"));
  checks.push(await openrouterCheck(ctx));
  checks.push(keyTypeCheck(ctx));
  checks.push(await fromProbe(ctx, "db.migrate", "supabase.schema"));
  checks.push(await fromProbe(ctx, "storage.bucket", "supabase.bucket"));
  checks.push(await workerCheck(ctx));
  checks.push(await fromProbe(ctx, "worker.secrets", "secrets.worker"));
  checks.push(await fromProbe(ctx, "github.secrets", "secrets.actions"));
  checks.push(await fromProbe(ctx, "github.environment", "secrets.environment"));
  checks.push(await fromProbe(ctx, "local.secrets", "secrets.local"));
  checks.push(await fromProbe(ctx, "github.label", "github.label"));
  checks.push(workflowCheck(ctx));
  checks.push(...(await tokenChecks(ctx, deps, now)));
  const g = graphVersionStatus(GRAPH_API_VERSION, now);
  checks.push({ id: "graph.version", level: g.level, detail: g.detail, ...(g.level === "ok" ? {} : { fix: "set graphVersion in the run options, or update weekpost" }) });
  return checks;
}

// Returns the exit code.
export async function runDoctor(args: string[], out: Out = console, cwd = process.cwd(), deps: DoctorDeps = {}): Promise<number> {
  const { projectRoot } = projectPaths(args, cwd);
  let ctx: SetupContext;
  try {
    ctx = await buildContext(projectRoot, deps);
  } catch (e) {
    const detail = e instanceof ConfigError || e instanceof SecretError ? e.message : `error: ${(e as Error).message}`;
    const checks: Check[] = [{ id: "config", level: "fail", detail, fix: "fix weekpost.config.ts (run: npx weekpost check)" }];
    render(checks, args.includes("--json"), out);
    return 1;
  }
  const checks = await runChecks(ctx, deps);
  render(checks, args.includes("--json"), out);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

function render(checks: Check[], json: boolean, out: Out): void {
  if (json) {
    out.log(JSON.stringify({ ok: !checks.some((c) => c.level === "fail"), checks }, null, 2));
    return;
  }
  for (const c of checks) {
    out.log(`${c.level.padEnd(4)}  ${c.id}: ${c.detail}`);
    if (c.fix && c.level !== "ok") out.log(`      fix: ${c.fix}`);
  }
  const n = (l: Level) => checks.filter((c) => c.level === l).length;
  out.log(`\n${n("ok")} ok, ${n("warn")} warning(s), ${n("fail")} failing`);
}
