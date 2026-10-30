// The files weekpost generates into a project, as a pure function of the answers. `init` writes them and records
// their hashes in weekpost.lock.json; `upgrade` renders them again to see what changed.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { handle as handleSchema } from "../config/schema.ts";

export const TEMPLATE_DIR = join(import.meta.dirname, "../../template");
export const DEFAULT_LABEL = "media-ok";
export const DEFAULT_LINK_BASE = "https://myapp.example/";

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


// npm drops `.gitignore` from a tarball, so the template ships it as `gitignore` and init writes `.gitignore`.
const SHIPPED_GITIGNORE = "gitignore";

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


export function accountsConfig(a: Answers) {
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


export const LOCK_FILE = "weekpost.lock.json";
export type Lock = { lockVersion: 1; weekpost: string; files: Record<string, string> };
export type RenderedFile = { path: string; content: Buffer };

/** The installed weekpost version, from the package.json that ships next to `template/`. */
export function packageVersion(root: string = join(TEMPLATE_DIR, "..")): string {
  return String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
}

/**
 * Every file of the template as it is written in a project, with the answers filled in. Pure: reads only the
 * template, writes nothing, and the same answers give the same bytes. `today` stands in for the date written
 * into PRIVACY.md.
 */
export function renderTemplate(answers: Answers, opts: { root?: string; today?: Date } = {}): RenderedFile[] {
  const root = opts.root ?? TEMPLATE_DIR;
  const label = answers.previewLabel ?? DEFAULT_LABEL;
  return templateFiles(root).map((path) => {
    const raw = readFileSync(join(root, path === ".gitignore" ? SHIPPED_GITIGNORE : path));
    const text = (render: (t: string) => string) => Buffer.from(render(raw.toString("utf8")), "utf8");
    if (path === "weekpost.config.ts") return { path, content: text((t) => renderConfig(t, answers)) };
    if (path === "PRIVACY.md") return { path, content: text((t) => renderPrivacy(t, answers, opts.today)) };
    if (path.startsWith(".github/workflows/")) return { path, content: text((t) => renderWorkflow(t, label)) };
    return { path, content: raw };
  });
}

export const sha256 = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");

/** The lock for files as they were written: the version and the sha256 of each. */
export function buildLock(files: RenderedFile[], version: string = packageVersion()): Lock {
  const entries = files.map((f) => [f.path, sha256(f.content)] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  return { lockVersion: 1, weekpost: version, files: Object.fromEntries(entries) };
}

export const serializeLock = (lock: Lock) => `${JSON.stringify(lock, null, 2)}\n`;
