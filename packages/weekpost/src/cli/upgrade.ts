// weekpost upgrade --plan [--json] [--project=<dir>]
// Reads the project and says what moving to the installed weekpost would do. It never writes: no file, no database,
// no GitHub. It exits 1 when something blocks the upgrade. (`--apply` is not part of this version.)
import { planUpgrade, type PlanDeps, type UpgradePlan } from "../upgrade/plan.ts";
import { projectPaths, type Out } from "./check.ts";

const USAGE = "usage: weekpost upgrade --plan [--json]   (--project=<dir>)";
const HELP = `${USAGE}\nRun after installing a new weekpost: lists what it would change in this project. Writes nothing.`;
const LEGEND = "update = we replace it (you never touched it) · edited = you changed it; the diff shows your version (-) against the new one (+); upgrade will not overwrite it without asking · new = we add it · removed = we delete it · record = identical to the new file; only added to the lock";

const tag = (n: number, title: string) => `${n}. ${title}`;

export function renderUpgradePlan(plan: UpgradePlan, out: Out): void {
  out.log("weekpost upgrade --plan: nothing is written; this is what an upgrade would do\n");
  out.log(`installed: ${plan.installed}   lock: ${plan.lockVersion ?? "none"}`);
  for (const w of plan.warnings) out.log(`warn  ${w}`);

  out.log(`\n${tag(1, "Version and files")}`);
  const early = plan.blockers.filter((b) => b.item <= 3);
  for (const b of early) out.log(`BLOCKED  ${b.message}`);
  if (early.length === 0) out.log("ok");

  out.log(`\n${tag(2, "Content")}`);
  if (!plan.content) out.log("skipped: the config did not load");
  else {
    const { weeks, errors, warnings } = plan.content;
    for (const i of errors) out.log(`BLOCKED  ${i.week ? `${i.week}: ` : ""}${i.where}: ${i.message}`);
    for (const i of warnings) out.log(`warn     ${i.week ? `${i.week}: ` : ""}${i.where}: ${i.message}`);
    out.log(`${weeks} week(s) checked, ${errors.length} blocking error(s), ${warnings.length} warning(s)`);
  }

  out.log(`\n${tag(3, "Migrations")}`);
  if (!plan.migrations) out.log("skipped: the config did not load");
  else {
    out.log(`[${plan.migrations.state}] ${plan.migrations.detail}${plan.migrations.state === "unknown" ? " (does not block)" : ""}`);
    for (const m of plan.migrations.pending) out.log(`  ${m}`);
  }

  out.log(`\n${tag(4, "Files")}`);
  if (!plan.files) out.log("skipped: the config did not load, so the template could not be rendered");
  else {
    if (plan.files.length) out.log(`${LEGEND}\n`);
    for (const f of plan.files) out.log(`${f.state.padEnd(8)} ${f.path}${f.note ? `  (${f.note})` : ""}`);
    for (const f of plan.files.filter((x) => x.diff)) out.log(`\n${f.diff}`);
    out.log(`${plan.toChange} to change, ${plan.unchanged} already current`);
  }

  out.log(`\n${tag(5, "Setup steps still to do")}`);
  if (!plan.steps) out.log("skipped: the config did not load");
  else if (plan.steps.length === 0) out.log("none");
  else for (const s of plan.steps) out.log(`[todo] ${s.id}: ${s.detail} (does not block)`);

  if (plan.blocked) {
    const n = plan.blockers.length;
    out.log(`\nBlocked by ${n} problem(s). Nothing was written. Fix the ${n} problem(s) marked BLOCKED, commit, and run \`weekpost upgrade --plan\` again.`);
  } else if (plan.lockVersion === plan.installed) {
    out.log(`\nAlready on ${plan.installed} (the lock matches the installed version); nothing to upgrade.`);
  } else {
    out.log("\nNothing blocks the upgrade. Applying it isn't available yet: to take the new files now, copy them by hand from the diffs above and commit.");
  }
}

export type UpgradeDeps = PlanDeps;

// Returns the exit code.
export async function runUpgrade(args: string[], out: Out = console, cwd = process.cwd(), deps: UpgradeDeps = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    out.log(HELP);
    return 0;
  }
  if (args.includes("--apply")) {
    out.error("upgrade --apply is not available in this version; use `weekpost upgrade --plan` to see what an upgrade would change");
    return 2;
  }
  const known = (a: string) => a === "--plan" || a === "--json" || a.startsWith("--project=");
  if (!args.includes("--plan") || args.some((a) => !known(a))) {
    out.error(USAGE);
    return 2;
  }
  const { projectRoot } = projectPaths(args, cwd);
  const plan = await planUpgrade(projectRoot, deps);
  if (args.includes("--json")) out.log(JSON.stringify(plan, null, 2));
  else renderUpgradePlan(plan, out);
  return plan.blocked ? 1 : 0;
}
