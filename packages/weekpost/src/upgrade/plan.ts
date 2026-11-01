// `weekpost upgrade --plan`: everything that has to be true before an upgrade writes anything, and what it would
// write. Pure reads: the project is never modified, and the only network calls are GETs on the Supabase REST API.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContext, type SetupDeps } from "../cli/setup.ts";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import { checkContent } from "../content/load.ts";
import type { Issue } from "../content/post.ts";
import { MIGRATIONS_DIR, pendingAfter, readMigrations } from "../setup/migrate.ts";
import { planSteps, schemaVersion, type StepReport } from "../setup/probes.ts";
import { spawnRunner, type Runner } from "../setup/runner.ts";
import { answersSchema, LOCK_FILE, packageVersion, renderTemplate, sha256, TEMPLATE_DIR, type Answers, type Lock } from "../setup/template.ts";
import { unifiedDiff } from "./diff.ts";

/** Files that belong to you: an upgrade never writes them. Everything else `init` generated is weekpost's to update. */
const USER_FILES = new Set(["weekpost.config.ts", "BRIEF.md", "PRIVACY.md", ".gitignore"]);
const USER_DIRS = ["content/", "assets/"];
export const isUserOwned = (path: string) => USER_FILES.has(path) || USER_DIRS.some((d) => path.startsWith(d));

export type FileState = "update" | "edited" | "new" | "removed" | "record";
export type FileEntry = { path: string; state: FileState; note?: string; /** Unified diff of the file on disk against the new one (`edited` only). */ diff?: string };
export type Blocker = { item: 1 | 2 | 3 | 4; message: string; week?: string };
export type MigrationReport = { state: "ok" | "pending" | "unknown"; detail: string; current: number | null; latest: number; pending: string[] };

export type UpgradePlan = {
  blocked: boolean;
  installed: string;
  /** The version in `weekpost.lock.json`, or null when the project has no (readable) lock. */
  lockVersion: string | null;
  blockers: Blocker[];
  warnings: string[];
  /** Weeks read from content/, and the issues the check found (errors block; warnings are past weeks and config notes). */
  content: { weeks: number; errors: Issue[]; warnings: Issue[] } | null;
  migrations: MigrationReport | null;
  files: FileEntry[] | null;
  /** Files whose new version equals what is on disk, or that you edited and the new version leaves alone. */
  unchanged: number;
  /** Files that would change: every entry of `files` except `record` ones (identical to the template, only added to the lock). */
  toChange: number;
  /** Setup steps that are `todo` with this version. */
  steps: StepReport[] | null;
};

export type PlanDeps = {
  /** Version of the installed weekpost. */
  installed?: string;
  now?: Date;
  run?: Runner;
  setup?: SetupDeps;
  /** Template and migrations to compare against (tests). */
  templateRoot?: string;
  migrationsDir?: string;
};

const numbers = (v: string) => v.split(/[-+]/)[0]!.split(".").map((x) => Number(x) || 0);
/** Negative when `a` is older than `b`. Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const PAST_WEEK_NOTE = " (this week has already gone out, but its posts.yaml must still pass the new schema: add the missing field or delete the week)";
/** True when the last day (Sunday, UTC) of an ISO week `YYYY-Www` is before `now`. */
function weekEnded(week: string, now: Date): boolean {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return false;
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86400000 + (Number(m[2]) - 1) * 7 * 86400000;
  return monday + 7 * 86400000 <= now.getTime();
}

type LockRead = { lock: Lock } | { error: string } | null;
function readLock(projectRoot: string): LockRead {
  const file = join(projectRoot, LOCK_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Lock>;
    const answers = answersSchema.safeParse(raw.answers);
    const files = raw.files;
    if (raw.lockVersion !== 1 || typeof raw.weekpost !== "string" || !answers.success || !files || typeof files !== "object" || Object.values(files).some((h) => typeof h !== "string")) {
      return { error: `${LOCK_FILE} is not a lock this weekpost understands (lockVersion 1 with weekpost, answers and files)` };
    }
    return { lock: { lockVersion: 1, weekpost: raw.weekpost, renderedOn: String(raw.renderedOn ?? ""), answers: answers.data, files: files as Record<string, string> } };
  } catch {
    return { error: `${LOCK_FILE} is not valid JSON` };
  }
}

/** What `init` would have asked, read back from the config (for a project without a lock). */
export function answersFromConfig(config: WeekpostConfig): Answers {
  const accounts = Object.entries(config.accounts);
  return {
    brandName: config.brand.name,
    accounts: accounts.map(([id, a]) => ({ id, handle: a.handle, lang: a.lang, timeZone: a.timeZone, hemisphere: a.hemisphere, voice: a.voice, linkBase: a.link.base })),
    pillars: config.pillars,
    cta: accounts[0]?.[1].cta ?? [],
    previewLabel: config.ci.previewLabel,
  };
}

const readDisk = (projectRoot: string, path: string): Buffer | null => {
  const file = join(projectRoot, path);
  try {
    return lstatSync(file).isFile() ? readFileSync(file) : null;
  } catch {
    return null;
  }
};

const isText = (b: Buffer) => !b.includes(0);

function planFiles(projectRoot: string, lock: Lock | null, answers: Answers, templateRoot: string, today: Date): { files: FileEntry[]; unchanged: number } {
  const next = new Map(renderTemplate(answers, { root: templateRoot, today }).filter((f) => !isUserOwned(f.path)).map((f) => [f.path, f.content]));
  const locked = Object.fromEntries(Object.entries(lock?.files ?? {}).filter(([p]) => !isUserOwned(p)));
  const files: FileEntry[] = [];
  let unchanged = 0;
  const edited = (path: string, disk: Buffer, content: Buffer, note?: string) => {
    const diff = isText(disk) && isText(content) ? unifiedDiff(path, disk.toString("utf8"), content.toString("utf8")) : `Binary files a/${path} and b/${path} differ`;
    files.push({ path, state: "edited", ...(note ? { note } : {}), diff });
  };
  for (const path of [...new Set([...next.keys(), ...Object.keys(locked)])].sort()) {
    const content = next.get(path);
    const disk = readDisk(projectRoot, path);
    if (!content) {
      if (disk) files.push({ path, state: "removed", note: "no longer part of the template" });
      continue;
    }
    const newHash = sha256(content);
    const diskHash = disk ? sha256(disk) : null;
    if (diskHash === newHash && lock) {
      unchanged++;
    } else if (!disk) {
      files.push({ path, state: "new", ...(path in locked ? { note: "in the lock but missing on disk" } : {}) });
    } else if (!lock) {
      // No lock: compare with the new template. The same bytes are recorded in the lock; different ones are yours.
      if (diskHash === newHash) files.push({ path, state: "record", note: "identical; only added to the lock" });
      else edited(path, disk, content, "no lock to tell your edits from the old template");
    } else if (!(path in locked)) {
      edited(path, disk, content, "not in the lock, and different from the new file");
    } else if (diskHash === locked[path]) {
      files.push({ path, state: "update" });
    } else if (locked[path] === newHash) {
      unchanged++; // you edited it and the new version does not change it
    } else {
      edited(path, disk, content);
    }
  }
  return { files, unchanged };
}

async function gitDirty(run: Runner, projectRoot: string, paths: string[]): Promise<{ error?: string; dirty: string[] }> {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectRoot });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return { error: "this project is not in a git repository, so the changes could not be reviewed or undone", dirty: [] };
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all", "--", ...paths], { cwd: projectRoot });
  if (status.status !== 0) return { error: "git status failed", dirty: [] };
  return { dirty: status.stdout.split("\n").filter(Boolean).map((l) => l.slice(3).trim()) };
}

export async function planUpgrade(projectRoot: string, deps: PlanDeps = {}): Promise<UpgradePlan> {
  const installed = deps.installed ?? packageVersion();
  const now = deps.now ?? new Date();
  const run = deps.run ?? spawnRunner;
  const templateRoot = deps.templateRoot ?? TEMPLATE_DIR;
  const blockers: Blocker[] = [];
  const warnings: string[] = [];
  const plan: UpgradePlan = { blocked: false, installed, lockVersion: null, blockers, warnings, content: null, migrations: null, files: null, unchanged: 0, toChange: 0, steps: null };

  // 1. The lock against the installed version.
  const read = readLock(projectRoot);
  const lock = read && "lock" in read ? read.lock : null;
  if (read && "error" in read) blockers.push({ item: 1, message: read.error });
  if (lock) {
    plan.lockVersion = lock.weekpost;
    if (compareVersions(lock.weekpost, installed) > 0) {
      blockers.push({ item: 1, message: `the lock says weekpost ${lock.weekpost} but ${installed} is installed: that would be a downgrade. Install ${lock.weekpost} or newer` });
    }
  } else if (!read) {
    warnings.push(`no ${LOCK_FILE}: this project was created before the lock existed, so your files are compared with the new template and any difference counts as your edit. Without a lock, files dropped from the template aren't detected`);
  }

  // 3 (first, the rest needs it). The config in the new schema.
  let config: WeekpostConfig | null = null;
  try {
    const loaded = await loadConfig(projectRoot);
    config = loaded.config;
    for (const w of loaded.warnings) warnings.push(`config ${w}`);
  } catch (e) {
    const message = e instanceof ConfigError ? e.message : (e as Error).message;
    blockers.push({ item: 3, message: `weekpost.config.ts does not load with weekpost ${installed}: ${message}\nChange it as the "You need to do" part of the CHANGELOG says; upgrade does not edit your config` });
  }

  // The answers the new template is rendered with: the lock's, or the config's when there is no lock.
  const answers: Answers | null = lock ? { ...lock.answers, ...(config ? { previewLabel: config.ci.previewLabel } : {}) } : config ? answersFromConfig(config) : null;
  const today = lock?.renderedOn && !Number.isNaN(Date.parse(lock.renderedOn)) ? new Date(lock.renderedOn) : now;

  // The file plan comes before the git check, which only looks at files the plan touches.
  if (answers) {
    const { files, unchanged } = planFiles(projectRoot, lock, answers, templateRoot, today);
    plan.files = files;
    plan.unchanged = unchanged;
    plan.toChange = files.filter((f) => f.state !== "record").length;
  }

  // 2. Git clean on the generated files.
  const generated = [...new Set([LOCK_FILE, ...Object.keys(lock?.files ?? {}), ...(plan.files ?? []).map((f) => f.path)])].filter((p) => !isUserOwned(p));
  const git = await gitDirty(run, projectRoot, generated);
  if (git.error) blockers.push({ item: 2, message: git.error });
  else if (git.dirty.length) blockers.push({ item: 2, message: `uncommitted changes in files weekpost generated; commit or stash them first:\n${git.dirty.map((f) => `  ${f}`).join("\n")}` });

  // 4. The check on every week.
  if (config) {
    const { weeks, issues } = checkContent(join(projectRoot, "content"), config, undefined, undefined, { now });
    plan.content = { weeks: weeks.length, errors: issues.filter((i) => i.level === "error"), warnings: issues.filter((i) => i.level === "warn") };
    for (const i of plan.content.errors) {
      const gone = i.week && weekEnded(i.week, now) ? PAST_WEEK_NOTE : "";
      blockers.push({ item: 4, message: `${i.where}: ${i.message}${gone}`, ...(i.week ? { week: i.week } : {}) });
    }
  }

  // 5 and 7 need the setup context (credentials, runner); 5 reads the REST API only.
  if (config) {
    const ctx = await buildContext(projectRoot, { config, run, ...deps.setup });
    const all = readMigrations(deps.migrationsDir ?? MIGRATIONS_DIR);
    const latest = Math.max(0, ...all.map((m) => m.version));
    const current = await schemaVersion(ctx).catch(() => null);
    if (!ctx.supabase.url || !ctx.supabase.key) {
      plan.migrations = { state: "unknown", detail: "no Supabase URL and key, so the database was not asked (set WEEKPOST_SUPABASE_URL and WEEKPOST_SUPABASE_KEY)", current: null, latest, pending: [] };
    } else if (current === null) {
      plan.migrations = { state: "unknown", detail: "Supabase did not answer as expected; check the URL and the secret key", current: null, latest, pending: [] };
    } else {
      const pending = pendingAfter(all, current).map((m) => m.file);
      plan.migrations = { state: pending.length ? "pending" : "ok", detail: pending.length ? `schema ${current} of ${latest}: ${pending.length} migration(s) pending` : `schema ${current} of ${latest}`, current, latest, pending };
    }
    plan.steps = (await planSteps({ ...ctx, latestSchema: latest })).filter((s) => s.state === "todo");
  }

  plan.blocked = blockers.length > 0;
  return plan;
}
