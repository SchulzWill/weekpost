// weekpost init [dir] [--answers=<file.json>]
// Copies the template into a project directory and fills in the config from a few answers (typed in a terminal,
// or read from --answers). Writes no secret and runs nothing outside the directory. If any file would be
// overwritten it stops before writing anything and names the paths. It ends by running `weekpost check`.
import { constants, copyFileSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { configSchema, handle as handleSchema } from "../config/schema.ts";
import { runCheck, type Out } from "./check.ts";

export const TEMPLATE_DIR = join(import.meta.dirname, "../../template");
const DEFAULT_LABEL = "media-ok";
const DEFAULT_LINK_BASE = "https://myapp.example/";
const USAGE = "usage: weekpost init [dir] [--answers=<file.json>]";

// What init needs to know. No secrets: a file of this shape is safe for an agent to write.
const accountAnswer = z.strictObject({
  id: z.string().optional(),
  handle: handleSchema,
  lang: z.string(),
  timeZone: z.string(),
  hemisphere: z.enum(["north", "south"], { error: 'use "north" or "south"' }),
  voice: z.string().optional(),
  linkBase: z.string().optional(),
});
export const answersSchema = z.strictObject({
  brandName: z.string(),
  accounts: z.array(accountAnswer).min(1, "give at least one account"),
  pillars: z.array(z.string()).min(1, "give at least one pillar"),
  cta: z.array(z.string()).min(1, "give at least one CTA word or phrase"),
  previewLabel: z.string().optional(),
  /** E-mail or URL written into PRIVACY.md. Without it the `<CONTACT>` placeholder stays for you to fill in. */
  contact: z.string().optional(),
});
export type Answers = z.infer<typeof answersSchema>;

export type InitDeps = {
  tty?: boolean;
  /** Asks one question and returns the typed line (empty = take the default). */
  ask?: (question: string) => Promise<string>;
  /** Makes the `.claude/skills` link (tests make it fail to exercise the copy). */
  symlink?: (target: string, path: string) => void;
};

// npm drops `.gitignore` from a tarball, so the template ships it as `gitignore` and init writes `.gitignore`.
const SHIPPED_GITIGNORE = "gitignore";
/** `.claude/skills` points at `skills/`, so Claude Code finds the skills. npm drops symlinks too, so init creates it. */
const SKILLS_LINK = ".claude/skills";
const SKILLS_TARGET = "../skills";

/** Every file of the template as it is written in the project (relative path), in a stable order. */
export function templateFiles(root: string = TEMPLATE_DIR): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split("\\").join("/"))
    .map((f) => (f === SHIPPED_GITIGNORE ? ".gitignore" : f))
    .sort();
}

const slug = (lang: string) => lang.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16) || "main";

function withIds(accounts: Answers["accounts"]) {
  const used = new Set<string>();
  return accounts.map((a) => {
    const base = a.id ?? slug(a.lang);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 13)}-${n}`;
    used.add(id);
    return { ...a, id };
  });
}

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

function accountsConfig(a: Answers) {
  return Object.fromEntries(
    withIds(a.accounts).map((x) => [x.id, { handle: x.handle, lang: x.lang, timeZone: x.timeZone, hemisphere: x.hemisphere, voice: x.voice ?? "george", cta: a.cta, link: { base: x.linkBase ?? DEFAULT_LINK_BASE } }]),
  );
}

const indent = (text: string, pad: string) => text.split("\n").map((l, i) => (i ? pad + l : l)).join("\n");

function replaceOnce(source: string, pattern: RegExp, replacement: string, what: string): string {
  if (!pattern.test(source)) throw new Error(`the template config has no ${what} to fill in (this is a bug in weekpost)`);
  return source.replace(pattern, () => replacement);
}

/** The template config with the answers filled in. */
export function renderConfig(template: string, a: Answers): string {
  let out = replaceOnce(template, /name: "My App"/, `name: ${JSON.stringify(a.brandName)}`, "brand name");
  out = replaceOnce(out, /  accounts: \{[\s\S]*?\n  \},\n/, `  accounts: ${indent(JSON.stringify(accountsConfig(a), null, 2), "  ")},\n`, "accounts");
  const ci = a.previewLabel && a.previewLabel !== DEFAULT_LABEL ? `  ci: { previewLabel: ${JSON.stringify(a.previewLabel)} },\n` : "";
  out = replaceOnce(out, /  pillars: \[[^\]]*\],\n/, `  pillars: ${JSON.stringify(a.pillars)},\n${ci}`, "pillars");
  return out;
}

/** PRIVACY.md with the brand, the date and (when known) the contact in place of the placeholders. */
export function renderPrivacy(text: string, a: Pick<Answers, "brandName" | "contact">, today: Date = new Date()): string {
  let out = text.split("<BRAND>").join(a.brandName).split("<DATE>").join(today.toISOString().slice(0, 10));
  if (a.contact?.trim()) out = out.split("<CONTACT>").join(a.contact.trim());
  return out;
}

/** The workflow with the preview label of the config in place of the shipped `media-ok`. */
export const renderWorkflow = (text: string, label: string) => (label === DEFAULT_LABEL ? text : text.split(DEFAULT_LABEL).join(label));

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

  const files = templateFiles();
  const conflicts = findConflicts(dir, [...files, SKILLS_LINK]);
  if (conflicts.length) {
    out.error(`nothing was written: these paths already exist in ${dir}:\n${conflicts.map((c) => `  ${c}`).join("\n")}\nMove them away, or run init in an empty directory.`);
    return 1;
  }

  const label = answers.previewLabel ?? DEFAULT_LABEL;
  for (const f of files) {
    const from = join(TEMPLATE_DIR, f === ".gitignore" ? SHIPPED_GITIGNORE : f);
    const to = join(dir, f);
    mkdirSync(dirname(to), { recursive: true });
    if (f === "weekpost.config.ts") writeFileSync(to, renderConfig(readFileSync(from, "utf8"), answers), { flag: "wx" });
    else if (f === "PRIVACY.md") writeFileSync(to, renderPrivacy(readFileSync(from, "utf8"), answers), { flag: "wx" });
    else if (f.startsWith(".github/workflows/")) writeFileSync(to, renderWorkflow(readFileSync(from, "utf8"), label), { flag: "wx" });
    else copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
  const linked = linkSkills(dir, deps.symlink ?? ((t, p) => symlinkSync(t, p, "dir")));
  out.log(`wrote ${files.length} files to ${dir}${linked === "copy" ? " (.claude/skills is a copy of skills/: symbolic links are not available here, so keep the two in step)" : ""}`);

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
