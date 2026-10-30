import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { commitTime, gitIsAncestor, headCommit } from "./git.ts";

// A throw-away repository with two lines of history: a -> b -> c, and a -> d.
let dir: string;
const sha: Record<string, string> = {};
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z" } }).trim();
const commit = (name: string) => {
  writeFileSync(join(dir, "f.txt"), name);
  git("add", "f.txt");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", name);
  sha[name] = git("rev-parse", "HEAD");
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "weekpost-git-"));
  git("init", "-q", "-b", "main");
  commit("a");
  commit("b");
  commit("c");
  git("checkout", "-q", "-b", "side", sha.a);
  commit("d");
  git("checkout", "-q", "main");
});

describe("git helpers", () => {
  it("headCommit is the checked-out commit", () => {
    expect(headCommit(dir)).toBe(sha.c);
  });
  it("gitIsAncestor: an ancestor, the commit itself, a descendant and a sibling", () => {
    const is = gitIsAncestor(dir);
    expect(is(sha.a, sha.c)).toBe(true);
    expect(is(sha.c, sha.c)).toBe(true);
    expect(is(sha.c, sha.a)).toBe(false);
    expect(is(sha.d, sha.c)).toBe(false);
  });
  it("gitIsAncestor answers false for a commit the checkout does not have", () => {
    expect(gitIsAncestor(dir)("f".repeat(40), sha.c)).toBe(false);
  });
  it("commitTime reads the commit instant, or null when the commit is unknown", () => {
    expect(commitTime(dir, sha.a)).toBe("2026-10-01T10:00:00.000Z");
    expect(commitTime(dir, "f".repeat(40))).toBeNull();
  });
  it("headCommit is undefined outside a repository", () => {
    expect(headCommit(mkdtempSync(join(tmpdir(), "weekpost-nogit-")))).toBeUndefined();
  });
});
