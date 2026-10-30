// weekpost init [dir] [--answers=<file.json>]
// Copies the template into a project directory and fills in the config from a few answers (typed in a terminal,
// or read from --answers). Writes no secret and runs nothing outside the directory. If any file would be
// overwritten it stops before writing anything and names the paths. It ends by running `weekpost check`.
import { cpSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { z } from "zod";
import { configSchema } from "../config/schema.ts";
import { accountsConfig, answersSchema, buildLock, DEFAULT_LINK_BASE, LOCK_FILE, renderTemplate, serializeLock, type Answers } from "../setup/template.ts";
import { runCheck, type Out } from "./check.ts";

// The render pieces live in setup/template.ts; these re-exports keep the old import path working.
export { answersSchema, renderConfig, renderPrivacy, renderWorkflow, templateFiles, TEMPLATE_DIR, type Answers } from "../setup/template.ts";

const USAGE = "usage: weekpost init [dir] [--answers=<file.json>]";

export type InitDeps = {
  tty?: boolean;
  /** Asks one question and returns the typed line (empty = take the default). */
  ask?: (question: string) => Promise<string>;
  /** Makes the `.claude/skills` link (tests make it fail to exercise the copy). */
  symlink?: (target: string, path: string) => void;
};

/** `.claude/skills` points at `skills/`, so Claude Code finds the skills. npm drops symlinks too, so init creates it. */
const SKILLS_LINK = ".claude/skills";
const SKILLS_TARGET = "../skills";

/** Problems with the answers, one line each (empty = fine). Uses the same rules as the config. */
export function validateAnswers(a: Answers): string[] {
  const issues: string[] = [];
  const add = (prefix: string, r: { success: boolean; error?: z.ZodError }) => {
    for (const i of r.error?.issues ?? []) issues.push(`${prefix}${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`);
  };
  add("brandName", configSchema.shape.brand.shape.name.safeParse(a.brandName));
  add("pillars", configSchema.shape.pillars.safeParse(a.pillars));
  add("accounts", configSchema.shape.accounts.safeParse(accountsConfig(a)));
  if (a.previewLabel !== undefined) {
    add("previewLabel", configSchema.shape.ci.unwrap().shape.previewLabel.safeParse(a.previewLabel));
    // The label is written inside a quoted expression of the preview workflow.
    if (!/^[\w .:/-]+$/.test(a.previewLabel)) issues.push("previewLabel: use letters, digits, spaces and . : / _ - only");
  }
  return issues;
}

/** Paths that would be overwritten: an existing target, or a file standing where a directory must go. */
export function findConflicts(dir: string, files: string[]): string[] {
  const conflicts = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      const st = lstatOrNull(join(dir, p));
      if (st && !st.isDirectory()) conflicts.add(p);
    }
    if (lstatOrNull(join(dir, f))) conflicts.add(f);
  }
  return [...conflicts].sort();
}
const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** `.claude/skills` -> `../skills`; a copy of `skills/` if the link cannot be made. */
function linkSkills(dir: string, symlink: NonNullable<InitDeps["symlink"]>): "link" | "copy" {
  const at = join(dir, SKILLS_LINK);
  mkdirSync(dirname(at), { recursive: true });
  try {
    symlink(SKILLS_TARGET, at);
    return "link";
  } catch {
    cpSync(join(dir, "skills"), at, { recursive: true, errorOnExist: true, force: false });
    return "copy";
  }
}

async function askAnswers(ask: (q: string) => Promise<string>): Promise<Answers> {
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const withDefault = async (q: string, d: string) => (await ask(`${q} [${d}]: `)).trim() || d;
  const brandName = await withDefault("Brand name", "My App");
  const accounts: Answers["accounts"] = [];
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  do {
    const n = accounts.length + 1;
    const handle = (await ask(`Account ${n}: Instagram handle (without @): `)).trim();
    const lang = await withDefault(`Account ${n}: language (BCP-47, e.g. en, pt-BR)`, "en");
    const timeZone = await withDefault(`Account ${n}: time zone (IANA)`, zone);
    const hemisphere = (await withDefault(`Account ${n}: hemisphere (north/south)`, "north")) as "north" | "south";
    // `link in bio` leads here; https is required. Ask again a few times, then let the validation name the problem.
    let linkBase = await withDefault(`Account ${n}: link base URL (https://, where "link in bio" leads)`, DEFAULT_LINK_BASE);
    for (let tries = 0; !linkBase.startsWith("https://") && tries < 3; tries++) {
      linkBase = await withDefault(`Account ${n}: the link base must start with https://. Link base URL`, DEFAULT_LINK_BASE);
    }
    accounts.push({ handle, lang, timeZone, hemisphere, linkBase });
  } while (/^y/i.test((await ask("Add another account? [y/N]: ")).trim()));
  const pillars = list(await withDefault("Content pillars (comma-separated)", "tip, story"));
  const cta = list(await withDefault("Call to action words or phrases (comma-separated)", "link in bio"));
  const contact = (await ask("Contact for the privacy policy (e-mail or URL, empty = fill in later): ")).trim();
  return { brandName, accounts, pillars, cta, ...(contact ? { contact } : {}) };
}

async function terminalAsk() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return { ask: (q: string) => rl.question(q), close: () => rl.close() };
}

// Returns the exit code.
export async function runInit(args: string[], out: Out = console, cwd = process.cwd(), deps: InitDeps = {}): Promise<number> {
  const answersFile = args.find((a) => a.startsWith("--answers="))?.slice("--answers=".length);
  const positional = args.filter((a) => !a.startsWith("--"));
  const unknown = args.filter((a) => a.startsWith("--") && !a.startsWith("--answers="));
  if (positional.length > 1 || unknown.length || answersFile === "") {
    out.error(USAGE);
    return 2;
  }
  const dir = resolve(cwd, positional[0] ?? ".");

  let answers: Answers;
  if (answersFile) {
    try {
      const parsed = answersSchema.safeParse(JSON.parse(readFileSync(resolve(cwd, answersFile), "utf8")));
      if (!parsed.success) {
        out.error(`${answersFile} is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".") || "(answers)"}: ${i.message}`).join("\n")}`);
        return 1;
      }
      answers = parsed.data;
    } catch (e) {
      // Never repeat the parser's message: it quotes the start of the file, and the file may not be an answers file at all.
      out.error(e instanceof SyntaxError ? `${answersFile} is not valid JSON` : `cannot read ${answersFile}`);
      return 1;
    }
  } else {
    const tty = deps.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!tty && !deps.ask) {
      out.error("init asks questions and needs a terminal. Without one, pass --answers=<file.json> (see the README for its fields).");
      return 2;
    }
    const term = deps.ask ? undefined : await terminalAsk();
    try {
      answers = await askAnswers(deps.ask ?? term!.ask);
    } finally {
      term?.close();
    }
  }

  const problems = validateAnswers(answers);
  if (problems.length) {
    out.error(`the answers are not valid:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    return 1;
  }

  const rendered = renderTemplate(answers);
  const files = rendered.map((f) => f.path);
  const conflicts = findConflicts(dir, [...files, LOCK_FILE, SKILLS_LINK]);
  if (conflicts.length) {
    out.error(`nothing was written: these paths already exist in ${dir}:\n${conflicts.map((c) => `  ${c}`).join("\n")}\nMove them away, or run init in an empty directory.`);
    return 1;
  }

  for (const f of rendered) {
    const to = join(dir, f.path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, f.content, { flag: "wx" });
  }
  // The hashes are of the bytes just written: `upgrade` tells a file you edited from one it can safely replace.
  writeFileSync(join(dir, LOCK_FILE), serializeLock(buildLock(rendered)), { flag: "wx" });
  const linked = linkSkills(dir, deps.symlink ?? ((t, p) => symlinkSync(t, p, "dir")));
  out.log(`wrote ${files.length} files and ${LOCK_FILE} to ${dir}${linked === "copy" ? " (.claude/skills is a copy of skills/: symbolic links are not available here, so keep the two in step)" : ""}`);

  out.log("\nRunning weekpost check:");
  const checked = await runCheck([`--project=${dir}`], out, cwd);
  out.log(
    [
      "",
      checked === 0 ? "The config is valid." : "The check above lists what is left to fix. A new project is missing the font and logo files the config names under assets/. If it says it cannot find module 'weekpost', install weekpost in this directory first.",
      `PRIVACY.md is a generic policy${answers.contact?.trim() ? "" : " (fill in <CONTACT>)"}: read it, publish it on a public page and give Meta that URL (README, step 4).`,
      "Next: edit weekpost.config.ts (brand colors, font, logo, and link.base if you kept the placeholder), then install weekpost in this directory (npm i <the release tarball>) and run `npx playwright install chromium`.",
      "Heads up: installing weekpost downloads ffmpeg-static, about 44 MB.",
    ].join("\n"),
  );
  return 0;
}
