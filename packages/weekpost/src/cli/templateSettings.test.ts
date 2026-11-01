import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settings = JSON.parse(readFileSync(new URL("../../template/.claude/settings.json", import.meta.url), "utf8")) as { permissions: { deny: string[] } };
const deny = settings.permissions.deny;

/**
 * Claude Code's Bash rule matching, as documented: `*` stands for any text, and a trailing " *" also matches the bare command.
 * Source: https://code.claude.com/docs/en/permissions#wildcard-patterns
 */
function matches(rule: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const pattern = m[1]!;
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const body = pattern.split("*").map(escape).join(".*");
  const bare = pattern.endsWith(" *") && pattern.indexOf("*") === pattern.length - 1;
  const re = bare ? new RegExp(`^(${body.slice(0, -3)}|${body})$`) : new RegExp(`^${body}$`);
  return re.test(command);
}
const denied = (command: string) => deny.some((rule) => matches(rule, command));

describe("template .claude/settings.json deny list", () => {
  it("denies every way of spelling the commands that write outside the repository", () => {
    for (const prefix of ["npx weekpost", "npx -y weekpost", "npx --yes weekpost", "./node_modules/.bin/weekpost", "node node_modules/weekpost/bin/weekpost.js", "node ./node_modules/.bin/weekpost"]) {
      for (const c of ["setup --apply", "setup --only=worker.deploy --apply", "token en", "first-post en --yes", "enqueue dir --weeks=w", "cancel p --yes", "restore p --yes", "reschedule p --yes", "resolve p --yes", "metrics --write", "metrics --issue", "metrics --json --write --issue"]) {
        expect(denied(`${prefix} ${c}`), `${prefix} ${c}`).toBe(true);
      }
    }
  });
  it("still lets the agent run the read and write-the-repo commands", () => {
    for (const c of ["npx weekpost check", "npx weekpost generate", "npx weekpost sources", "npx weekpost status", "npx weekpost doctor", "npx weekpost metrics", "npx weekpost metrics --json", "npx weekpost agent-env", "npx weekpost setup --plan", "./node_modules/.bin/weekpost check"]) {
      expect(denied(c), c).toBe(false);
    }
  });
  it("denies the gh commands that would give the approval a human is meant to give", () => {
    for (const c of ["gh pr merge 3 --squash", "gh pr merge", "gh pr edit 3 --add-label media-ok", "gh pr ready 3", "gh pr create --title x --label media-ok", "gh pr edit 3 --title y --add-label media-ok", "gh api repos/o/r/issues/3/labels -f labels[]=media-ok", "gh workflow run weekpost-enqueue.yml -f pr=3", "gh label create x", "gh secret set X"]) {
      expect(denied(c), c).toBe(true);
    }
  });
  it("lets the agent open a pull request", () => {
    for (const c of ["gh pr create --title x --body y", "gh pr view 3", "gh pr list"]) expect(denied(c), c).toBe(false);
  });
  it("denies terminal wrappers that would fake a TTY", () => {
    for (const c of ["script -q /dev/null npx weekpost token en", "expect -c x", "unbuffer npx weekpost token en"]) expect(denied(c), c).toBe(true);
  });
  it("keeps denying reads of the local secrets file", () => {
    expect(deny).toContain("Read(~/.config/weekpost/**)");
  });
});
