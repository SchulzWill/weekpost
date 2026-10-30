import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "../src/cli/init.ts";

// The Codex rules are Starlark `prefix_rule(...)` calls. Every value we write is a JSON literal, so we read them as JSON.
type Rule = { pattern: (string | string[])[]; decision: string };
function loadRules(): Rule[] {
  const text = readFileSync(join(TEMPLATE_DIR, ".codex/rules/weekpost.rules"), "utf8");
  return [...text.matchAll(/prefix_rule\(\s*pattern = (\[.*\]),\s*decision = "(\w+)",/g)].map((m) => ({ pattern: JSON.parse(m[1]!) as Rule["pattern"], decision: m[2]! }));
}
const RANK: Record<string, number> = { allow: 0, prompt: 1, forbidden: 2 };

/** What Codex does with a command: the strictest decision among the rules whose pattern is a prefix of it. */
function decide(command: string): string {
  const words = command.split(" ");
  let best = "none";
  for (const r of loadRules()) {
    const hit = r.pattern.length <= words.length && r.pattern.every((p, i) => (Array.isArray(p) ? p.includes(words[i]!) : p === words[i]));
    if (hit && (best === "none" || RANK[r.decision]! > RANK[best]!)) best = r.decision;
  }
  return best;
}

describe("template .codex", () => {
  it("parses every rule and uses only decisions Codex knows", () => {
    const text = readFileSync(join(TEMPLATE_DIR, ".codex/rules/weekpost.rules"), "utf8");
    const rules = loadRules();
    expect(rules.length).toBe((text.match(/prefix_rule\(/g) ?? []).length);
    for (const r of rules) expect(Object.keys(RANK)).toContain(r.decision);
  });

  it("forbids the commands that write outside the repository, in every way of launching weekpost", () => {
    for (const prefix of ["npx weekpost", "npx -y weekpost", "npx --yes weekpost", "weekpost", "./node_modules/.bin/weekpost", "node node_modules/weekpost/bin/weekpost.js"]) {
      for (const c of ["setup --apply", "token en", "first-post en --yes", "enqueue dir --weeks=w"]) expect(decide(`${prefix} ${c}`), `${prefix} ${c}`).toBe("forbidden");
      for (const c of ["setup --only=worker.deploy --apply", "cancel p --yes", "restore p --yes", "reschedule p --yes", "resolve p --yes"]) expect(decide(`${prefix} ${c}`), `${prefix} ${c}`).not.toBe("none");
    }
  });

  it("forbids the gh and wrangler commands that give the human approval", () => {
    for (const c of ["gh pr merge 3 --squash", "gh pr ready 3", "gh secret set X", "gh api repos/o/r", "gh workflow run x.yml", "gh label create x", "wrangler deploy", "npx wrangler deploy", "script -q /dev/null ls"]) {
      expect(decide(c), c).toBe("forbidden");
    }
    for (const c of ["gh pr edit 3 --add-label media-ok", "gh pr create --label media-ok"]) expect(decide(c), c).toBe("prompt");
  });

  it("leaves the read and draft commands alone", () => {
    for (const c of ["npx weekpost check", "npx weekpost generate", "npx weekpost sources pull 2026-W46", "npx weekpost status", "npx weekpost doctor --json", "npx weekpost agent-env", "git status", "gh pr list"]) {
      expect(decide(c), c).toBe("none");
    }
  });

  it("sets the sandbox to workspace-write without network and asks for approval on request", () => {
    const toml = readFileSync(join(TEMPLATE_DIR, ".codex/config.toml"), "utf8");
    expect(toml).toMatch(/^approval_policy = "on-request"$/m);
    expect(toml).toMatch(/^sandbox_mode = "workspace-write"$/m);
    expect(toml).toMatch(/^network_access = false$/m);
  });
});
