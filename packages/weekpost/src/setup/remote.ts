// `--apply` actions for the Worker, GitHub and the local secrets file. Every secret value reaches `wrangler` and `gh`
// on stdin (never in argv, where `ps` and the shell history would show it) and is held in memory only for the call.
// The text of a failure never includes the output of the program unless it has been scrubbed of every value we hold.
import { join } from "node:path";
import { readLocalEnv, writeLocalEnv } from "../cli/secrets.ts";
import { ApplyError, type Action, type Actions, type ApplyIO } from "./apply.ts";
import { WRANGLER_PKG, type RunResult } from "./runner.ts";
import { ISSUE_LABEL } from "../metrics/report.ts";
import { ACTIONS_SECRET, ENVIRONMENT, WORKER_SECRETS } from "./steps.ts";

const WRANGLER = ["--yes", WRANGLER_PKG];
const workerDir = (io: ApplyIO) => join(io.context().projectRoot, "worker");

/** Last few hundred characters of what a program said, with each held value removed. */
function tail(r: RunResult, secrets: string[]): string {
  const text = `${r.stderr}\n${r.stdout}`.trim().split("\n").slice(-4).join(" | ");
  return secrets.filter(Boolean).reduce((acc, v) => acc.split(v).join("[redacted]"), text).slice(0, 300);
}

async function must(io: ApplyIO, what: string, cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}, secrets: string[] = []): Promise<RunResult> {
  const r = await io.context().run(cmd, args, opts);
  if (r.status !== 0) {
    const said = tail(r, secrets);
    throw new ApplyError(`${what} failed${r.status === null ? " (could not run)" : ` (exit ${r.status})`}${said ? `: ${said}` : ""}`);
  }
  return r;
}

const supabaseValues = async (io: ApplyIO) => ({
  url: await io.secret("WEEKPOST_SUPABASE_URL"),
  key: await io.secret("WEEKPOST_SUPABASE_KEY"),
});

const workerDeploy: Action = async (io) => {
  await must(io, "wrangler deploy", "npx", [...WRANGLER, "deploy"], { cwd: workerDir(io) });
  io.out.log("  Worker deployed");
};

const workerSecrets: Action = async (io) => {
  const { url, key } = await supabaseValues(io);
  const values: Record<string, string> = { WEEKPOST_SUPABASE_URL: url, WEEKPOST_SUPABASE_KEY: key };
  for (const name of WORKER_SECRETS) {
    await must(io, `wrangler secret put ${name}`, "npx", [...WRANGLER, "secret", "put", name], { cwd: workerDir(io), input: `${values[name]}\n` }, [url, key]);
    io.out.log(`  ${name} set on the Worker`);
  }
};

const githubLabel: Action = async (io) => {
  const label = io.context().previewLabel;
  await must(io, "gh label create", "gh", ["label", "create", label, "--description", "Generate the media preview for this pull request"], { cwd: io.context().projectRoot });
  io.out.log(`  label "${label}" created`);
  // --force: the label may already exist (it is only updated), and the weekly issue needs it.
  await must(io, "gh label create", "gh", ["label", "create", ISSUE_LABEL, "--force", "--description", "Weekly Instagram metrics report"], { cwd: io.context().projectRoot });
  io.out.log(`  label "${ISSUE_LABEL}" created`);
};

const githubSecrets: Action = async (io) => {
  const value = await io.secret("OPENROUTER_API_KEY");
  await must(io, `gh secret set ${ACTIONS_SECRET}`, "gh", ["secret", "set", ACTIONS_SECRET], { cwd: io.context().projectRoot, input: value }, [value]);
  io.out.log(`  ${ACTIONS_SECRET} set`);
};

const githubEnvironment: Action = async (io) => {
  const { url, key } = await supabaseValues(io);
  const cwd = io.context().projectRoot;
  const env = `repos/{owner}/{repo}/environments/${ENVIRONMENT}`;
  const json = (o: unknown) => JSON.stringify(o);
  const secrets = [url, key];

  // Deployments only from a list of branches, and main is the list. (Not verified: that a private repository on the
  // free plan enforces it. GitHub answers with an error when the plan does not allow it, and we stop there.)
  await must(io, "gh api (create the environment)", "gh", ["api", "-X", "PUT", env, "--input", "-"], { cwd, input: json({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }) }, secrets);
  // The environment may already exist with older policies ("*", "content/*") that let other branches deploy with the
  // secrets. Only main may stay; the others are shown and removed after a confirmation.
  const listed = await must(io, "gh api (list the branch policies)", "gh", ["api", `${env}/deployment-branch-policies`], { cwd }, secrets);
  let policies: { id?: number; name?: string }[];
  try {
    policies = (JSON.parse(listed.stdout) as { branch_policies?: { id?: number; name?: string }[] }).branch_policies ?? [];
  } catch {
    throw new ApplyError("could not read the environment's branch policies, so cannot tell whether only main may deploy");
  }
  const others = policies.filter((p) => p.name !== "main");
  if (others.length) {
    io.out.log(`  the environment also allows these branches to deploy with its secrets: ${others.map((p) => p.name).join(", ")}`);
    if (!(await io.confirm(`  remove ${others.length === 1 ? "that policy" : "those policies"} so only main is allowed?`))) {
      throw new ApplyError("the environment still has branch policies other than main; nothing else was changed");
    }
    for (const p of others) {
      if (typeof p.id !== "number") throw new ApplyError("a branch policy has no id, so it cannot be removed");
      await must(io, "gh api (remove a branch policy)", "gh", ["api", "-X", "DELETE", `${env}/deployment-branch-policies/${p.id}`], { cwd }, secrets);
    }
  }
  if (!policies.some((p) => p.name === "main")) await must(io, "gh api (allow main)", "gh", ["api", "-X", "POST", `${env}/deployment-branch-policies`, "--input", "-"], { cwd, input: json({ name: "main", type: "branch" }) }, secrets);

  const values: Record<string, string> = { WEEKPOST_SUPABASE_URL: url, WEEKPOST_SUPABASE_KEY: key };
  for (const name of WORKER_SECRETS) {
    await must(io, `gh secret set ${name} --env ${ENVIRONMENT}`, "gh", ["secret", "set", name, "--env", ENVIRONMENT], { cwd, input: values[name] }, secrets);
    io.out.log(`  ${name} set in the environment`);
  }
  io.out.log(`  environment "${ENVIRONMENT}" restricted to main`);
};

const localSecrets: Action = async (io) => {
  const { url, key } = await supabaseValues(io);
  if (!/^https:\/\/\S+$/.test(url)) throw new ApplyError("the Supabase URL must start with https://");
  const file = io.context().localEnvFile;
  let existing: Record<string, string> = {};
  try {
    existing = readLocalEnv(file); // keep other keys the user put there; a file we cannot trust is replaced
  } catch {
    /* missing, or a wider mode than 0600 */
  }
  writeLocalEnv(file, { ...existing, WEEKPOST_SUPABASE_URL: url, WEEKPOST_SUPABASE_KEY: key });
  io.out.log(`  wrote ${file} (mode 0600)`);
};

export const remoteActions: Actions = {
  "worker.deploy": workerDeploy,
  "worker.secrets": workerSecrets,
  "github.label": githubLabel,
  "github.secrets": githubSecrets,
  "github.environment": githubEnvironment,
  "local.secrets": localSecrets,
};
