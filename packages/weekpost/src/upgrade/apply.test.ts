import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUpgrade, type UpgradeDeps } from "../cli/upgrade.ts";
import type { RunResult, Runner } from "../setup/runner.ts";
import { buildLock, renderTemplate, serializeLock, sha256, TEMPLATE_DIR, type Answers } from "../setup/template.ts";
import type { Choice } from "./apply.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "weekpost-upgrade-"));
  dirs.push(d);
  return d;
};
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
const commit = (cwd: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "x", "--allow-empty");
};

const answers: Answers = { brandName: "My App", accounts: [{ handle: "myapp", lang: "en", timeZone: "Europe/London", hemisphere: "north" }], pillars: ["tip"], cta: ["link in bio"] };
const FILES = [".github/workflows/weekpost-check.yml", "worker/wrangler.toml", "AGENTS.md"];
const TODAY = new Date("2026-11-01T00:00:00Z");

/** Two tiny templates (0.1.0 and 0.2.0) whose three generated files all differ. */
function templates() {
  const root = tmp();
  for (const v of ["v1", "v2"]) for (const f of FILES) put(join(root, v), f, `${f} ${v}\nline\n`);
  return { v1: join(root, "v1"), v2: join(root, "v2") };
}

/** A git project made by "weekpost 0.1.0": files, a lock, and a config that loads without installing weekpost. */
function project(v1: string) {
  const dir = tmp();
  const rendered = renderTemplate(answers, { root: v1, today: TODAY });
  for (const f of rendered) put(dir, f.path, f.content.toString());
  writeFileSync(join(dir, "weekpost.lock.json"), serializeLock(buildLock(rendered, answers, TODAY, "0.1.0")));
  const config = readFileSync(join(TEMPLATE_DIR, "weekpost.config.ts"), "utf8").replace(/import .*\n/, "").replace("defineConfig(", "(");
  put(dir, "weekpost.config.ts", config);
  cpSync(join(TEMPLATE_DIR, "assets"), join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "content"));
  git(dir, "init", "-q");
  commit(dir);
  return dir;
}

const mtimes = (root: string) => {
  const out: Record<string, number> = {};
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && !e.parentPath.includes(".git")) out[join(e.parentPath, e.name)] = statSync(join(e.parentPath, e.name)).mtimeMs;
  }
  return out;
};

function setup(dir: string, v2: string, over: { tty?: boolean; choices?: Record<string, Choice>; yes?: boolean; failMigrate?: boolean; installed?: string } = {}) {
  const lines: string[] = [];
  const calls: string[] = [];
  const asked: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) };
  const home = tmp();
  const run: Runner = async (cmd, args, opts): Promise<RunResult> => {
    if (cmd === "git") {
      try {
        return { status: 0, stdout: execFileSync("git", args, { cwd: opts?.cwd, env: GIT_ENV, stdio: "pipe" }).toString(), stderr: "" };
      } catch {
        return { status: 1, stdout: "", stderr: "" };
      }
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  const deps: UpgradeDeps = {
    tty: over.tty ?? true,
    installed: over.installed ?? "0.2.0",
    now: TODAY,
    templateRoot: v2,
    run,
    setup: { env: {}, home, run, fetch: async () => Promise.reject(new Error("no network in tests")), hasChromium: async () => false },
    confirm: async (q) => {
      asked.push(q);
      return over.yes ?? false;
    },
    choose: async (q) => over.choices?.[FILES.find((f) => q.includes(f)) ?? ""] ?? "keep",
    // The fake `runApply`: records what ran and what the project looked like at that moment.
    runApply: async (_ctx, _out, confirm, d) => {
      const only = d?.only ?? "?";
      calls.push(`${only}${only === "db.migrate" ? `:${read(dir, "AGENTS.md").includes("v1") ? "files-old" : "files-new"}` : ""}`);
      if (only === "db.migrate") return over.failMigrate ? 1 : 0;
      if (only === "worker.deploy" && (await confirm("run worker.deploy?"))) calls.push("deployed");
      return 0;
    },
  };
  return { deps, lines, calls, asked, out, run: (args: string[]) => runUpgrade(args, out, dir, deps) };
}

describe("weekpost upgrade --apply", () => {
  it("refuses without a terminal: exit 2 and no file is touched", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const before = mtimes(dir);
    const t = setup(dir, v2, { tty: false });
    expect(await t.run(["--apply"])).toBe(2);
    expect(t.lines.join("\n")).toMatch(/needs an interactive terminal/);
    expect(t.calls).toEqual([]);
    expect(mtimes(dir)).toEqual(before);
  });

  it("has no --yes", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const t = setup(dir, v2);
    expect(await t.run(["--apply", "--yes"])).toBe(2);
    expect(t.calls).toEqual([]);
  });

  it("migrates before it writes any file, then updates files and the lock", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const t = setup(dir, v2);
    expect(await t.run(["--apply"])).toBe(0);
    expect(t.calls[0]).toBe("db.migrate:files-old");
    expect(t.calls[1]).toBe("worker.deploy");
    for (const f of FILES) expect(read(dir, f)).toBe(`${f} v2\nline\n`);
    const lock = JSON.parse(read(dir, "weekpost.lock.json"));
    expect(lock.weekpost).toBe("0.2.0");
    for (const f of FILES) expect(lock.files[f]).toBe(sha256(`${f} v2\nline\n`));
    expect(t.lines.join("\n")).toMatch(/commit them and open a pull request/);
  });

  it("stops with the files intact when the migration fails", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const before = mtimes(dir);
    const t = setup(dir, v2, { failMigrate: true });
    expect(await t.run(["--apply"])).toBe(1);
    expect(t.calls).toEqual(["db.migrate:files-old"]);
    expect(mtimes(dir)).toEqual(before);
  });

  it("asks keep / take the new / save next to it for each edited file", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    for (const f of FILES) put(dir, f, `${f} mine\n`);
    commit(dir);
    const t = setup(dir, v2, { choices: { [FILES[0]!]: "keep", [FILES[1]!]: "take", [FILES[2]!]: "side" } });
    expect(await t.run(["--apply"])).toBe(0);
    expect(read(dir, FILES[0]!)).toBe(`${FILES[0]} mine\n`);
    expect(existsSync(join(dir, `${FILES[0]}.weekpost-new`))).toBe(false);
    expect(read(dir, FILES[1]!)).toBe(`${FILES[1]} v2\nline\n`);
    expect(read(dir, FILES[2]!)).toBe(`${FILES[2]} mine\n`);
    expect(read(dir, `${FILES[2]}.weekpost-new`)).toBe(`${FILES[2]} v2\nline\n`);
    expect(t.lines.join("\n")).toMatch(/- is your file, \+ is the new one/);
  });

  it("deploys the Worker only when you confirm", async () => {
    const { v1, v2 } = templates();
    const no = setup(project(v1), v2, { yes: false });
    expect(await no.run(["--apply"])).toBe(0);
    expect(no.calls).toContain("worker.deploy");
    expect(no.calls).not.toContain("deployed");

    const yes = setup(project(v1), v2, { yes: true });
    expect(await yes.run(["--apply"])).toBe(0);
    expect(yes.calls).toContain("deployed");
  });

  it("a second --apply changes nothing, and kept files are not asked about again", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    put(dir, FILES[1]!, "mine\n");
    commit(dir);
    const first = setup(dir, v2, { yes: true });
    expect(await first.run(["--apply"])).toBe(0);
    expect(read(dir, FILES[1]!)).toBe("mine\n");

    // Not committed yet: it refuses and writes nothing.
    const before = mtimes(dir);
    const early = setup(dir, v2, { yes: true });
    expect(await early.run(["--apply"])).toBe(1);
    expect(mtimes(dir)).toEqual(before);

    commit(dir);
    const second = setup(dir, v2, { yes: true });
    expect(await second.run(["--apply"])).toBe(0);
    expect(second.lines.join("\n")).toMatch(/Already up to date/);
    expect(second.calls).toEqual([]);
    expect(mtimes(dir)).toEqual(before);
  });
});

describe("template permissions", () => {
  it("denies the agent from running upgrade --apply but not --plan", () => {
    const deny = (JSON.parse(readFileSync(join(TEMPLATE_DIR, ".claude/settings.json"), "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain("Bash(*weekpost*upgrade*--apply*)");
  });
});
