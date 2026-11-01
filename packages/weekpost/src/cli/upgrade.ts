// weekpost upgrade --plan [--json] [--project=<dir>]
// Reads the project and says what moving to the installed weekpost would do. It never writes: no file, no database,
// no GitHub. It exits 1 when something blocks the upgrade. (`--apply` is not part of this version.)
import { planUpgrade, type PlanDeps, type UpgradePlan } from "../upgrade/plan.ts";
import { projectPaths, type Out } from "./check.ts";

const USAGE = "usage: weekpost upgrade --plan [--json]   (--project=<dir>)";

const tag = (n: number, title: string) => `${n}. ${title}`;

export function renderUpgradePlan(plan: UpgradePlan, out: Out): void {
  out.log("weekpost upgrade --plan: nothing is written; this is what an upgrade would do\n");
  out.log(`installed: ${plan.installed}   lock: ${plan.lockVersion ?? "none"}`);
  for (const w of plan.warnings) out.log(`warn  ${w}`);

  out.log(`\n${tag(1, "Version and files")}`);
  const blocked = (item: number) => plan.blockers.filter((b) => b.item === item);
  for (const item of [1, 2, 3] as const) {
    for (const b of blocked(item)) out.log(`BLOCKED  ${b.message}`);
  }

  out.log(`\n${tag(4, "Content")}`);
  if (!plan.content) out.log("skipped: the config did not load");
  else {
    const { weeks, errors, warnings } = plan.content;
    for (const i of errors) out.log(`BLOCKED  ${i.week ? `${i.week}: ` : ""}${i.where}: ${i.message}`);
    for (const i of warnings) out.log(`warn     ${i.week ? `${i.week}: ` : ""}${i.where}: ${i.message}`);
    out.log(`${weeks} week(s) checked, ${errors.length} blocking error(s), ${warnings.length} warning(s)`);
  }

  out.log(`\n${tag(5, "Migrations")}`);
  if (!plan.migrations) out.log("skipped: the config did not load");
  else {
    out.log(`[${plan.migrations.state}] ${plan.migrations.detail}`);
    for (const m of plan.migrations.pending) out.log(`  ${m}`);
  }

  out.log(`\n${tag(6, "Files")}`);
  if (!plan.files) out.log("skipped: the config did not load, so the template could not be rendered");
  else {
    for (const f of plan.files) out.log(`${f.state.padEnd(8)} ${f.path}${f.note ? `  (${f.note})` : ""}`);
    for (const f of plan.files.filter((x) => x.diff)) out.log(`\n${f.diff}`);
    out.log(`${plan.files.length} to change, ${plan.unchanged} already current`);
  }

  out.log(`\n${tag(7, "Setup steps still to do")}`);
  if (!plan.steps) out.log("skipped: the config did not load");
  else if (plan.steps.length === 0) out.log("none");
  else for (const s of plan.steps) out.log(`[todo] ${s.id}: ${s.detail}`);

  out.log(plan.blocked ? `\nBlocked by ${plan.blockers.length} problem(s). Nothing was written; fix them and run this again.` : "\nNothing blocks the upgrade.");
}

export type UpgradeDeps = PlanDeps;

// Returns the exit code.
export async function runUpgrade(args: string[], out: Out = console, cwd = process.cwd(), deps: UpgradeDeps = {}): Promise<number> {
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
