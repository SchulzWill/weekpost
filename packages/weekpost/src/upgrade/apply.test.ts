import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUpgrade, type UpgradeDeps } from "../cli/upgrade.ts";
import type { RunResult, Runner } from "../setup/runner.ts";
import { buildLock, renderTemplate, serializeLock, sha256, TEMPLATE_DIR, type Answers } from "../setup/template.ts";
import type { Actions } from "../setup/apply.ts";
import { remoteActions } from "../setup/remote.ts";
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
    if (e.isFile() && !e.parentPath.split(sep).includes(".git")) out[join(e.parentPath, e.name)] = statSync(join(e.parentPath, e.name)).mtimeMs;
  }
  return out;
};

function setup(dir: string, v2: string, over: { tty?: boolean; choices?: Record<string, Choice>; yes?: boolean; failMigrate?: boolean; installed?: string; fake?: boolean; actions?: Actions; deployYes?: boolean; onMigrate?: () => void; schema?: number } = {}) {
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
    setup: { env: over.schema === undefined ? {} : { WEEKPOST_SUPABASE_URL: "https://abc.supabase.co", WEEKPOST_SUPABASE_KEY: "sb_secret_test" }, home, run, fetch: async () => (over.schema === undefined ? Promise.reject(new Error("no network in tests")) : new Response(JSON.stringify([{ version: over.schema }]), { status: 200 })), hasChromium: async () => false },
    confirm: async (q) => {
      asked.push(q);
      return over.yes ?? false;
    },
    choose: async (q) => over.choices?.[FILES.find((f) => q.includes(f)) ?? ""] ?? "keep",
    ...(over.actions ? { actions: over.actions } : {}),
    // The fake `runApply`: records what ran and what the project looked like at that moment.
    ...(over.fake === false ? {} : { runApply: async (_ctx, _out, confirm, d) => {
      const only = d?.only ?? "?";
      calls.push(`${only}${only === "db.migrate" ? `:${read(dir, "AGENTS.md").includes("v1") ? "files-old" : "files-new"}` : ""}`);
      if (only === "db.migrate") {
        over.onMigrate?.();
        return over.failMigrate ? 1 : 0;
      }
      if (only === "worker.deploy" && (await confirm("run worker.deploy?"))) calls.push("deployed");
      return 0;
    } }),
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
    expect(t.lines.join("\n")).toMatch(/then commit and open a pull request/);
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
    expect(await early.run(["--apply"])).toBe(0);
    expect(early.lines.join("\n")).toMatch(/already done.*Commit the changes/);
    expect(early.calls).toEqual([]);
    expect(mtimes(dir)).toEqual(before);

    commit(dir);
    const second = setup(dir, v2, { yes: true });
    expect(await second.run(["--apply"])).toBe(0);
    expect(second.lines.join("\n")).toMatch(/nothing was changed. The database was not checked/);
    expect(second.calls).toEqual([]);
    expect(mtimes(dir)).toEqual(before);
  });
});

const SQL_ACTIONS = (log: string[]): Actions => ({
  "db.migrate": async (io) => {
    log.push(io.options.print ? "printed" : "migrated");
    if (io.options.print) io.out.log("-- the SQL");
  },
});

describe("weekpost upgrade --apply: review fixes", () => {
  it("--print with an unknown schema version stops without printing every migration and changes nothing", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const before = mtimes(dir);
    const log: string[] = [];
    const t = setup(dir, v2, { fake: false, actions: SQL_ACTIONS(log), yes: true });
    expect(await t.run(["--apply", "--print"])).toBe(1);
    expect(log).toEqual([]);
    expect(t.lines.join("\n")).toMatch(/needs the Supabase URL and secret key.*local\.secrets/);
    expect(mtimes(dir)).toEqual(before);
  });

  it("--print only prints the SQL: no file, no lock, no deploy", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const before = mtimes(dir);
    const log: string[] = [];
    const t = setup(dir, v2, { fake: false, actions: SQL_ACTIONS(log), yes: true, schema: 0 });
    expect(await t.run(["--apply", "--print"])).toBe(1);
    expect(log).toEqual(["printed"]);
    expect(t.lines.join("\n")).toMatch(/printed, not run.*without --print/);
    expect(t.asked.some((q) => q.includes("worker.deploy"))).toBe(false);
    expect(mtimes(dir)).toEqual(before);
  });

  it("answering n at db.migrate (real step runner) changes no file", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const before = mtimes(dir);
    const log: string[] = [];
    const t = setup(dir, v2, { fake: false, actions: SQL_ACTIONS(log), yes: false });
    expect(await t.run(["--apply"])).toBe(1);
    expect(log).toEqual([]);
    expect(mtimes(dir)).toEqual(before);
  });

  it("runs the migration for real with yes, then writes files (real step runner)", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const log: string[] = [];
    const t = setup(dir, v2, { fake: false, actions: { ...SQL_ACTIONS(log), "worker.deploy": async () => void log.push("deployed") }, yes: true });
    expect(await t.run(["--apply"])).toBe(0);
    expect(log).toEqual(["migrated", "deployed"]);
    expect(read(dir, "AGENTS.md")).toContain("v2");
  });

  it("refuses a generated file that is a symlink, and writes nothing through it", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const victim = join(tmp(), "victim.txt");
    writeFileSync(victim, "precious\n");
    rmSync(join(dir, "AGENTS.md"));
    symlinkSync(victim, join(dir, "AGENTS.md"));
    commit(dir);
    const t = setup(dir, v2);
    expect(await t.run(["--apply"])).toBe(1);
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(t.lines.join("\n")).toMatch(/AGENTS.md is \(or is inside\) a symbolic link/);
    expect(t.calls).toEqual([]);
  });

  it("refuses a folder that is a symlink out of the project", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const outside = tmp();
    put(outside, "wrangler.toml", "outside\n");
    rmSync(join(dir, "worker"), { recursive: true });
    symlinkSync(outside, join(dir, "worker"));
    commit(dir);
    const t = setup(dir, v2);
    expect(await t.run(["--apply"])).toBe(1);
    expect(read(outside, "wrangler.toml")).toBe("outside\n");
    expect(t.calls).toEqual([]);
  });

  it("an interrupted run can simply be run again, and leaves no temporary file", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    put(dir, FILES[0]!, `${FILES[0]} v2\nline\n`); // written by the run that was interrupted
    const t = setup(dir, v2, { yes: true });
    expect(await t.run(["--apply"])).toBe(0);
    for (const f of FILES) expect(read(dir, f)).toBe(`${f} v2\nline\n`);
    expect(JSON.parse(read(dir, "weekpost.lock.json")).weekpost).toBe("0.2.0");
    expect(Object.keys(mtimes(dir)).some((f) => f.includes("weekpost-tmp"))).toBe(false);
  });

  it("a declined deploy is said out loud, remembered, and offered again", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const first = setup(dir, v2, { yes: false });
    expect(await first.run(["--apply"])).toBe(0);
    expect(first.lines.join("\n")).toMatch(/not deployed.*weekpost setup --apply --only=worker.deploy/);
    expect(JSON.parse(read(dir, "weekpost.lock.json")).deployPending).toBe(true);
    commit(dir);

    const plan = setup(dir, v2);
    expect(await plan.run(["--plan"])).toBe(0);
    expect(plan.lines.join("\n")).toMatch(/Worker .*not deployed/i);

    const second = setup(dir, v2, { yes: true });
    expect(await second.run(["--apply"])).toBe(0);
    expect(second.calls).toEqual(["worker.deploy", "deployed"]);
    expect("deployPending" in JSON.parse(read(dir, "weekpost.lock.json"))).toBe(false);
    commit(dir);

    const third = setup(dir, v2, { yes: true });
    expect(await third.run(["--apply"])).toBe(0);
    expect(third.calls).toEqual([]);
  });

  it("does not overwrite an existing .weekpost-new that differs", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    put(dir, "AGENTS.md", "mine\n");
    put(dir, "AGENTS.md.weekpost-new", "my half-merged work\n");
    commit(dir);
    const t = setup(dir, v2, { choices: { "AGENTS.md": "side" } });
    expect(await t.run(["--apply"])).toBe(0);
    expect(read(dir, "AGENTS.md.weekpost-new")).toBe("my half-merged work\n");
    expect(read(dir, "AGENTS.md.weekpost-new-2")).toBe("AGENTS.md v2\nline\n");
  });

  it("blocks a lock that lists absolute, .. or .git paths, and deletes nothing", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const victim = join(tmp(), "victim.txt");
    writeFileSync(victim, "precious\n");
    const lock = JSON.parse(read(dir, "weekpost.lock.json"));
    lock.files[victim] = "x";
    lock.files["../outside"] = "x";
    lock.files[".git/config"] = "x";
    writeFileSync(join(dir, "weekpost.lock.json"), serializeLock(lock));
    commit(dir);
    const t = setup(dir, v2, { yes: true });
    expect(await t.run(["--apply"])).toBe(1);
    expect(existsSync(victim)).toBe(true);
    expect(t.lines.join("\n")).toMatch(/absolute path/);
    expect(t.lines.join("\n")).toMatch(/"\.\.\/outside", which has a "\.\." in it/);
    expect(t.lines.join("\n")).toMatch(/inside \.git/);
    expect(t.calls).toEqual([]);
  });

  it("shows the diff of an edited file before asking to delete it", async () => {
    const { v1, v2 } = templates();
    put(v1, "worker/old.toml", "old\n");
    const dir = project(v1);
    put(dir, "worker/old.toml", "old\nmy change\n");
    commit(dir);
    const t = setup(dir, v2, { yes: false });
    expect(await t.run(["--apply"])).toBe(0);
    const text = t.lines.join("\n");
    expect(text).toMatch(/worker\/old.toml has changes of yours:[\s\S]*\+my change/.test(text) ? /./ : /has changes of yours/);
    expect(text.indexOf("has changes of yours")).toBeGreaterThan(-1);
    expect(t.asked.some((q) => q.includes("old.toml") && q.includes("Delete it?"))).toBe(true);
    expect(read(dir, "worker/old.toml")).toBe("old\nmy change\n");
  });

  it("asks again about a file you changed while the database step was running", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const t = setup(dir, v2, { choices: { "AGENTS.md": "keep" }, onMigrate: () => put(dir, "AGENTS.md", "typed during the migration\n") });
    expect(await t.run(["--apply"])).toBe(0);
    expect(read(dir, "AGENTS.md")).toBe("typed during the migration\n");
    expect(t.lines.join("\n")).toMatch(/changed it while the upgrade was running/);
  });

  it("says the migration state is unknown instead of 'up to date'", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    expect(await setup(dir, v2, { yes: true }).run(["--apply"])).toBe(0);
    commit(dir);
    const t = setup(dir, v2);
    expect(await t.run(["--apply"])).toBe(0);
    expect(t.lines.join("\n")).toMatch(/database was not checked.*weekpost setup --plan/);
    expect(t.lines.join("\n")).not.toMatch(/Already up to date/);
  });
});

describe("template permissions", () => {
  it("denies the agent from running upgrade --apply but not --plan", () => {
    const deny = (JSON.parse(readFileSync(join(TEMPLATE_DIR, ".claude/settings.json"), "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain("Bash(*weekpost*upgrade*--apply*)");
  });
});

describe("weekpost upgrade --apply: prompts and wording", () => {
  it("stops cleanly (exit 130, no stack trace) when the terminal closes at a prompt", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    put(dir, "AGENTS.md", "mine\n");
    commit(dir);
    const t = setup(dir, v2);
    t.deps.choose = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    expect(await runUpgrade(["--apply"], t.out, dir, t.deps)).toBe(130);
    expect(t.lines.join("\n")).toMatch(/Stopped\. Steps already done stay done; run `weekpost upgrade --apply` again/);
  });

  it("keeps setup wording out of the upgrade output (real step runner)", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const t = setup(dir, v2, { fake: false, actions: { "db.migrate": async () => {}, "worker.deploy": async () => {} }, yes: true });
    expect(await t.run(["--apply"])).toBe(0);
    const text = t.lines.join("\n");
    expect(text).not.toMatch(/all steps are done|will run:|weekpost setup --apply` again/);
  });

  it("says weekpost is not installed when the config cannot import it", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    put(dir, "weekpost.config.ts", 'import { defineConfig } from "weekpost";\nexport default defineConfig({} as never);\n');
    commit(dir);
    const t = setup(dir, v2);
    expect(await t.run(["--plan"])).toBe(1);
    expect(t.lines.join("\n")).toMatch(/weekpost is not installed in this project; run `npm i -D weekpost` here first/);
  });
});

describe("weekpost upgrade --apply: the pending Worker deploy", () => {
  const declineDeploy = async (dir: string, v2: string) => {
    const first = setup(dir, v2, { yes: false });
    expect(await first.run(["--apply"])).toBe(0);
    expect(first.lines.join("\n")).toMatch(/The upgrade is applied, except for the Worker deploy/);
    expect(JSON.parse(read(dir, "weekpost.lock.json")).deployPending).toBe(true);
    commit(dir);
  };

  it("`setup --apply --only=worker.deploy` clears the flag after a successful deploy, and only then", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    await declineDeploy(dir, v2);
    const ok = async () => ({ status: 0, stdout: "", stderr: "" });
    const io = (run: typeof ok) => ({ out: { log() {}, error() {} }, context: () => ({ projectRoot: dir, run }) }) as never;
    const deploy = remoteActions["worker.deploy"]!;
    await expect(deploy(io(async () => ({ status: 1, stdout: "", stderr: "" })), {} as never)).rejects.toThrow();
    expect(JSON.parse(read(dir, "weekpost.lock.json")).deployPending).toBe(true);
    await deploy(io(ok), {} as never);
    expect("deployPending" in JSON.parse(read(dir, "weekpost.lock.json"))).toBe(false);
  });

  it("keeps the flag and offers the deploy again when a file diverges later (declined deploy, then a new template)", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    await declineDeploy(dir, v2);
    const v3 = join(dirname(v2), "v3");
    for (const f of FILES) put(v3, f, `${f} v3\n`);
    put(dir, "AGENTS.md", "edited\n");
    commit(dir);
    expect(await setup(dir, v3, { yes: false, choices: { "AGENTS.md": "take" } }).run(["--apply"])).toBe(0);
    expect(JSON.parse(read(dir, "weekpost.lock.json")).deployPending).toBe(true);
    const again = setup(dir, v3, { yes: true });
    commit(dir);
    expect(await again.run(["--apply"])).toBe(0);
    expect(again.calls).toEqual(["worker.deploy", "deployed"]);
    expect("deployPending" in JSON.parse(read(dir, "weekpost.lock.json"))).toBe(false);
  });

  it("offers the deploy in the same run as a file change", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    await declineDeploy(dir, v2);
    const v3 = join(dirname(v2), "v3");
    for (const f of FILES) put(v3, f, `${f} v3\n`);
    const t = setup(dir, v3, { yes: true });
    expect(await t.run(["--apply"])).toBe(0);
    expect(t.calls).toContain("deployed");
    expect("deployPending" in JSON.parse(read(dir, "weekpost.lock.json"))).toBe(false);
  });

  it("after the pending deploy goes out, says to commit the lock; when declined it does not say Done", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    await declineDeploy(dir, v2);
    const no = setup(dir, v2, { yes: false });
    expect(await no.run(["--apply"])).toBe(0);
    expect(no.lines.join("\n")).not.toMatch(/Done/);
    const yes = setup(dir, v2, { yes: true });
    expect(await yes.run(["--apply"])).toBe(0);
    expect(yes.lines.join("\n")).toMatch(/Done\. Commit weekpost\.lock\.json\./);
  });

  it("--plan names the pending deploy on its own when no file or migration differs", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    await declineDeploy(dir, v2);
    const t = setup(dir, v2);
    expect(await t.run(["--plan"])).toBe(0);
    const text = t.lines.join("\n");
    expect(text).toMatch(/the Worker was not deployed after the last upgrade: run `weekpost upgrade --apply` or `weekpost setup --apply --only=worker.deploy`/);
    expect(text).not.toMatch(/0 file\(s\)/);
  });

  it("blocks a lock key that names .GIT in any case", async () => {
    const { v1, v2 } = templates();
    const dir = project(v1);
    const lock = JSON.parse(read(dir, "weekpost.lock.json"));
    lock.files[".GIT/config"] = "x";
    writeFileSync(join(dir, "weekpost.lock.json"), serializeLock(lock));
    commit(dir);
    const t = setup(dir, v2);
    expect(await t.run(["--apply"])).toBe(1);
    expect(t.lines.join("\n")).toMatch(/inside \.git/);
  });
});
