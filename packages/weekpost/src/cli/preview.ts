// weekpost preview <pr> [--repo=<owner/name>] [--dest=<dir>] [--no-open]
// Downloads the preview artifact of the latest successful preview run of a pull request with the GitHub CLI
// (`gh`) and opens its index.html. Needs `gh` installed and logged in (`gh auth login`).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Out } from "./check.ts";

export const PREVIEW_WORKFLOW = "weekpost-preview.yml";
export const PREVIEW_ARTIFACT = "weekpost-preview";
const USAGE = "usage: weekpost preview <pr-number> [--repo=<owner/name>] [--dest=<dir>] [--no-open]";

type Gh = { ok: true; stdout: string } | { ok: false; message: string };

function gh(args: string[], cwd: string): Gh {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8" });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { ok: false, message: "the GitHub CLI (gh) was not found: install it from https://cli.github.com and run `gh auth login`" };
  }
  if (r.error) return { ok: false, message: `gh failed to start: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, message: `gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit code ${r.status}`}` };
  return { ok: true, stdout: r.stdout };
}

// index.html files at most two levels deep (the artifact keeps one folder per week, maybe under out/).
export function findIndexes(dir: string, depth = 3): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name === "index.html") found.push(join(dir, entry.name));
    else if (entry.isDirectory() && depth > 1) found.push(...findIndexes(join(dir, entry.name), depth - 1));
  }
  return found;
}

export function openFile(file: string): void {
  const [cmd, ...args] = process.platform === "darwin" ? ["open", file] : process.platform === "win32" ? ["cmd", "/c", "start", "", file] : ["xdg-open", file];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// Returns the exit code. `open` is injectable for tests.
export async function runPreview(args: string[], out: Out = console, cwd = process.cwd(), open: (file: string) => void = openFile): Promise<number> {
  const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const pr = args.find((a) => !a.startsWith("--"));
  if (!pr || !/^\d+$/.test(pr)) {
    out.error(USAGE);
    return 2;
  }
  const repo = opt("repo") ? ["-R", opt("repo")!] : [];

  const branch = gh(["pr", "view", pr, ...repo, "--json", "headRefName", "-q", ".headRefName"], cwd);
  if (!branch.ok) {
    out.error(`error: ${branch.message}`);
    return 1;
  }
  const run = gh(["run", "list", ...repo, "--workflow", PREVIEW_WORKFLOW, "--branch", branch.stdout.trim(), "--status", "success", "--limit", "1", "--json", "databaseId", "-q", ".[0].databaseId"], cwd);
  if (!run.ok) {
    out.error(`error: ${run.message}`);
    return 1;
  }
  const runId = run.stdout.trim();
  if (!/^\d+$/.test(runId)) {
    out.error(`error: no successful preview run for PR #${pr}: add the preview label to the pull request and wait for the preview comment`);
    return 1;
  }

  const dest = resolve(cwd, opt("dest") ?? join("out", `preview-${pr}`));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const download = gh(["run", "download", runId, ...repo, "-n", PREVIEW_ARTIFACT, "-D", dest], cwd);
  if (!download.ok) {
    out.error(`error: ${download.message}\nthe artifact may have expired (30 days): re-apply the preview label to generate it again`);
    return 1;
  }
  const indexes = existsSync(dest) ? findIndexes(dest) : [];
  if (!indexes.length) {
    out.error(`error: the artifact of run ${runId} has no index.html`);
    return 1;
  }
  for (const file of indexes) out.log(file);
  if (!args.includes("--no-open")) for (const file of indexes) open(file);
  return 0;
}
