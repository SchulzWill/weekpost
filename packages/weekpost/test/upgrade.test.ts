// weekpost upgrade --plan, in a temporary directory that is a real git repository.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/cli/init.ts";
import { main } from "../src/cli/main.ts";
import { runUpgrade } from "../src/cli/upgrade.ts";
import { checkContent } from "../src/content/load.ts";
import { testConfig } from "../src/content/fixtures.ts";
import { spawnRunner, type Runner } from "../src/setup/runner.ts";
import { LOCK_FILE, TEMPLATE_DIR, type Answers } from "../src/setup/template.ts";
import { unifiedDiff } from "../src/upgrade/diff.ts";
import { compareVersions } from "../src/upgrade/plan.ts";

const NOW = new Date("2026-11-01T12:00:00Z");
const ANSWERS: Answers = { brandName: "Shop", accounts: [{ handle: "shop_en", lang: "en", timeZone: "Europe/London", hemisphere: "north" }], pillars: ["tip", "story"], cta: ["link in bio"], previewLabel: "ok-to-post" };

const cap = () => {
  const lines: string[] = [];
  return { text: () => lines.join("\n"), out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) } };
};
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
const commit = (dir: string, message = "wip") => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
};

/** Only git runs for real; gh, wrangler and the rest answer "not available". */
const run: Runner = async (cmd, args, opts) => (cmd === "git" ? spawnRunner(cmd, args, opts) : { status: 1, stdout: "", stderr: "" });
const calls: string[] = [];
const noNetwork = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push(`${init?.method ?? "GET"} ${String(url)}`);
  return new Response("[]", { status: 200 });
}) as typeof fetch;
const deps = (over: Record<string, unknown> = {}) => ({
  installed: "0.2.0",
  now: NOW,
  run,
  setup: { env: {}, home: mkdtempSync(join(tmpdir(), "wp-up-home-")), hasChromium: async () => false, fetch: noNetwork },
  ...over,
});

async function project(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wp-up-"));
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(join(import.meta.dirname, ".."), join(dir, "node_modules/weekpost"), "dir");
  const answers = join(dir, "..", `${dir.split("/").pop()}-answers.json`);
  writeFileSync(answers, JSON.stringify(ANSWERS));
  expect(await runInit([dir, `--answers=${answers}`], cap().out)).toBe(0);
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "init");
  return dir;
}

/** A copy of the shipped template where `edit` has changed some files (the "new version"). */
function newTemplate(edit: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "wp-up-tpl-"));
  cpSync(TEMPLATE_DIR, root, { recursive: true });
  edit(root);
  return root;
}
const append = (root: string, file: string, text: string) => writeFileSync(join(root, file), readFileSync(join(root, file), "utf8") + text);

const post = (date: string, caption = "Spots.") => `version: 1
posts:
  - id: ${date}-story-open
    date: ${date}
    type: story
    accounts: [en]
    times: { en: "11:00" }
    pillar: tip
    story: { text: { en: "Open spots." }, link_utm_content: story-${date} }
    caption: { en: "${caption}" }
    cta: { en: "link in bio" }
    link: { en: "https://myapp.example/?utm_source=instagram&utm_medium=social&utm_campaign=en&utm_content=story-${date}" }
`;
const addWeek = (dir: string, week: string, yaml: string) => {
  mkdirSync(join(dir, "content", week), { recursive: true });
  writeFileSync(join(dir, "content", week, "posts.yaml"), yaml);
};
const PAST = "2026-10-12"; // 2026-W42, before NOW
const FUTURE = "2027-03-01"; // 2027-W09

/** Every file in the project outside .git and node_modules, with its size and mtime: nothing may change. */
const fingerprint = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !String(e.parentPath).includes(".git") && !String(e.parentPath).includes("node_modules"))
    .map((e) => `${join(e.parentPath, e.name)}:${statSync(join(e.parentPath, e.name)).mtimeMs}:${statSync(join(e.parentPath, e.name)).size}`)
    .sort();

const plan = async (dir: string, over: Record<string, unknown> = {}, args: string[] = []) => {
  const c = cap();
  const code = await runUpgrade(["--plan", "--json", `--project=${dir}`, ...args], c.out, dir, deps(over));
  return { code, json: JSON.parse(c.text()) as any };
};

describe("weekpost upgrade --plan", () => {
  it("has nothing to change when the project matches the new version", async () => {
    const dir = await project();
    const before = fingerprint(dir);
    const c = cap();
    const code = await runUpgrade(["--plan", `--project=${dir}`], c.out, dir, deps());
    expect(code).toBe(0);
    expect(c.text()).toContain("Nothing blocks the upgrade");
    expect(c.text()).toContain("0 to change");
    expect(fingerprint(dir)).toEqual(before);
    const { json } = await plan(dir);
    expect(json).toMatchObject({ blocked: false, lockVersion: "0.1.0", installed: "0.2.0", files: [], blockers: [] });
    // The setup steps that are still todo are listed (here Chromium, which the fake says is missing).
    expect(json.steps.map((s: any) => s.id)).toContain("project.deps");
    // The only network calls are GETs.
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("lists update, new and removed files for a newer template, and keeps the custom preview label out of it", async () => {
    const dir = await project();
    const templateRoot = newTemplate((root) => {
      append(root, "AGENTS.md", "\nA new rule.\n");
      writeFileSync(join(root, "skills/open-week/EXTRA.md"), "new file\n");
      rmSync(join(root, "worker/wrangler.toml"));
    });
    const { code, json } = await plan(dir, { templateRoot });
    expect(code).toBe(0);
    const by = Object.fromEntries(json.files.map((f: any) => [f.path, f.state]));
    expect(by["AGENTS.md"]).toBe("update");
    expect(by["skills/open-week/EXTRA.md"]).toBe("new");
    expect(by["worker/wrangler.toml"]).toBe("removed");
    // The workflows carry "ok-to-post" on disk and in the new render: not an edit, not a change.
    expect(Object.keys(by).some((p) => p.startsWith(".github/workflows/"))).toBe(false);
  });

  it("shows a unified diff for a file you edited and leaves your file alone", async () => {
    const dir = await project();
    append(dir, "worker/wrangler.toml", "# mine\n");
    commit(dir, "my edit");
    const templateRoot = newTemplate((root) => append(root, "worker/wrangler.toml", "# theirs\n"));
    const before = fingerprint(dir);
    const c = cap();
    const code = await runUpgrade(["--plan", `--project=${dir}`], c.out, dir, deps({ templateRoot }));
    expect(code).toBe(0);
    expect(c.text()).toMatch(/edited\s+worker\/wrangler.toml/);
    expect(c.text()).toContain("--- a/worker/wrangler.toml");
    expect(c.text()).toContain("-# mine");
    expect(c.text()).toContain("+# theirs");
    expect(fingerprint(dir)).toEqual(before);
  });

  it("leaves an edit alone when the new template does not change that file", async () => {
    const dir = await project();
    append(dir, "worker/wrangler.toml", "# mine\n");
    commit(dir, "my edit");
    const { json } = await plan(dir);
    expect(json.files).toEqual([]);
    expect(json.unchanged).toBeGreaterThan(0);
  });

  it("handles a project without a lock: same as the new template is update, different is edited", async () => {
    const dir = await project();
    rmSync(join(dir, LOCK_FILE));
    append(dir, "worker/wrangler.toml", "# mine\n");
    commit(dir, "old project");
    const { code, json } = await plan(dir);
    expect(code).toBe(0);
    expect(json.lockVersion).toBeNull();
    expect(json.warnings.join("\n")).toMatch(/no weekpost.lock.json/);
    const by = Object.fromEntries(json.files.map((f: any) => [f.path, f]));
    expect(by["worker/wrangler.toml"].state).toBe("edited");
    expect(by["worker/wrangler.toml"].diff).toContain("-# mine");
    expect(by["AGENTS.md"].state).toBe("update");
    // The preview label comes from the config, so the workflows still match.
    expect(by[".github/workflows/weekpost-preview.yml"].state).toBe("update");
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it("blocks and exits 1 on a contract error, naming the week, and writes nothing", async () => {
    const dir = await project();
    addWeek(dir, "2026-W42", post(PAST).replace("version: 1", "version: 99"));
    commit(dir, "week");
    const before = fingerprint(dir);
    const c = cap();
    expect(await runUpgrade(["--plan", `--project=${dir}`], c.out, dir, deps())).toBe(1);
    expect(c.text()).toMatch(/BLOCKED\s+2026-W42: 2026-W42 version/);
    expect(c.text()).toContain("Nothing was written");
    expect(fingerprint(dir)).toEqual(before);
    const { json } = await plan(dir);
    expect(json.blockers).toEqual([expect.objectContaining({ item: 4, week: "2026-W42" })]);
  });

  it("makes a lint error in a past week a warning, and the same error in a future week a block", async () => {
    const dir = await project();
    addWeek(dir, "2026-W42", post(PAST, "Spots at https://example.com"));
    commit(dir, "past week");
    const past = await plan(dir);
    expect(past.code).toBe(0);
    expect(past.json.content.errors).toEqual([]);
    expect(past.json.content.warnings.length).toBeGreaterThan(0);
    expect(past.json.content.warnings[0]).toMatchObject({ level: "warn", week: "2026-W42" });

    addWeek(dir, "2027-W09", post(FUTURE, "Spots at https://example.com"));
    commit(dir, "future week");
    const future = await plan(dir);
    expect(future.code).toBe(1);
    expect(future.json.blockers.map((b: any) => b.week)).toEqual(["2027-W09"]);
    expect(future.json.content.warnings.every((w: any) => w.week === "2026-W42")).toBe(true);
  });

  it("blocks on a downgrade, on uncommitted generated files and on a config that does not load", async () => {
    const dir = await project();
    const down = await plan(dir, { installed: "0.0.9" });
    expect(down.code).toBe(1);
    expect(down.json.blockers[0]).toMatchObject({ item: 1 });
    expect(down.json.blockers[0].message).toMatch(/downgrade/);

    append(dir, "AGENTS.md", "\nunsaved\n");
    const dirty = await plan(dir);
    expect(dirty.code).toBe(1);
    expect(dirty.json.blockers[0]).toMatchObject({ item: 2 });
    expect(dirty.json.blockers[0].message).toContain("AGENTS.md");
    commit(dir, "save");

    writeFileSync(join(dir, "weekpost.config.ts"), "export default { nope: true };\n");
    commit(dir, "break config");
    const bad = await plan(dir);
    expect(bad.code).toBe(1);
    expect(bad.json.blockers[0]).toMatchObject({ item: 3 });
    expect(bad.json.blockers[0].message).toMatch(/You need to do/);
    expect(bad.json.files).not.toBeNull(); // the lock still renders the plan
  });

  it("blocks outside a git repository", async () => {
    const dir = await project();
    rmSync(join(dir, ".git"), { recursive: true });
    const { code, json } = await plan(dir);
    expect(code).toBe(1);
    expect(json.blockers[0]).toMatchObject({ item: 2 });
  });

  it("reports pending migrations from the REST API, and unknown without credentials", async () => {
    const dir = await project();
    expect((await plan(dir)).json.migrations.state).toBe("unknown");
    const fetch = (async () => new Response(JSON.stringify([{ version: 2 }]), { status: 200 })) as typeof globalThis.fetch;
    const { json } = await plan(dir, { setup: { env: { WEEKPOST_SUPABASE_URL: "https://x.supabase.co", WEEKPOST_SUPABASE_KEY: "k" }, home: mkdtempSync(join(tmpdir(), "wp-up-home-")), hasChromium: async () => true, fetch } });
    expect(json.migrations.state).toBe("pending");
    expect(json.migrations.pending[0]).toMatch(/^0003_/);
  });

  it("prints --json that parses, and is reachable through the CLI with a usage error otherwise", async () => {
    const dir = await project();
    const { json } = await plan(dir);
    expect(Object.keys(json)).toEqual(expect.arrayContaining(["blocked", "installed", "lockVersion", "blockers", "warnings", "content", "migrations", "files", "steps"]));
    const c = cap();
    expect(await runUpgrade([], c.out, dir)).toBe(2);
    expect(await runUpgrade(["--plan", "--bogus"], c.out, dir)).toBe(2);
    expect(await runUpgrade(["--apply"], c.out, dir)).toBe(2);
    expect(c.text()).toContain("not available in this version");
    expect(await main(["upgrade"])).toBe(2);
  });
});

describe("checkContent past weeks", () => {
  it("keeps the old behavior without the option", () => {
    const root = mkdtempSync(join(tmpdir(), "wp-up-content-"));
    expect(checkContent(root, testConfig()).issues).toEqual([]);
  });
});

describe("helpers", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "1.0.0")).toBeLessThan(0);
  });
  it("writes a unified diff with hunks and context", () => {
    const a = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const b = a.replace("line 2\n", "two\n").replace("line 10\n", "ten\n");
    const d = unifiedDiff("f.txt", a, b);
    expect(d).toContain("--- a/f.txt");
    expect(d.match(/^@@/gm)).toHaveLength(2);
    expect(d).toContain("-line 2\n+two");
    expect(unifiedDiff("f.txt", a, a)).toBe("");
  });
});
