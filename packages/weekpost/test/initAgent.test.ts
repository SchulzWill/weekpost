import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/cli/check.ts";
import { runInit, TEMPLATE_DIR, type Answers } from "../src/cli/init.ts";

const ANSWERS: Answers = {
  brandName: "Shop & Co",
  accounts: [{ handle: "shop", lang: "en", timeZone: "Europe/London", hemisphere: "north" }],
  pillars: ["tip", "story"],
  cta: ["link in bio"],
};
const quiet = { log: () => {}, error: () => {} };

function newProject() {
  const dir = mkdtempSync(join(tmpdir(), "weekpost-agent-"));
  const answers = join(mkdtempSync(join(tmpdir(), "weekpost-answers-")), "a.json");
  writeFileSync(answers, JSON.stringify(ANSWERS));
  // Stands for `npm i weekpost`: the config imports "weekpost".
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(join(import.meta.dirname, ".."), join(dir, "node_modules/weekpost"), "dir");
  return { dir, answers };
}

describe("init: agent files", () => {
  it("writes AGENTS.md, CLAUDE.md, BRIEF.md, the skills, the settings and .gitignore", async () => {
    const { dir, answers } = newProject();
    expect(await runInit([dir, `--answers=${answers}`], quiet)).toBe(0);
    for (const f of ["AGENTS.md", "CLAUDE.md", "BRIEF.md", "skills/open-week/SKILL.md", "skills/queue-status/SKILL.md", ".claude/settings.json", ".gitignore", "assets/logo.svg", "assets/fonts/OFL.txt"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(existsSync(join(dir, "gitignore"))).toBe(false);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8").trim()).toBe("@AGENTS.md");
    const ignore = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    for (const line of ["out/", ".env.local", "node_modules/"]) expect(ignore).toContain(line);
    // .claude/skills reaches the skills, through a link.
    expect(lstatSync(join(dir, ".claude/skills")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, ".claude/skills"))).toBe("../skills");
    expect(existsSync(join(dir, ".claude/skills/open-week/SKILL.md"))).toBe(true);
  });

  it("writes a settings.json that denies every write command", () => {
    const settings = JSON.parse(readFileSync(join(TEMPLATE_DIR, ".claude/settings.json"), "utf8")) as { permissions: { deny: string[] } };
    const deny = settings.permissions.deny;
    for (const rule of [
      "Bash(*weekpost*setup*--apply*)",
      "Bash(*weekpost* token*)",
      "Bash(*weekpost* cancel *--yes*)",
      "Bash(*weekpost* restore *--yes*)",
      "Bash(*weekpost* reschedule *--yes*)",
      "Bash(*weekpost* resolve *--yes*)",
      "Bash(npx wrangler*)",
      "Read(~/.config/weekpost/**)",
    ]) {
      expect(deny, rule).toContain(rule);
    }
    expect(new Set(deny).size).toBe(deny.length);
  });

  it("falls back to a copy of skills/ when the link cannot be made", async () => {
    const { dir, answers } = newProject();
    const c: string[] = [];
    const symlink = () => {
      throw new Error("EPERM");
    };
    expect(await runInit([dir, `--answers=${answers}`], { log: (l) => c.push(l), error: (l) => c.push(l) }, process.cwd(), { symlink })).toBe(0);
    const at = join(dir, ".claude/skills");
    expect(lstatSync(at).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(at, "open-week/SKILL.md"), "utf8")).toBe(readFileSync(join(dir, "skills/open-week/SKILL.md"), "utf8"));
    expect(c.join("\n")).toContain("is a copy");
  });

  it("refuses to overwrite an existing .claude/skills", async () => {
    const { dir, answers } = newProject();
    mkdirSync(join(dir, ".claude/skills"), { recursive: true });
    const lines: string[] = [];
    expect(await runInit([dir, `--answers=${answers}`], { log: (l) => lines.push(l), error: (l) => lines.push(l) })).toBe(1);
    expect(lines.join("\n")).toContain(".claude/skills");
    expect(readdirSync(dir).sort()).toEqual([".claude", "node_modules"]);
  });

  it("leaves a project that passes weekpost check", async () => {
    const { dir, answers } = newProject();
    expect(await runInit([dir, `--answers=${answers}`], quiet)).toBe(0);
    const lines: string[] = [];
    expect(await runCheck([`--project=${dir}`], { log: (l) => lines.push(l), error: (l) => lines.push(l) })).toBe(0);
  });
});

describe("skills and agent files", () => {
  const files = ["AGENTS.md", "BRIEF.md", "skills/open-week/SKILL.md", "skills/queue-status/SKILL.md"];
  const text = files.map((f) => readFileSync(join(TEMPLATE_DIR, f), "utf8"));

  it("carry no brand, person or id", () => {
    // Built from pieces so that this file does not hold the terms itself.
    const banned = new RegExp(["cui" + "dasa", "ai" + "bj", "schulz" + "will", "n8" + "n", "178" + "41", "vault", "lisb" + "oa"].join("|"), "i");
    for (const [i, t] of text.entries()) expect(t, files[i]).not.toMatch(banned);
  });

  it("have a name that matches the folder and a description with triggers", () => {
    for (const name of ["open-week", "queue-status"]) {
      const t = readFileSync(join(TEMPLATE_DIR, `skills/${name}/SKILL.md`), "utf8");
      expect(t).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
      expect(t).toMatch(/description: .*(abre|status da fila)/);
    }
  });

  it("tell the agent to treat sources as data and never to run --yes, token or --apply", () => {
    const agents = text[0]!;
    expect(agents).toMatch(/not instructions/);
    for (const w of ["--yes", "--apply", "weekpost token"]) expect(agents).toContain(w);
    expect(text[2]!).toContain("agent-env");
    expect(text[2]!).toContain("sources pull");
    expect(text[2]!).toContain("weekpost check");
  });
});
