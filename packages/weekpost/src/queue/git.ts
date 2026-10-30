// Git questions the enqueue asks about the commit it reads, to tell a stale run from a current one. A function
// per question, so tests can inject answers; the defaults shell out to git in the project checkout.
import { execFileSync } from "node:child_process";

export const FULL_SHA = /^[0-9a-f]{40}$/;

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** The checked-out commit, or undefined when `cwd` is not a git checkout. */
export function headCommit(cwd: string): string | undefined {
  try {
    const sha = git(cwd, ["rev-parse", "HEAD"]);
    return FULL_SHA.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** True when `ancestor` is `descendant` or one of its ancestors. A commit this checkout does not have answers false (the safe side). */
export function gitIsAncestor(cwd: string): (ancestor: string, descendant: string) => boolean {
  return (ancestor, descendant) => {
    if (!FULL_SHA.test(ancestor) || !FULL_SHA.test(descendant)) return false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
}

/** The commit instant as an ISO string, or null when git does not know the commit. */
export function commitTime(cwd: string, sha: string): string | null {
  if (!FULL_SHA.test(sha)) return null;
  try {
    const t = new Date(git(cwd, ["show", "-s", "--format=%cI", sha]));
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
  } catch {
    return null;
  }
}
