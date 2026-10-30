// weekpost sources pull <YYYY-Www> [--limit=20] [--root=content] [--project=<dir>]
// Runs the sources of the config for the ISO week before <YYYY-Www> and writes content/<week>/sources.json,
// which the week skill reads. Exit 0: items, or no source configured. Exit 4: sources answered with no items.
// Exit 1: a source failed (the adapter is named: an unreachable database is not an empty week).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import { previousWeekWindow, pullSources, sourceEnv, SourceError } from "../sources/pull.ts";
import { projectPaths, type Out } from "./check.ts";
import { optionOf, positional } from "./queueCommon.ts";

const USAGE = "usage: weekpost sources pull <YYYY-Www> [--limit=20] [--root=content] [--project=<dir>]";

/** KEY=value lines of <project>/.env.local, reduced to the WEEKPOST_SOURCE_* names. */
export function readLocalSourceEnv(projectRoot: string): Record<string, string> {
  const file = join(projectRoot, ".env.local");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?(WEEKPOST_SOURCE_[A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export type SourcesDeps = { env?: Record<string, string | undefined>; now?: () => Date };

// Returns the exit code.
export async function runSources(args: string[], out: Out = console, cwd = process.cwd(), deps: SourcesDeps = {}): Promise<number> {
  const [sub, week] = positional(args);
  if (sub !== "pull" || !week) {
    out.error(USAGE);
    return 2;
  }
  const limitText = optionOf(args, "limit") ?? "20";
  const limit = Number(limitText);
  if (!/^\d+$/.test(limitText) || limit < 1 || limit > 200) {
    out.error("--limit must be a whole number from 1 to 200");
    return 2;
  }
  let window;
  try {
    window = previousWeekWindow(week);
  } catch (e) {
    out.error((e as Error).message);
    return 2;
  }
  const { projectRoot, contentRoot } = projectPaths(args, cwd);
  let adapters;
  try {
    adapters = (await loadConfig(projectRoot)).config.sources ?? [];
  } catch (e) {
    out.error(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }

  // The environment of the process wins over .env.local. Only WEEKPOST_SOURCE_* gets through.
  const env = sourceEnv(readLocalSourceEnv(projectRoot), deps.env ?? process.env);
  let result;
  try {
    result = await pullSources({ adapters, week, limit, projectDir: projectRoot, env });
  } catch (e) {
    out.error(e instanceof SourceError ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }

  const dir = join(contentRoot, week);
  mkdirSync(dir, { recursive: true });
  const doc = { version: 1, week, from: window.from, to: window.to, pulledAt: (deps.now ?? (() => new Date()))().toISOString(), items: result.items };
  writeFileSync(join(dir, "sources.json"), `${JSON.stringify(doc, null, 2)}\n`);

  if (result.dropped) out.log(`dropped ${result.dropped} item(s) without a valid title, https URL or date`);
  if (adapters.length === 0) {
    out.log(`no sources configured; wrote an empty ${join("content", week, "sources.json")}`);
    return 0;
  }
  if (result.items.length === 0) {
    out.error(`no published items between ${window.from} and ${window.to}`);
    return 4;
  }
  out.log(`${result.items.length} item(s) from ${new Set(result.items.map((i) => i.source)).size} source(s) -> ${join(week, "sources.json")}`);
  return 0;
}
