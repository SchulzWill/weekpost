// Shared by the queue commands (`status`, `cancel`, `reschedule`, `resolve`): option parsing, the Supabase
// connection from the environment, account time zones from the config, and the confirmation prompt.
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import { supabaseDb } from "../queue/supabase.ts";
import type { Change } from "../queue/operate.ts";
import { label, type Zones } from "../queue/operate.ts";
import type { OperatorDb } from "../queue/types.ts";
import { projectPaths, type Out } from "./check.ts";
import { hasTty, NO_TTY_ENV_HINT, withLocalEnv } from "./secrets.ts";

export type OperateDeps = {
  db?: OperatorDb;
  /** Account id -> IANA zone. Default: read from weekpost.config.ts. */
  zones?: Zones;
  confirm?: (question: string) => Promise<boolean>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** Home directory the local secrets file is read from. Default: the real one; tests pass a temporary one. */
  home?: string;
  /** Whether there is a terminal. Default: the real one. Writing commands read the local secrets file only with one. */
  tty?: boolean;
};

export const optionOf = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
export const positional = (args: string[]) => args.filter((a) => !a.startsWith("--"));

export async function connect(args: string[], out: Out, cwd: string, deps: OperateDeps, writes = true): Promise<{ db: OperatorDb; zones: Zones } | null> {
  let zones = deps.zones;
  if (!zones) {
    try {
      const { config } = await loadConfig(projectPaths(args, cwd).projectRoot);
      zones = Object.fromEntries(Object.entries(config.accounts).map(([id, a]) => [id, a.timeZone]));
    } catch (e) {
      out.error(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`);
      return null;
    }
  }
  if (deps.db) return { db: deps.db, zones };
  const tty = deps.tty ?? hasTty();
  const env = withLocalEnv(deps.env ?? process.env, projectPaths(args, cwd).projectRoot, deps.home, writes ? { tty } : undefined);
  try {
    return { db: supabaseDb(env.WEEKPOST_SUPABASE_URL ?? "", env.WEEKPOST_SUPABASE_KEY ?? ""), zones };
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    if (writes && !tty) out.error(NO_TTY_ENV_HINT);
    return null;
  }
}

async function ttyConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Shows before and after for each change. Without --yes, asks first; without a terminal, refuses. */
export async function confirmChanges(args: string[], changes: Extract<Change, { ok: true }>[], verb: string, out: Out, deps: OperateDeps): Promise<boolean> {
  for (const c of changes) {
    out.log(`${label(c.key)}`);
    out.log(`  before: ${c.before}`);
    out.log(`  after:  ${c.after}`);
  }
  if (args.includes("--yes")) return true;
  const ask = deps.confirm ?? ttyConfirm;
  if (await ask(`${verb} ${changes.length} row(s)?`)) return true;
  out.error(deps.confirm || process.stdin.isTTY ? "nothing changed" : "nothing changed: no terminal to confirm on; pass --yes");
  return false;
}
