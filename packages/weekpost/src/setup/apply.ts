// `weekpost setup --apply`: goes through the steps in order. For each one it probes again, skips what is done,
// shows the exact commands, asks for a yes, runs the action and stops at the first failure without undoing anything.
// The next `--apply` continues from there. It never has a --yes: the caller has already checked for a terminal.
import { readSecret, SecretError } from "../cli/secrets.ts";
import type { Out } from "../cli/check.ts";
import { probe } from "./probes.ts";
import { stepsFor, type SetupContext, type Step, type StepId } from "./steps.ts";

/** A failure whose message is safe to print (an action writes it, never forwarding raw command output). */
export class ApplyError extends Error {}

export type SecretName = "WEEKPOST_SUPABASE_URL" | "WEEKPOST_SUPABASE_KEY" | "OPENROUTER_API_KEY" | "DATABASE_URL";

export type ApplyIO = {
  out: Out;
  /** The value of a secret: the environment or the local file first, else a hidden prompt. Asked once per run. */
  secret(name: SecretName): Promise<string>;
  /** The context with whatever the run has learned so far (the Supabase URL and key typed at a prompt). */
  context(): SetupContext;
  options: { only?: string; print?: boolean };
  /** Asks a yes/no question at the terminal (an action that deletes something asks before it does). */
  confirm(question: string): Promise<boolean>;
};

export type Action = (io: ApplyIO, step: Step) => Promise<void>;
export type Actions = Partial<Record<string, Action>>;

export type ApplyDeps = {
  actions?: Actions;
  confirm?: (question: string) => Promise<boolean>;
  env?: Record<string, string | undefined>;
  /** Hidden prompt for a secret. */
  ask?: (label: string) => Promise<string>;
  only?: string;
  print?: boolean;
};

const LABELS: Record<SecretName, string> = {
  WEEKPOST_SUPABASE_URL: "Supabase project URL (https://<ref>.supabase.co)",
  WEEKPOST_SUPABASE_KEY: "Supabase secret key (sb_secret_..., hidden)",
  OPENROUTER_API_KEY: "OpenRouter API key (hidden)",
  DATABASE_URL: "Postgres connection string (hidden; used once, never saved)",
};

export function stepActionKey(id: StepId): string {
  return id.startsWith("token.") ? "token" : id;
}

/** Returns the exit code: 0 when no step failed, 1 when one did. Steps that need you are listed, not failed. */
export async function runApply(base: SetupContext, out: Out, confirm: (q: string) => Promise<boolean>, deps: ApplyDeps = {}): Promise<number> {
  const actions = deps.actions ?? {};
  const env = deps.env ?? base.env;
  const learned = new Map<SecretName, string>();
  const secret = async (name: SecretName): Promise<string> => {
    const known = learned.get(name);
    if (known) return known;
    const fromCtx = name === "WEEKPOST_SUPABASE_URL" ? base.supabase.url : name === "WEEKPOST_SUPABASE_KEY" ? base.supabase.key : undefined;
    // DATABASE_URL is read from the environment only if the user put it there on purpose; it is never written anywhere.
    const value = fromCtx ?? (await readSecret(name, LABELS[name], { env, ask: deps.ask }));
    learned.set(name, value);
    return value;
  };
  const context = (): SetupContext => ({
    ...base,
    supabase: { url: learned.get("WEEKPOST_SUPABASE_URL") ?? base.supabase.url, key: learned.get("WEEKPOST_SUPABASE_KEY") ?? base.supabase.key },
  });
  const scrub = (text: string) => [...learned.values()].filter(Boolean).reduce((acc, v) => acc.split(v).join("[redacted]"), text);
  const io: ApplyIO = { out, secret, context, options: { only: deps.only, print: deps.print }, confirm };

  const all = stepsFor(base);
  const steps = deps.only ? all.filter((s) => s.id === deps.only) : all;
  if (deps.only && steps.length === 0) {
    out.error(`unknown step "${deps.only}"; the steps are: ${all.map((s) => s.id).join(", ")}`);
    return 1;
  }

  const pending: string[] = [];
  for (const step of steps) {
    const found = await probe(context(), step.id);
    out.log(`\n${step.id}: ${step.title}`);
    if (found.state === "ok") {
      out.log(`  already done (${found.detail})`);
      continue;
    }
    if (found.state === "needs-you") {
      out.log(`  needs you: ${found.detail}${step.guide ? `\n  ${step.guide}` : ""}`);
      pending.push(step.id);
      continue;
    }
    const action = actions[stepActionKey(step.id)];
    if (!action) {
      out.log(`  ${found.detail}\n  no automatic action for this step yet`);
      pending.push(step.id);
      continue;
    }
    out.log(`  ${found.detail}`);
    out.log("  will run:");
    for (const c of step.commands) out.log(`    ${c}`);
    if (!(await confirm(`  run ${step.id}?`))) {
      out.log("  skipped");
      pending.push(step.id);
      continue;
    }
    try {
      await action(io, step);
    } catch (e) {
      const message = e instanceof ApplyError || e instanceof SecretError ? e.message : "the step failed";
      out.error(`${step.id} failed: ${scrub(message)}`);
      out.error("nothing was undone; fix the cause and run `weekpost setup --apply` again, it continues from here");
      return 1;
    }
    out.log("  done");
  }
  if (pending.length) out.log(`\nstill open: ${pending.join(", ")}`);
  else out.log("\nall steps are done");
  return 0;
}
