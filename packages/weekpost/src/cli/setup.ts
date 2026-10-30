// weekpost setup --plan [--json] [--project=<dir>]
// weekpost setup --apply [--only=<step-id>] [--print] [--project=<dir>]
// `--plan` only reads: it lists every step, whether it is done, and the exact commands `--apply` would run.
// `--apply` writes outside the repository (database, Worker, GitHub, local secrets), so it needs a terminal and asks
// before each step; there is no --yes. An agent shell has no terminal, so an agent can run --plan but never --apply.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import { ACTIONS } from "../setup/actions.ts";
import { runApply, type ApplyDeps } from "../setup/apply.ts";
import { planSteps, supabaseCreds, type StepReport } from "../setup/probes.ts";
import { spawnRunner } from "../setup/runner.ts";
import { DEFAULT_BUCKET, type SetupContext } from "../setup/steps.ts";
import { projectPaths, type Out } from "./check.ts";
import { optionOf } from "./queueCommon.ts";
import { hasTty, legacyLocalEnvPath, localEnvPath, migrateLocalEnv, requireTty, SecretError } from "./secrets.ts";

const USAGE = "usage: weekpost setup --plan [--json] | --apply [--only=<step-id>] [--print]   (--project=<dir>)";
const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

export type SetupDeps = Partial<Pick<SetupContext, "run" | "fetch" | "hasChromium" | "env">> & {
  tty?: boolean;
  /** Home directory of the local secrets file. Default: the real one; tests pass a temporary one. */
  home?: string;
  /** Skips reading weekpost.config.ts (tests). */
  config?: Pick<WeekpostConfig, "accounts" | "ci">;
  /** Overrides the context built from the project (tests). */
  context?: Partial<SetupContext>;
  apply?: ApplyDeps;
  confirm?: (question: string) => Promise<boolean>;
};

/** The highest NNNN in migrations/NNNN_*.sql. */
export function latestMigration(dir: string = MIGRATIONS_DIR): number {
  return Math.max(0, ...readdirSync(dir).map((f) => /^(\d{4})_.*\.sql$/.exec(f)?.[1]).filter((n): n is string => !!n).map(Number));
}

async function playwrightChromium(): Promise<boolean> {
  try {
    const { chromium } = await import("@playwright/test");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

async function ttyConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

const GLYPH = { ok: "ok       ", todo: "todo     ", "needs-you": "needs-you", unknown: "unknown  " } as const;

export function renderPlan(steps: StepReport[], out: Out): void {
  out.log("weekpost setup --plan: nothing is written; this is what `weekpost setup --apply` would do\n");
  for (const s of steps) {
    out.log(`[${GLYPH[s.state]}] ${s.id}: ${s.title}`);
    out.log(`            ${s.detail}`);
    if (s.state === "ok") continue;
    if (s.state === "needs-you" && s.guide) out.log(`            you: ${s.guide}`);
    else {
      out.log("            will run:");
      for (const c of s.commands) out.log(`              ${c}`);
    }
  }
  const counts = (st: StepReport["state"]) => steps.filter((s) => s.state === st).length;
  out.log(`\n${counts("ok")} done, ${counts("todo")} to do, ${counts("needs-you")} need you, ${counts("unknown")} unknown`);
}

/** The context every probe and action works from: the config, the credentials we can find, and the injected effects. */
export async function buildContext(projectRoot: string, deps: SetupDeps = {}, migrate = false): Promise<SetupContext> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? (await loadConfig(projectRoot)).config;
  const project = basename(projectRoot);
  // Only `--apply` copies a file written under the old name; plan and doctor read it where it is and write nothing.
  const home = deps.home ?? homedir();
  let localEnvFile = localEnvPath(projectRoot, home);
  if (migrate) localEnvFile = migrateLocalEnv(projectRoot, home);
  else {
    const legacy = legacyLocalEnvPath(projectRoot, home);
    if (legacy && !existsSync(localEnvFile) && existsSync(legacy)) localEnvFile = legacy;
  }
  return {
    projectRoot,
    project,
    accounts: Object.entries(config.accounts).map(([id, a]) => ({ id, handle: a.handle })),
    previewLabel: config.ci.previewLabel,
    bucket: env.WEEKPOST_BUCKET || DEFAULT_BUCKET,
    latestSchema: latestMigration(),
    localEnvFile,
    supabase: supabaseCreds(env, localEnvFile),
    env,
    run: deps.run ?? spawnRunner,
    fetch: deps.fetch ?? fetch,
    hasChromium: deps.hasChromium ?? playwrightChromium,
    ...deps.context,
  };
}

// Returns the exit code.
export async function runSetup(args: string[], out: Out = console, cwd = process.cwd(), deps: SetupDeps = {}): Promise<number> {
  const plan = args.includes("--plan");
  const apply = args.includes("--apply");
  if (args.includes("--yes") || args.includes("-y")) {
    out.error("setup has no --yes: it writes outside the repository, so it always asks you at a terminal");
    return 2;
  }
  if (plan === apply) {
    out.error(USAGE);
    return 2;
  }
  if (apply) {
    const blocked = requireTty("setup --apply", out, deps.tty ?? hasTty());
    if (blocked) return blocked;
  }

  const { projectRoot } = projectPaths(args, cwd);
  let ctx: SetupContext;
  try {
    ctx = await buildContext(projectRoot, deps, apply);
  } catch (e) {
    out.error(e instanceof ConfigError || e instanceof SecretError ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }

  if (plan) {
    const steps = await planSteps(ctx);
    if (args.includes("--json")) out.log(JSON.stringify({ steps }, null, 2));
    else renderPlan(steps, out);
    return 0;
  }
  return runApply(ctx, out, deps.confirm ?? ttyConfirm, {
    actions: ACTIONS,
    only: optionOf(args, "only"),
    print: args.includes("--print"),
    ...deps.apply,
  });
}
