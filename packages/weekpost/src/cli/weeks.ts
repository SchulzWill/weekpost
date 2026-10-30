// weekpost weeks <paths-file> [<out-file>]
// Reads a list of changed files (one repo-relative path per line, e.g. from the GitHub API) and prints the
// weeks under content/ they touch, one per line, sorted. Used by the workflows to pick what to generate.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Out } from "./check.ts";

const WEEK_PATH = /^content\/(\d{4}-W\d{2})\//;

export function changedWeeks(paths: string[]): string[] {
  const weeks = new Set<string>();
  for (const p of paths) {
    const m = p.trim().match(WEEK_PATH);
    if (m) weeks.add(m[1]);
  }
  return [...weeks].sort();
}

// Returns the exit code.
export function runWeeks(args: string[], out: Out = console, cwd = process.cwd()): number {
  const [pathsFile, outFile] = args.filter((a) => !a.startsWith("--"));
  if (!pathsFile) {
    out.error("usage: weekpost weeks <paths-file> [<out-file>]");
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(resolve(cwd, pathsFile), "utf8");
  } catch (e) {
    out.error(`error: cannot read ${pathsFile}: ${(e as Error).message}`);
    return 1;
  }
  const weeks = changedWeeks(text.split("\n").filter(Boolean));
  const lines = weeks.map((w) => `${w}\n`).join("");
  if (outFile) {
    // Final newline so a shell `while read` loop sees the last week.
    writeFileSync(resolve(cwd, outFile), lines);
    out.log(weeks.length ? `weeks: ${weeks.join(", ")}` : "no week under content/ changed");
  } else {
    for (const w of weeks) out.log(w);
  }
  return 0;
}
