// weekpost check [YYYY-Www] [--root=content] [--project=<dir>]
// Loads the config, then validates and lints the content. Exits 1 on any error; warnings are only listed.
import { dirname, join, resolve } from "node:path";
import { ConfigError } from "../config/parse.ts";
import { loadConfig } from "../config/load.ts";
import { checkContent } from "../content/load.ts";

export type Out = { log(line: string): void; error(line: string): void };

const optionOf = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

// Project directory (weekpost.config.ts, assets/): --project, else the parent of --root, else the current directory.
export function projectPaths(args: string[], cwd = process.cwd()) {
  const rootOpt = optionOf(args, "root");
  const projectRoot = resolve(cwd, optionOf(args, "project") ?? (rootOpt ? dirname(resolve(cwd, rootOpt)) : "."));
  const contentRoot = rootOpt ? resolve(cwd, rootOpt) : join(projectRoot, "content");
  return { projectRoot, contentRoot };
}

// Returns the exit code.
export async function runCheck(args: string[], out: Out = console, cwd = process.cwd()): Promise<number> {
  const week = args.find((a) => !a.startsWith("--"));
  const { projectRoot, contentRoot } = projectPaths(args, cwd);

  let loaded;
  try {
    loaded = await loadConfig(projectRoot);
  } catch (e) {
    out.error(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }
  for (const w of loaded.warnings) out.log(`warn  config ${w}`);

  const { weeks, issues } = checkContent(contentRoot, loaded.config, week);
  for (const i of issues) out.log(`${i.level === "error" ? "error" : "warn "} ${i.where}: ${i.message}`);
  const errors = issues.filter((i) => i.level === "error").length;
  const posts = weeks.reduce((n, w) => n + w.posts.length, 0);
  out.log(`${weeks.length} week(s), ${posts} post(s), ${errors} error(s), ${issues.length - errors} warning(s)`);
  if (week && weeks.length === 0) {
    out.error(`week ${week} not found in ${contentRoot}`);
    return 1;
  }
  return errors ? 1 : 0;
}
