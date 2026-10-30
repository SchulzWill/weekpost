// weekpost package <YYYY-Www> [--project=<dir>] [--root=content] [--from=<out-dir>] [--dest=<dir>] [--post=<id>]
// Copies the media listed in out/<week>/manifest.json (run `generate` first) into one folder per day and
// account, with caption.txt, time.txt and link.txt, for publishing by hand.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import { checkContent } from "../content/load.ts";
import { manifestSchema, verifyManifest } from "../render/manifest.ts";
import { projectPaths, type Out } from "./check.ts";
import { packagePlan } from "./packagePlan.ts";

const USAGE = "usage: weekpost package <YYYY-Www> [--project=<dir>] [--root=content] [--from=<out-dir>] [--dest=<dir>] [--post=<id>]";

// Returns the exit code.
export async function runPackage(args: string[], out: Out = console, cwd = process.cwd()): Promise<number> {
  const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const week = args.find((a) => !a.startsWith("--"));
  if (!week) {
    out.error(USAGE);
    return 2;
  }
  const { projectRoot, contentRoot } = projectPaths(args, cwd);
  const outDir = resolve(cwd, opt("from") ?? join(projectRoot, "out", week));
  const manifestFile = join(outDir, "manifest.json");
  if (!existsSync(manifestFile)) {
    out.error(`${manifestFile} not found: run weekpost generate ${week} first`);
    return 1;
  }

  let config;
  try {
    ({ config } = await loadConfig(projectRoot));
  } catch (e) {
    out.error(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }
  const { weeks, issues } = checkContent(contentRoot, config, week);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length || !weeks.length) {
    for (const i of errors) out.error(`error ${i.where}: ${i.message}`);
    out.error(weeks.length ? "fix the errors before packaging (weekpost check)" : `week ${week} not found in ${contentRoot}`);
    return 1;
  }

  let parsed;
  try {
    parsed = manifestSchema.safeParse(JSON.parse(readFileSync(manifestFile, "utf8")));
  } catch (e) {
    out.error(`${manifestFile} is not valid JSON: ${(e as Error).message}`);
    return 1;
  }
  if (!parsed.success) {
    for (const i of parsed.error.issues) out.error(`error manifest.${i.path.join(".")}: ${i.message}`);
    out.error("the manifest is not a valid v1 manifest: run weekpost generate again");
    return 1;
  }
  const problems = verifyManifest(parsed.data, outDir);
  if (problems.length) {
    for (const p of problems) out.error(`error ${p}`);
    out.error("the media on disk differs from the manifest: run weekpost generate again");
    return 1;
  }

  const only = opt("post");
  const posts = weeks[0].posts.filter((p) => !only || p.id === only);
  if (only && !posts.length) {
    out.error(`post ${only} not found in ${week}`);
    return 1;
  }
  const dest = resolve(cwd, opt("dest") ?? join(projectRoot, "out", "package"), week);
  const plan = packagePlan(parsed.data, posts, config.accounts);
  for (const item of plan) {
    const dir = join(dest, item.dir);
    mkdirSync(dir, { recursive: true });
    for (const f of item.files) copyFileSync(join(outDir, f.from), join(dir, f.to));
    for (const [name, body] of Object.entries(item.texts)) writeFileSync(join(dir, name), body);
    out.log(item.dir);
  }
  out.log(`${plan.length} folder(s) in ${dest}`);
  return 0;
}
