import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { runInit, templateFiles, type Answers } from "../src/cli/init.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "weekpost-init-"));
const cap = () => {
  const lines: string[] = [];
  return { lines, text: () => lines.join("\n"), out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) } };
};
const ANSWERS: Answers = {
  brandName: "Shop & Co",
  accounts: [
    { handle: "shop_pt", lang: "pt-BR", timeZone: "America/Sao_Paulo", hemisphere: "south" },
    { handle: "shop_en", lang: "en", timeZone: "Europe/London", hemisphere: "north", voice: "george" },
  ],
  pillars: ["tip", "story"],
  cta: ["link in bio"],
};
const answersFile = (a: unknown) => {
  const f = join(tmp(), "answers.json");
  writeFileSync(f, JSON.stringify(a));
  return f;
};
// The files a project needs for loadConfig (the template names a font and a logo that the user adds).
// Stands for `npm i weekpost` in the project: the config imports "weekpost".
function install(dir: string) {
  if (existsSync(join(dir, "node_modules/weekpost"))) return;
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(join(import.meta.dirname, ".."), join(dir, "node_modules/weekpost"), "dir");
}
function addAssets(dir: string) {
  install(dir);
  mkdirSync(join(dir, "assets/fonts"), { recursive: true });
  for (const f of ["assets/fonts/inter-400.woff2", "assets/fonts/inter-800.woff2", "assets/logo.svg"]) writeFileSync(join(dir, f), "x");
}
const snapshot = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

describe("weekpost init", () => {
  it("copies the whole template and fills in the config from --answers", async () => {
    const dir = tmp();
    install(dir);
    const c = cap();
    expect(await runInit([dir, `--answers=${answersFile(ANSWERS)}`], c.out)).toBe(0);
    for (const f of templateFiles()) expect(existsSync(join(dir, f)), f).toBe(true);
    for (const f of ["weekpost.config.ts", ".github/workflows/weekpost-preview.yml", ".github/workflows/weekpost-metrics.yml", ".github/dependabot.yml", "worker/index.ts", "worker/wrangler.toml", "content/.gitkeep", "assets/README.md"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    addAssets(dir);
    const { config } = await loadConfig(dir);
    expect(config.brand.name).toBe("Shop & Co");
    expect(Object.keys(config.accounts)).toEqual(["pt-br", "en"]);
    expect(config.accounts["pt-br"]).toMatchObject({ handle: "shop_pt", hemisphere: "south", timeZone: "America/Sao_Paulo" });
    expect(config.accounts.en.cta).toEqual(["link in bio"]);
    expect(config.pillars).toEqual(["tip", "story"]);
    expect(config.ci.previewLabel).toBe("media-ok");
    // The check runs at the end; the template carries placeholder assets, so it passes (see initAgent.test.ts).
    expect(c.text()).toContain("Running weekpost check");
    expect(c.text()).toContain("44 MB");
  });

  it("says to install weekpost when the config cannot import it", async () => {
    const dir = tmp();
    const c = cap();
    expect(await runInit([dir, `--answers=${answersFile(ANSWERS)}`], c.out)).toBe(0);
    expect(c.text()).toContain("Cannot find module 'weekpost'");
    expect(c.text()).toContain("install weekpost in this directory");
  });

  it("rewrites the media-ok label of the preview workflow from previewLabel", async () => {
    const dir = tmp();
    expect(await runInit([dir, `--answers=${answersFile({ ...ANSWERS, previewLabel: "ok-to-render" })}`], cap().out)).toBe(0);
    const wf = readFileSync(join(dir, ".github/workflows/weekpost-preview.yml"), "utf8");
    expect(wf).not.toContain("media-ok");
    expect(wf).toContain("'ok-to-render'");
    addAssets(dir);
    expect((await loadConfig(dir)).config.ci.previewLabel).toBe("ok-to-render");
  });

  it("rejects a label that could break out of the workflow expression", async () => {
    const dir = tmp();
    const c = cap();
    expect(await runInit([dir, `--answers=${answersFile({ ...ANSWERS, previewLabel: "x') || true || ('" })}`], c.out)).toBe(1);
    expect(c.text()).toContain("previewLabel");
    expect(snapshot(dir)).toEqual([]);
  });

  it("does not echo the start of an --answers file that is not JSON", async () => {
    const dir = tmp();
    const c = cap();
    const f = join(tmp(), "not-answers.env");
    writeFileSync(f, "WEEKPOST_SUPABASE_KEY=sb_secret_SENTINEL-init-1a2b3c\n");
    expect(await runInit([dir, `--answers=${f}`], c.out)).toBe(1);
    expect(c.text()).not.toContain("WEEKPOST");
    expect(c.text()).not.toContain("SENTINEL");
    expect(snapshot(dir)).toEqual([]);
  });

  it("rejects a handle with a quote or a line break in the answers", async () => {
    const dir = tmp();
    const c = cap();
    const bad = { ...ANSWERS, accounts: [{ ...ANSWERS.accounts[0], handle: "h\n'evil" }] };
    expect(await runInit([dir, `--answers=${answersFile(bad)}`], c.out)).toBe(1);
    expect(c.text()).toContain("handle");
    expect(snapshot(dir)).toEqual([]);
  });

  it("with a conflict writes nothing and names the path", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github/dependabot.yml"), "mine");
    writeFileSync(join(dir, "weekpost.config.ts"), "mine");
    writeFileSync(join(dir, "worker"), "a file where a directory goes");
    const before = snapshot(dir);
    const c = cap();
    expect(await runInit([dir, `--answers=${answersFile(ANSWERS)}`], c.out)).toBe(1);
    expect(c.text()).toContain("nothing was written");
    for (const p of [".github/dependabot.yml", "weekpost.config.ts", "worker"]) expect(c.text()).toContain(`  ${p}`);
    expect(snapshot(dir)).toEqual(before);
    expect(readFileSync(join(dir, "weekpost.config.ts"), "utf8")).toBe("mine");
  });

  it("works in an existing directory that has other files", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), "{}");
    expect(await runInit([dir, `--answers=${answersFile(ANSWERS)}`], cap().out)).toBe(0);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe("{}");
  });

  it("without a terminal and without --answers refuses with code 2", async () => {
    const dir = tmp();
    const c = cap();
    expect(await runInit([dir], c.out, process.cwd(), { tty: false })).toBe(2);
    expect(c.text()).toContain("--answers");
    expect(snapshot(dir)).toEqual([]);
  });

  it("reports an invalid answer without writing anything", async () => {
    const dir = tmp();
    const c = cap();
    const bad = { ...ANSWERS, accounts: [{ ...ANSWERS.accounts[0], timeZone: "Mars/Base" }] };
    expect(await runInit([dir, `--answers=${answersFile(bad)}`], c.out)).toBe(1);
    expect(c.text()).toContain("Mars/Base");
    expect(snapshot(dir)).toEqual([]);
    expect(await runInit([dir, `--answers=${answersFile({ brandName: "x" })}`], cap().out)).toBe(1);
    expect(await runInit([dir, "--answers=/nonexistent.json"], cap().out)).toBe(1);
  });

  it("asks the questions in a terminal", async () => {
    const dir = tmp();
    const replies = ["Garden", "gardenapp", "pt-PT", "Europe/Lisbon", "north", "https://garden.example/pt/", "y", "gardenapp_en", "", "Europe/London", "", "http://nope", "https://garden.example/en/", "n", "dica, historia", "link na bio", "hi@garden.example"];
    const asked: string[] = [];
    const c = cap();
    const ask = async (q: string) => (asked.push(q), replies.shift() ?? "");
    expect(await runInit([dir], c.out, process.cwd(), { tty: true, ask })).toBe(0);
    expect(asked[0]).toContain("Brand name");
    addAssets(dir);
    const { config } = await loadConfig(dir);
    expect(config.brand.name).toBe("Garden");
    expect(Object.keys(config.accounts)).toEqual(["pt-pt", "en"]);
    expect(config.accounts.en.timeZone).toBe("Europe/London");
    expect(config.pillars).toEqual(["dica", "historia"]);
    expect(config.accounts["pt-pt"].cta).toEqual(["link na bio"]);
    expect(config.accounts["pt-pt"].link.base).toBe("https://garden.example/pt/");
    expect(config.accounts.en.link.base).toBe("https://garden.example/en/");
    expect(asked.some((q) => q.includes("must start with https://"))).toBe(true);
    const privacy = readFileSync(join(dir, "PRIVACY.md"), "utf8");
    expect(privacy).toContain("Garden");
    expect(privacy).toContain("hi@garden.example");
    expect(privacy).not.toMatch(/<BRAND>|<CONTACT>|<DATE>/);
  });

  it("keeps an https:// link base from --answers, rejects http, and leaves <CONTACT> to fill in when there is none", async () => {
    const dir = tmp();
    const c = cap();
    const a = { ...ANSWERS, accounts: [{ ...ANSWERS.accounts[0], linkBase: "https://x.example/" }] };
    expect(await runInit([dir, `--answers=${answersFile(a)}`], c.out)).toBe(0);
    addAssets(dir);
    expect((await loadConfig(dir)).config.accounts[Object.keys((await loadConfig(dir)).config.accounts)[0]!]!.link.base).toBe("https://x.example/");
    const privacy = readFileSync(join(dir, "PRIVACY.md"), "utf8");
    expect(privacy).toContain(ANSWERS.brandName);
    expect(privacy).toContain("<CONTACT>");
    expect(c.text()).toContain("fill in <CONTACT>");
    const bad = tmp();
    const b = { ...ANSWERS, accounts: [{ ...ANSWERS.accounts[0], linkBase: "http://x.example/" }] };
    expect(await runInit([bad, `--answers=${answersFile(b)}`], cap().out)).toBe(1);
    expect(snapshot(bad)).toEqual([]);
  });

  it("is reachable through the bin", () => {
    const dir = tmp();
    const bin = join(import.meta.dirname, "../bin/weekpost.js");
    const run = (args: string[]) => execFileSync("node", [bin, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run(["init", dir, `--answers=${answersFile(ANSWERS)}`])).toContain("wrote ");
    expect(existsSync(join(dir, "weekpost.config.ts"))).toBe(true);
  }, 60_000);
});
