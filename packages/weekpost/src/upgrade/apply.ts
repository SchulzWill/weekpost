// `weekpost upgrade --apply`: carries out what `--plan` showed. The order matters: the database first (a failure
// stops everything with your files untouched), then the files, then the lock, then the Worker. Every step can be
// run again after an interruption, and a second run on a finished upgrade changes nothing.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { buildContext } from "../cli/setup.ts";
import type { Out } from "../cli/check.ts";
import { ACTIONS } from "../setup/actions.ts";
import { runApply, type Actions } from "../setup/apply.ts";
import { buildLock, LOCK_FILE, serializeLock, sha256 } from "../setup/template.ts";
import { diffOf, planUpgradeFull, unsafePath, type PlanDeps } from "./plan.ts";

/** What to do with a file you edited and the new version also changes. */
export type Choice = "keep" | "take" | "side";

export type ApplyUpgradeDeps = PlanDeps & {
  /** Asks a yes/no question at the terminal. Default: a `[y/N]` prompt (no is the default). */
  confirm?: (question: string) => Promise<boolean>;
  /** Asks what to do with an edited file. Default: a prompt where Enter keeps your version. */
  choose?: (question: string) => Promise<Choice>;
  /** The step runner of `setup --apply` and the actions it runs (tests replace them). */
  runApply?: typeof runApply;
  actions?: Actions;
  /** Print the migration SQL instead of running it. */
  print?: boolean;
};

/** The terminal closed (Ctrl+D) or the prompt was interrupted. */
export class Stopped extends Error {}

export const SIDE_SUFFIX = ".weekpost-new";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Stopped("prompt closed");
    throw e;
  } finally {
    rl.close();
  }
}

const ttyConfirm = async (question: string) => /^y(es)?$/.test(await ask(`${question} [y/N] `));
const ttyChoose = async (question: string): Promise<Choice> => {
  for (;;) {
    const answer = await ask(
      `${question}\n  [k] keep my version (default)   [t] take the new version (yours is lost unless committed; \`git checkout -- <file>\` restores it)   [s] keep mine and write the new one to <file>${SIDE_SUFFIX} for you to merge by hand\n  choice: `,
    );
    if (answer === "" || answer === "k") return "keep";
    if (answer === "t") return "take";
    if (answer === "s") return "side";
    console.log("  Please type k, t or s (Enter keeps your version).");
  }
};

const DEPLOY_LATER = "weekpost setup --apply --only=worker.deploy";

/** Writes through a temporary file and a rename, so a crash never leaves half a file; refuses links and paths outside the project. */
function safeWrite(projectRoot: string, path: string, content: Buffer): void {
  const why = unsafePath(projectRoot, path);
  if (why) throw new Error(`${path} ${why}`);
  const file = join(projectRoot, path);
  mkdirSync(dirname(file), { recursive: true });
  const again = unsafePath(projectRoot, path);
  if (again) throw new Error(`${path} ${again}`);
  let mode = 0o644;
  try {
    mode = lstatSync(file).mode & 0o777;
  } catch {
    /* a new file */
  }
  const tmp = join(dirname(file), `.${basename(file)}.weekpost-tmp`);
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
}

/** The file as it is on disk now, or null when it is absent or not a regular file. */
function readNow(projectRoot: string, path: string): Buffer | null {
  if (unsafePath(projectRoot, path)) throw new Error(`${path} changed into a link or left the project while the upgrade was running`);
  try {
    return lstatSync(join(projectRoot, path)).isFile() ? readFileSync(join(projectRoot, path)) : null;
  } catch {
    return null;
  }
}

/** Where to put the new version of a file you kept: `<file>.weekpost-new`, or the first numbered name that is free. */
function sideTarget(projectRoot: string, path: string, content: Buffer): { path: string; write: boolean } {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? path + SIDE_SUFFIX : `${path}${SIDE_SUFFIX}-${i}`;
    let existing: Buffer | null = null;
    try {
      const st = lstatSync(join(projectRoot, candidate));
      if (st.isFile()) existing = readFileSync(join(projectRoot, candidate));
    } catch {
      return { path: candidate, write: true };
    }
    if (existing && existing.equals(content)) return { path: candidate, write: false };
  }
}

/** Returns the exit code: 0 done or nothing to do, 1 stopped (blocked or a step failed or was declined). */
export async function applyUpgrade(projectRoot: string, out: Out, deps: ApplyUpgradeDeps = {}): Promise<number> {
  const confirm = deps.confirm ?? ttyConfirm;
  const choose = deps.choose ?? ttyChoose;
  const steps = deps.runApply ?? runApply;
  const { plan, inputs } = await planUpgradeFull(projectRoot, deps);
  const { lock, answers, today, next, installed, disk } = inputs;
  const pending = plan.migrations?.pending ?? [];
  // The files and the lock are already at this version and the database has nothing pending.
  const settled = !!lock && plan.lockVersion === installed && plan.toChange === 0 && pending.length === 0;
  const hard = plan.blockers.filter((b) => !b.dirty);

  if (hard.length || !answers || !plan.files || (plan.blocked && !settled)) {
    out.error(`Not upgrading: ${plan.blockers.length} problem(s) block it. Nothing was changed.`);
    for (const b of plan.blockers) out.error(`  ${b.message}`);
    out.error("Fix them, commit, and run `weekpost upgrade --plan` to see the result.");
    return 1;
  }

  const ctx = await buildContext(projectRoot, deps.setup ?? {}, true);
  const readLockText = () => {
    try {
      return readFileSync(join(projectRoot, LOCK_FILE), "utf8");
    } catch {
      return "";
    }
  };
  const writeLock = (files: Record<string, string>, deployPending: boolean) => {
    const base = buildLock([], answers, today, installed);
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
    const text = serializeLock({ ...base, files: sorted, ...(deployPending ? { deployPending: true as const } : {}) });
    if (text !== readLockText()) safeWrite(projectRoot, LOCK_FILE, Buffer.from(text));
  };

  /** Offers the Worker deploy. Returns 0 when it went out (or needs nothing), 1 when it failed; says so when you decline. */
  const deploy = async (files: Record<string, string>): Promise<number> => {
    let declined = false;
    const code = await steps(ctx, out, async (q) => {
      const yes = await confirm(q);
      if (!yes) declined = true;
      return yes;
    }, { actions: deps.actions ?? ACTIONS, only: "worker.deploy", quiet: true });
    if (code !== 0) {
      out.error(`The Worker deploy failed. Your files and the lock are already updated. To try again, run \`${DEPLOY_LATER}\` or \`weekpost upgrade --apply\`.`);
      return 1;
    }
    if (declined) {
      out.log("\nThe Worker was not deployed and still runs the old version. Deploy it before the next scheduled post: `weekpost setup --apply --only=worker.deploy`. `weekpost upgrade --apply` offers it again until you do.");
      return 0;
    }
    writeLock(files, false);
    return 0;
  };

  if (settled) {
    if (plan.deployPending) {
      out.log(`The files and the lock are already on weekpost ${installed}, but the Worker was never deployed with it.`);
      const code = await deploy({ ...lock?.files });
      if (code === 0) out.log("Done.");
      return code;
    }
    if (plan.blocked) {
      out.log(`The upgrade to weekpost ${installed} is already done: the files and the lock are updated. Commit the changes (\`git status\` lists them).`);
      return 0;
    }
    if (plan.migrations?.state === "unknown") {
      out.log(`Files and lock are on weekpost ${installed}; nothing was changed. The database was not checked (${plan.migrations.detail}). To check it, run \`weekpost setup --plan\`.`);
    } else out.log(`Already up to date on weekpost ${installed}. Nothing was changed.`);
    return 0;
  }

  out.log(`Upgrading this project from weekpost ${plan.lockVersion ?? "(no lock yet)"} to ${installed}.`);
  out.log("Your content/, config, BRIEF.md, PRIVACY.md and assets/ are never touched. Each step asks first. Files are only changed on disk, so git can undo them; database migrations cannot be undone; the Worker deploy goes live.");

  // 1. The database, before any file: if it fails, the project is exactly as it was.
  let declined = false;
  const askDb = async (q: string) => {
    const yes = await confirm(q);
    if (!yes) declined = true;
    return yes;
  };
  out.log("\nStep 1 of 4: database");
  const printing = deps.print === true && plan.migrations?.state !== "ok";
  const migrated = await steps(ctx, out, askDb, { actions: deps.actions ?? ACTIONS, only: "db.migrate", print: printing, quiet: true });
  if (printing && migrated === 0) {
    out.error("The SQL above was printed, not run. Paste it into the Supabase SQL editor, then run `weekpost upgrade --apply` again (without --print) to update the files and deploy the Worker. Nothing else was changed.");
    return 1;
  }
  if (declined) {
    out.error("You declined the database step. Nothing was changed.");
    return 1;
  }
  if (migrated !== 0) {
    out.error("The database step did not finish (migrations already applied stay applied; the one that failed was rolled back). No file was changed. Fix the cause above and run `weekpost upgrade --apply` again; it continues from the first pending migration.");
    return 1;
  }

  // 2. The files.
  out.log("\nStep 2 of 4: files");
  const lockFiles: Record<string, string> = { ...lock?.files };
  try {
    for (const f of plan.files) {
      const content = next.get(f.path);
      if (f.state === "record") {
        out.log(`  same    ${f.path}`);
        continue;
      }
      // The database step can take minutes: look at the file again, and ask if you changed it since the plan.
      const now = readNow(projectRoot, f.path);
      const planned = disk.get(f.path) ?? null;
      const nowHash = now ? sha256(now) : null;
      const changed = nowHash !== planned;
      if (f.state === "removed") {
        if (!now) {
          out.log(`  gone    ${f.path}`);
        } else {
          if (nowHash !== lock?.files[f.path]) out.log(`\n${f.path} has changes of yours:\n${diffOf(f.path, now, Buffer.alloc(0))}\n(- is your file)`);
          if (await confirm(`\n${f.path} is no longer part of weekpost. Delete it?`)) {
            if (unsafePath(projectRoot, f.path)) throw new Error(`${f.path} is not safe to delete`);
            rmSync(join(projectRoot, f.path), { force: true });
            out.log(`  deleted ${f.path}`);
          } else out.log(`  kept ${f.path}`);
        }
        delete lockFiles[f.path];
        continue;
      }
      if (!content) continue;
      if (nowHash === sha256(content)) {
        out.log(`  same    ${f.path}`);
        continue;
      }
      const conflict = f.state === "edited" || (changed && now !== null);
      if (!conflict) {
        safeWrite(projectRoot, f.path, content);
        out.log(`  ${f.state === "new" || !now ? "added  " : "updated"} ${f.path}`);
        continue;
      }
      const note = f.state === "edited" ? f.note : "you changed it while the upgrade was running";
      out.log(`\n${f.path} is different from the new version${note ? ` (${note})` : ""}.\n${now ? diffOf(f.path, now, content) : (f.diff ?? "")}\n(- is your file, + is the new one)`);
      const choice = await choose(`What should happen to ${f.path}?`);
      if (choice === "take") {
        safeWrite(projectRoot, f.path, content);
        out.log(`  replaced ${f.path} with the new version`);
      } else if (choice === "side") {
        const side = sideTarget(projectRoot, f.path, content);
        if (side.write) safeWrite(projectRoot, side.path, content);
        out.log(`  kept your ${f.path}; the new version is in ${side.path}. Merge what you want into ${f.path}, then delete ${side.path} (do not commit it).`);
      } else out.log(`  kept your ${f.path}`);
    }
    // Every generated file is recorded as the new version, also the ones you kept: the next upgrade then sees them as
    // yours and does not ask again.
    for (const [path, content] of next) lockFiles[path] = sha256(content);

    // 3. The lock, last, so an interrupted run is simply run again.
    const versionChanged = plan.lockVersion !== installed;
    writeLock(lockFiles, versionChanged);
    out.log(`\nStep 3 of 4: updated ${LOCK_FILE} to weekpost ${installed}`);
  } catch (e) {
    if (e instanceof Stopped || (e as Error).name === "AbortError") throw e;
    out.error(`Stopped: ${(e as Error).message}. Files already written stay as they are (the lock is only written at the end); fix this and run \`weekpost upgrade --apply\` again, it continues from here.`);
    return 1;
  }

  // The Worker: only when the version changed, and only if you say yes.
  if (plan.lockVersion !== installed) {
    out.log("\nStep 4 of 4: Worker\nThis deploys the files in worker/ as they are on disk now (not yet committed) to your live Worker. Scheduled posts use it from the next run. To undo, redeploy the previous commit.");
    const code = await deploy(lockFiles);
    if (code !== 0) return 1;
  }

  out.log("\nDone.");
  if (plan.steps?.length) out.log(`Setup steps still to do: ${plan.steps.map((s) => s.id).join(", ")} (see \`weekpost setup --plan\`).`);
  out.log("Next: review the changes with `git status` and `git diff` (`git checkout -- <file>` undoes a file), merge and delete any *.weekpost-new file, then commit and open a pull request.");
  return 0;
}
