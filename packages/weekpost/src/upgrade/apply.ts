// `weekpost upgrade --apply`: carries out what `--plan` showed. The order matters: the database first (a failure
// stops everything with your files untouched), then the files, then the lock, then the Worker. Every step can be
// run again after an interruption, and a second run on a finished upgrade changes nothing.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { buildContext } from "../cli/setup.ts";
import type { Out } from "../cli/check.ts";
import { ACTIONS } from "../setup/actions.ts";
import { runApply } from "../setup/apply.ts";
import { buildLock, LOCK_FILE, serializeLock, sha256 } from "../setup/template.ts";
import { planUpgradeFull, type PlanDeps } from "./plan.ts";

/** What to do with a file you edited and the new version also changes. */
export type Choice = "keep" | "take" | "side";

export type ApplyUpgradeDeps = PlanDeps & {
  /** Asks a yes/no question at the terminal. Default: a `[y/N]` prompt (no is the default). */
  confirm?: (question: string) => Promise<boolean>;
  /** Asks what to do with an edited file. Default: a prompt where Enter keeps your version. */
  choose?: (question: string) => Promise<Choice>;
  /** The step runner of `setup --apply` (tests replace it). */
  runApply?: typeof runApply;
  /** Print the migration SQL instead of running it. */
  print?: boolean;
};

export const SIDE_SUFFIX = ".weekpost-new";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

const ttyConfirm = async (question: string) => /^y(es)?$/.test(await ask(`${question} [y/N] `));
const ttyChoose = async (question: string): Promise<Choice> => {
  const answer = await ask(`${question}\n  [k] keep my version (default)   [n] take the new version   [s] save the new one next to it as <file>${SIDE_SUFFIX}\n  choice: `);
  return answer.startsWith("n") ? "take" : answer.startsWith("s") ? "side" : "keep";
};

/** Returns the exit code: 0 done or nothing to do, 1 stopped (blocked or a step failed or was declined). */
export async function applyUpgrade(projectRoot: string, out: Out, deps: ApplyUpgradeDeps = {}): Promise<number> {
  const confirm = deps.confirm ?? ttyConfirm;
  const choose = deps.choose ?? ttyChoose;
  const steps = deps.runApply ?? runApply;
  const { plan, inputs } = await planUpgradeFull(projectRoot, deps);
  const { lock, answers, today, next, installed } = inputs;

  if (plan.blocked || !answers || !plan.files) {
    out.error(`Not upgrading: ${plan.blockers.length} problem(s) block it. Nothing was changed.`);
    for (const b of plan.blockers) out.error(`  ${b.message}`);
    out.error("Fix them, commit, and run `weekpost upgrade --plan` to see the result.");
    return 1;
  }

  const pending = plan.migrations?.pending ?? [];
  if (lock && plan.lockVersion === installed && plan.toChange === 0 && pending.length === 0) {
    out.log(`Already up to date on weekpost ${installed}. Nothing was changed.`);
    return 0;
  }

  out.log(`Upgrading this project from weekpost ${plan.lockVersion ?? "(no lock yet)"} to ${installed}.`);
  out.log("Your content/, config, BRIEF.md and assets/ are never touched. You are asked before anything of yours is replaced.");

  // 1. The database, before any file: if it fails, the project is exactly as it was.
  let declined = false;
  const ctx = await buildContext(projectRoot, deps.setup ?? {}, true);
  const ask1 = async (q: string) => {
    const yes = await confirm(q);
    if (!yes) declined = true;
    return yes;
  };
  out.log("\nStep 1 of 4: database");
  const migrated = await steps(ctx, out, ask1, { actions: ACTIONS, only: "db.migrate", print: deps.print ?? false });
  if (migrated !== 0 || declined) {
    out.error("The database was not updated, so no file was changed. Run `weekpost upgrade --apply` again when you are ready.");
    return 1;
  }

  // 2. The files.
  out.log("\nStep 2 of 4: files");
  const lockFiles: Record<string, string> = { ...(lock?.files ?? {}) };
  const write = (path: string, content: Buffer) => {
    const file = join(projectRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  for (const f of plan.files) {
    const content = next.get(f.path);
    if (f.state === "update" || f.state === "new") {
      write(f.path, content!);
      out.log(`  ${f.state === "new" ? "added  " : "updated"} ${f.path}`);
    } else if (f.state === "record") {
      out.log(`  same    ${f.path}`);
    } else if (f.state === "edited") {
      out.log(`\n${f.path} is different from the new version${f.note ? ` (${f.note})` : ""}.\n${f.diff ?? ""}\n(- is your file, + is the new one)`);
      const choice = await choose(`What should happen to ${f.path}?`);
      if (choice === "take") {
        write(f.path, content!);
        out.log(`  replaced ${f.path} with the new version`);
      } else if (choice === "side") {
        write(f.path + SIDE_SUFFIX, content!);
        out.log(`  kept your ${f.path}; the new version is in ${f.path}${SIDE_SUFFIX}`);
      } else out.log(`  kept your ${f.path}`);
    } else if (f.state === "removed") {
      if (await confirm(`\n${f.path} is no longer part of weekpost. Delete it?`)) {
        rmSync(join(projectRoot, f.path), { force: true });
        out.log(`  deleted ${f.path}`);
      } else out.log(`  kept ${f.path}`);
      delete lockFiles[f.path];
    }
  }
  // Every generated file is recorded as the new version, also the ones you kept: the next upgrade then sees them as
  // yours and does not ask again.
  for (const [path, content] of next) lockFiles[path] = sha256(content);

  // 3. The lock, last, so an interrupted run is simply run again.
  const base = buildLock([], answers, today, installed);
  const newLock = { ...base, files: Object.fromEntries(Object.entries(lockFiles).sort(([a], [b]) => (a < b ? -1 : 1))) };
  write(LOCK_FILE, Buffer.from(serializeLock(newLock)));
  out.log(`\nStep 3 of 4: updated ${LOCK_FILE} to weekpost ${installed}`);

  // The Worker: only when the version changed, and only if you say yes.
  if (plan.lockVersion !== installed) {
    out.log("\nStep 4 of 4: Worker\nThe Worker runs the code of the weekpost version it was deployed with. Deploy it to pick up this upgrade.");
    const deployed = await steps(ctx, out, confirm, { actions: ACTIONS, only: "worker.deploy" });
    if (deployed !== 0) {
      out.error("The Worker deploy failed. Your files and the lock are already updated; run `weekpost setup --apply --only=worker.deploy` to try again.");
      return 1;
    }
  }

  out.log("\nDone.");
  if (plan.steps?.length) out.log(`Setup steps still to do: ${plan.steps.map((s) => s.id).join(", ")} (see \`weekpost setup --plan\`).`);
  out.log("Next: review the changes with `git diff`, then commit them and open a pull request.");
  return 0;
}
