import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit, TEMPLATE_DIR } from "../src/cli/init.ts";
import { stepsFor } from "../src/setup/steps.ts";

const SKILL = readFileSync(join(TEMPLATE_DIR, "skills/setup-guide/SKILL.md"), "utf8");
const MAIN = readFileSync(join(import.meta.dirname, "../src/cli/main.ts"), "utf8");
const quiet = { log: () => {}, error: () => {} };

describe("setup-guide skill", () => {
  it("has a name that matches the folder and triggers in English and Portuguese", () => {
    expect(SKILL).toMatch(/^---\nname: setup-guide\ndescription: .+\n---\n/);
    const desc = /description: (.+)/.exec(SKILL)![1]!;
    for (const t of ["set up", "install", "doctor failed", "instalar", "configurar"]) expect(desc).toContain(t);
  });

  it("is copied by init and reachable from .claude/skills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-guide-"));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(join(import.meta.dirname, ".."), join(dir, "node_modules/weekpost"), "dir");
    const answers = join(mkdtempSync(join(tmpdir(), "weekpost-guide-a-")), "a.json");
    writeFileSync(answers, JSON.stringify({ brandName: "Shop", accounts: [{ handle: "shop", lang: "en", timeZone: "Europe/London", hemisphere: "north" }], pillars: ["tip"], cta: ["link in bio"] }));
    expect(await runInit([dir, `--answers=${answers}`], quiet)).toBe(0);
    expect(existsSync(join(dir, "skills/setup-guide/SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude/skills/setup-guide/SKILL.md"))).toBe(true);
  });

  it("never asks the person to paste a secret", () => {
    // Any line that tells someone to paste/type/send a key, token, password or connection string to the agent.
    const ask = /\b(paste|cole|send me|type)\b[^.\n]*\b(key|token|password|secret|connection string|chave|senha)\b/i;
    for (const line of SKILL.split("\n")) {
      if (ask.test(line)) expect(line, line).toMatch(/\b(never|not|nunca|não|hidden|prompt)\b/i);
    }
    expect(SKILL).toMatch(/Never make the person type or paste/);
  });

  it("cites only weekpost commands, options and step ids that exist", () => {
    const commands = new Set([...MAIN.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!));
    const cited = [...SKILL.matchAll(/npx weekpost ([a-z-]+)/g)].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(5);
    for (const c of cited) expect(commands, `weekpost ${c}`).toContain(c);

    const stepIds = new Set(stepsFor({ accounts: [], previewLabel: "x", bucket: "b", project: "p", latestSchema: 1 }).map((s) => s.id));
    const only = [...SKILL.matchAll(/--only=([a-z.]+)/g)].map((m) => m[1]!);
    expect(only.length).toBeGreaterThan(5);
    for (const id of only) expect(stepIds, id).toContain(id);
  });

  it("maps every id that doctor can report", () => {
    const doctor = readFileSync(join(import.meta.dirname, "../src/cli/doctor.ts"), "utf8");
    for (const id of ["config", "node", "chromium", "logins", "openrouter", "supabase.key", "supabase.schema", "supabase.bucket", "worker.deployed", "secrets.worker", "secrets.actions", "secrets.environment", "secrets.local", "github.label", "github.workflows", "graph.version"]) {
      expect(doctor, id).toContain(`"${id}"`);
      expect(SKILL, id).toContain(`\`${id}\``);
    }
    expect(SKILL).toContain("`token.<account>`");
  });
});
