// Read-only probes, one per step. A probe never writes, never prints a secret and never puts command output
// into its detail line (output can carry account names or tokens): the detail says what was found, in our words.
import { readLocalEnv } from "../cli/secrets.ts";
import { ISSUE_LABEL } from "../metrics/report.ts";
import { WRANGLER_PKG } from "./runner.ts";
import { request, SupabaseError } from "../queue/supabase.ts";
import { ACTIONS_SECRET, ENVIRONMENT, WORKER_SECRETS, stepsFor, type Probe, type SetupContext, type StepId } from "./steps.ts";

const ok = (detail: string): Probe => ({ state: "ok", detail });
const todo = (detail: string): Probe => ({ state: "todo", detail });
const unknown = (detail: string): Probe => ({ state: "unknown", detail });

/** The Supabase URL and key: the environment first, then the local secrets file. Missing parts stay undefined. */
export function supabaseCreds(env: Record<string, string | undefined>, localEnvFile: string): { url?: string; key?: string } {
  let url = env.WEEKPOST_SUPABASE_URL?.trim();
  let key = env.WEEKPOST_SUPABASE_KEY?.trim();
  if (!url || !key) {
    try {
      const local = readLocalEnv(localEnvFile);
      url ||= local.WEEKPOST_SUPABASE_URL?.trim();
      key ||= local.WEEKPOST_SUPABASE_KEY?.trim();
    } catch {
      /* no file, or a wrong mode: the local.secrets probe reports it */
    }
  }
  return { url: url || undefined, key: key || undefined };
}

const NO_CREDS = "no Supabase URL and key yet (set WEEKPOST_SUPABASE_URL and WEEKPOST_SUPABASE_KEY, or run the local.secrets step)";

/** GET on the Supabase REST/storage API; the status is returned instead of thrown for the answers a probe understands. */
async function supabaseGet(ctx: SetupContext, path: string): Promise<{ status: number; body: unknown }> {
  try {
    return await request(ctx.fetch, ctx.supabase.url!.replace(/\/+$/, ""), ctx.supabase.key!, path);
  } catch (e) {
    if (e instanceof SupabaseError) return { status: e.status, body: null };
    throw e;
  }
}

async function names(ctx: SetupContext, args: string[]): Promise<string[] | null> {
  const r = await ctx.run(args[0]!, args.slice(1), { cwd: ctx.projectRoot });
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(list)) return null;
    return list.map((x) => (x as { name?: unknown }).name).filter((n): n is string => typeof n === "string");
  } catch {
    return null;
  }
}

async function logins(ctx: SetupContext): Promise<Probe> {
  const gh = await ctx.run("gh", ["auth", "status"], { cwd: ctx.projectRoot });
  const cf = await ctx.run("npx", ["--yes", WRANGLER_PKG, "whoami"], { cwd: ctx.projectRoot });
  const cfOut = /not authenticated|not logged in/i.test(cf.stdout + cf.stderr);
  const missing = [gh.status === 0 ? "" : "gh (run: gh auth login)", cf.status === 0 && !cfOut ? "" : "wrangler (run: npx wrangler login)"].filter(Boolean);
  return missing.length ? { state: "needs-you", detail: `not logged in: ${missing.join("; ")}` } : ok("gh and wrangler are logged in");
}

async function deps(ctx: SetupContext): Promise<Probe> {
  return (await ctx.hasChromium()) ? ok("Chromium is installed") : todo("Chromium is not installed");
}

/** The version recorded in weekpost_schema: 0 when the table does not exist, null when it cannot be read. */
export async function schemaVersion(ctx: SetupContext): Promise<number | null> {
  if (!ctx.supabase.url || !ctx.supabase.key) return null;
  const r = await supabaseGet(ctx, "/rest/v1/weekpost_schema?select=version");
  if (r.status === 404) return 0;
  if (r.status < 200 || r.status >= 300) return null;
  const rows = Array.isArray(r.body) ? (r.body as { version?: unknown }[]) : [];
  return Math.max(0, ...rows.map((x) => Number(x.version) || 0));
}

async function migrate(ctx: SetupContext): Promise<Probe> {
  if (!ctx.supabase.url || !ctx.supabase.key) return unknown(NO_CREDS);
  const version = await schemaVersion(ctx);
  if (version === null) return unknown("Supabase did not answer as expected; check the URL and the secret key");
  if (version === 0) return todo(`no weekpost_schema table: no migration applied yet (0 of ${ctx.latestSchema})`);
  return version >= ctx.latestSchema ? ok(`schema ${version} of ${ctx.latestSchema}`) : todo(`schema ${version} of ${ctx.latestSchema}: ${ctx.latestSchema - version} migration(s) pending`);
}

async function bucket(ctx: SetupContext): Promise<Probe> {
  if (!ctx.supabase.url || !ctx.supabase.key) return unknown(NO_CREDS);
  const r = await supabaseGet(ctx, `/storage/v1/bucket/${encodeURIComponent(ctx.bucket)}`);
  if (r.status >= 200 && r.status < 300) {
    return (r.body as { public?: unknown } | null)?.public === true ? todo(`bucket "${ctx.bucket}" is public; it must be private`) : ok(`bucket "${ctx.bucket}" exists and is private`);
  }
  // Storage answers a missing bucket with 404 (older versions: 400 "Bucket not found").
  if (r.status === 404 || r.status === 400) return todo(`bucket "${ctx.bucket}" does not exist`);
  return unknown(`Supabase answered ${r.status || "no response"}; check the URL and the secret key`);
}

async function workerSecrets(ctx: SetupContext): Promise<Probe> {
  const r = await ctx.run("npx", ["--yes", WRANGLER_PKG, "secret", "list"], { cwd: `${ctx.projectRoot}/worker` });
  if (r.status !== 0) return unknown("could not list the Worker secrets (not logged in, or the Worker is not deployed yet)");
  let have: string[];
  try {
    have = (JSON.parse(r.stdout) as { name?: string }[]).map((s) => String(s.name));
  } catch {
    return unknown("could not read the list of Worker secrets");
  }
  const missing = WORKER_SECRETS.filter((n) => !have.includes(n));
  return missing.length ? todo(`missing on the Worker: ${missing.join(", ")}`) : ok("both Worker secrets are set");
}

async function label(ctx: SetupContext): Promise<Probe> {
  const list = await names(ctx, ["gh", "label", "list", "--json", "name", "--limit", "200"]);
  if (!list) return unknown("could not list the labels (gh not logged in, or this is not a GitHub repository)");
  const missing = [ctx.previewLabel, ISSUE_LABEL].filter((l) => !list.includes(l));
  return missing.length ? todo(`label ${missing.map((l) => `"${l}"`).join(", ")} does not exist`) : ok(`labels "${ctx.previewLabel}" and "${ISSUE_LABEL}" exist`);
}

async function actionsSecrets(ctx: SetupContext): Promise<Probe> {
  const list = await names(ctx, ["gh", "secret", "list", "--json", "name"]);
  if (!list) return unknown("could not list the repository secrets (gh not logged in, or no admin access)");
  return list.includes(ACTIONS_SECRET) ? ok(`${ACTIONS_SECRET} is set`) : todo(`${ACTIONS_SECRET} is not set`);
}

async function environment(ctx: SetupContext): Promise<Probe> {
  const r = await ctx.run("gh", ["api", `repos/{owner}/{repo}/environments/${ENVIRONMENT}`], { cwd: ctx.projectRoot });
  if (r.status !== 0) return /404|Not Found/i.test(r.stderr + r.stdout) ? todo(`environment "${ENVIRONMENT}" does not exist`) : unknown("could not read the environment (gh not logged in, or no admin access)");
  let env: { deployment_branch_policy?: { custom_branch_policies?: boolean } | null };
  try {
    env = JSON.parse(r.stdout);
  } catch {
    return unknown("could not read the environment");
  }
  const problems: string[] = [];
  if (!env.deployment_branch_policy?.custom_branch_policies) problems.push("deployments are not restricted to a branch list");
  if (env.deployment_branch_policy?.custom_branch_policies) {
    // The flag alone is not enough: an older policy such as "*" lets any branch deploy with the secrets.
    const pol = await ctx.run("gh", ["api", `repos/{owner}/{repo}/environments/${ENVIRONMENT}/deployment-branch-policies`], { cwd: ctx.projectRoot });
    let listed: string[] | null = null;
    try {
      const body = JSON.parse(pol.stdout) as { branch_policies?: { name?: unknown }[] };
      if (pol.status === 0 && Array.isArray(body.branch_policies)) listed = body.branch_policies.map((p) => String(p.name));
    } catch {
      /* unreadable */
    }
    if (!listed) return unknown("could not read the environment's branch policies");
    if (!listed.includes("main")) problems.push("main is not in the environment's branch policies");
    if (listed.some((n) => n !== "main")) problems.push("the environment also allows other branch policies than main to deploy");
  }
  const secrets = await names(ctx, ["gh", "secret", "list", "--env", ENVIRONMENT, "--json", "name"]);
  if (!secrets) return unknown("could not list the environment secrets");
  const missing = WORKER_SECRETS.filter((n) => !secrets.includes(n));
  if (missing.length) problems.push(`missing secrets: ${missing.join(", ")}`);
  return problems.length ? todo(problems.join("; ")) : ok(`environment "${ENVIRONMENT}" allows deployments only from main and has both secrets`);
}

function localSecrets(ctx: SetupContext): Probe {
  let values: Record<string, string>;
  try {
    values = readLocalEnv(ctx.localEnvFile);
  } catch (e) {
    return todo(String((e as Error).message).replace(/ has mode .*/, " is missing or has a mode wider than 0600"));
  }
  const missing = WORKER_SECRETS.filter((n) => !values[n]);
  return missing.length ? todo(`the local file lacks ${missing.join(", ")}`) : ok("the local secrets file exists with mode 0600");
}

async function token(ctx: SetupContext, account: string): Promise<Probe> {
  if (!ctx.supabase.url || !ctx.supabase.key) return unknown(NO_CREDS);
  // Only the account column is requested: the token column never leaves the database in a probe.
  const r = await supabaseGet(ctx, `/rest/v1/weekpost_tokens?select=account&account=eq.${encodeURIComponent(account)}`);
  if (r.status === 404) return { state: "needs-you", detail: "the database has no weekpost_tokens table yet (run db.migrate first)" };
  if (r.status < 200 || r.status >= 300) return unknown(`Supabase answered ${r.status || "no response"}`);
  return Array.isArray(r.body) && r.body.length > 0 ? ok("a token is saved") : { state: "needs-you", detail: "no token saved yet" };
}

/** Runs the probe of one step. A probe that throws is reported as `unknown`, with a fixed message (never the error text). */
export async function probe(ctx: SetupContext, id: StepId): Promise<Probe> {
  try {
    switch (id) {
      case "prereq.logins": return await logins(ctx);
      case "project.deps": return await deps(ctx);
      case "db.migrate": return await migrate(ctx);
      case "storage.bucket": return await bucket(ctx);
      case "worker.deploy": return unknown("cannot tell what is deployed; deploying again is safe");
      case "worker.secrets": return await workerSecrets(ctx);
      case "github.label": return await label(ctx);
      case "github.secrets": return await actionsSecrets(ctx);
      case "github.environment": return await environment(ctx);
      case "local.secrets": return localSecrets(ctx);
      default: return await token(ctx, id.slice("token.".length));
    }
  } catch {
    return unknown("the check failed unexpectedly");
  }
}

export type StepReport = { id: StepId; title: string; state: Probe["state"]; detail: string; commands: string[]; guide?: string };

/** Probes every step, in order. Read-only. */
export async function planSteps(ctx: SetupContext): Promise<StepReport[]> {
  const out: StepReport[] = [];
  for (const s of stepsFor(ctx)) {
    const p = await probe(ctx, s.id);
    out.push({ id: s.id, title: s.title, state: p.state, detail: p.detail, commands: s.commands, ...(s.guide ? { guide: s.guide } : {}) });
  }
  return out;
}
