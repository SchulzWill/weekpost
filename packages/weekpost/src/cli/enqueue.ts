// weekpost enqueue <artifact-dir> --weeks=<file> [--root=content] [--project=<dir>] [--dry-run] [--allow-past] [--commit=<sha>] [--summary=<file.json>]
// Puts the approved media of the listed weeks into the queue. <artifact-dir> holds <week>/manifest.json and the
// media of each week (the output of `generate`). It never regenerates media: it checks the sha-256 of every file
// against the manifest, plans everything, and only then uploads and writes. Env (not needed with --dry-run):
// WEEKPOST_SUPABASE_URL, WEEKPOST_SUPABASE_KEY, and WEEKPOST_BUCKET (default "weekpost-media").
// A post whose publish time has passed is skipped with a warning (it would go out at once); --allow-past queues it anyway.
// --commit is the commit whose YAML is being enqueued (default: GITHUB_SHA, else the checked-out commit). Every row
// written is stamped with it, and a row stamped by a commit that is not this one or an ancestor of it is left alone.
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import { checkContent, WEEK_DIR } from "../content/load.ts";
import { manifestSchema, type Manifest } from "../render/manifest.ts";
import { PlanError, planUpserts, type PlanContext, planWeek, uploadsFor, type PlannedRow, type Upload } from "../queue/plan.ts";
import { supabaseDb } from "../queue/supabase.ts";
import { MAX_FILE_BYTES, supabaseStorage } from "../queue/storage.ts";
import type { OperatorDb, SourceStamp, Storage } from "../queue/types.ts";
import { commitTime as gitCommitTime, FULL_SHA, gitIsAncestor, headCommit as gitHeadCommit } from "../queue/git.ts";
import { projectPaths, type Out } from "./check.ts";
import { hasTty, withLocalEnv } from "./secrets.ts";

const USAGE = "usage: weekpost enqueue <artifact-dir> --weeks=<file> [--root=content] [--project=<dir>] [--dry-run] [--allow-past] [--commit=<sha>] [--summary=<file.json>]";

export type EnqueueDeps = {
  db?: OperatorDb;
  storage?: Storage & { ensureBucket?: () => Promise<void> };
  env?: Record<string, string | undefined>;
  /** Home directory the local secrets file is read from. Default: the real one; tests pass a temporary one. */
  home?: string;
  /** Whether there is a terminal. Default: the real one. Without one, enqueue reads only the environment. */
  tty?: boolean;
  /** The clock; tests inject it. */
  now?: () => Date;
  /** Git questions; tests inject them. Defaults ask git in the project checkout. */
  headCommit?: () => string | undefined;
  isAncestor?: (ancestor: string, descendant: string) => boolean;
  commitTime?: (sha: string) => string | null;
};

export type Summary = {
  scheduled: number; updated: number;
  skipped: { key: string; reason: string; kind?: "newer" | "operator" | "past" }[];
  /** Queued rows that left the approved YAML and were canceled. */
  canceled: { key: string; reason: string }[];
  /** Rows the enqueue had canceled earlier and brought back because the approved YAML has them again. */
  revived?: string[];
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reads a regular file inside the artifact: symlinks and files over the size limit are refused. */
function readArtifactFile(file: string, what: string): Buffer {
  const st = lstatSync(file);
  if (st.isSymbolicLink()) throw new Error(`${what} is a symbolic link; the artifact must contain regular files`);
  if (!st.isFile()) throw new Error(`${what} is not a regular file`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${what} is ${Math.round(st.size / 1024 / 1024)} MiB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
  return readFileSync(file);
}

function loadManifest(weekDir: string, week: string): Manifest {
  let raw: string;
  try {
    raw = readArtifactFile(join(weekDir, "manifest.json"), `${week}/manifest.json`).toString("utf8");
  } catch (e) {
    throw new Error(`the artifact has no usable manifest for ${week}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${week}/manifest.json is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${week}/manifest.json is not a valid v1 manifest:\n- ${parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("\n- ")}`);
  }
  return parsed.data;
}

function hashFiles(weekDir: string, manifest: Manifest): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const post of manifest.posts) {
    for (const media of Object.values(post.accounts)) {
      for (const f of Object.keys(media.sha256)) {
        if (f in hashes) continue;
        const path = resolve(weekDir, f);
        if (!path.startsWith(`${resolve(weekDir)}/`)) throw new Error(`${f} points outside the artifact`);
        try {
          hashes[f] = sha256(readArtifactFile(path, f));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // reported by the plan as "file is missing"
          throw e;
        }
      }
    }
  }
  return hashes;
}

// Returns the exit code.
export async function runEnqueue(args: string[], out: Out = console, cwd = process.cwd(), deps: EnqueueDeps = {}): Promise<number> {
  const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const artifactDir = args.find((a) => !a.startsWith("--"));
  const weeksFile = opt("weeks");
  const dryRun = args.includes("--dry-run");
  const allowPast = args.includes("--allow-past");
  const now = (deps.now ?? (() => new Date()))().getTime();
  const isPast = (r: PlannedRow) => r.status !== "manual" && new Date(r.publishAt).getTime() < now;
  const summaryFile = opt("summary");
  if (!artifactDir || !weeksFile) {
    out.error(USAGE);
    return 2;
  }
  const commitArg = opt("commit");
  if (commitArg !== undefined && !FULL_SHA.test(commitArg)) {
    out.error(`error: --commit must be a full 40-character commit sha, got "${commitArg}"`);
    return 2;
  }
  const artifact = resolve(cwd, artifactDir);
  try {
    const st = lstatSync(artifact);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a plain directory (symbolic links are refused)");
  } catch (e) {
    out.error(`error: artifact directory ${artifactDir}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : (e as Error).message}`);
    return 1;
  }
  let weeks: string[];
  try {
    weeks = readFileSync(resolve(cwd, weeksFile), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    out.error(`error: cannot read ${weeksFile}: ${(e as Error).message}`);
    return 1;
  }
  const bad = weeks.filter((w) => !WEEK_DIR.test(w));
  if (bad.length) {
    out.error(`error: ${weeksFile}: not a week (YYYY-Www): ${bad.join(", ")}`);
    return 1;
  }
  const write = (s: Summary) => summaryFile && writeFileSync(resolve(cwd, summaryFile), `${JSON.stringify(s, null, 2)}\n`);
  if (!weeks.length) {
    out.log("0 scheduled, 0 skipped (no weeks to enqueue)");
    write({ scheduled: 0, updated: 0, skipped: [], canceled: [] });
    return 0;
  }

  const { projectRoot, contentRoot } = projectPaths(args, cwd);
  let config;
  try {
    ({ config } = await loadConfig(projectRoot));
  } catch (e) {
    out.error(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }

  // 1. Plan every week before writing anything.
  const plans: { week: string; rows: PlannedRow[]; uploads: Upload[]; skippedAccounts: string[]; weekDir: string; hashes: Record<string, string>; ctx: PlanContext }[] = [];
  for (const week of weeks) {
    const { weeks: loaded, issues } = checkContent(contentRoot, config, week);
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length || !loaded.length) {
      for (const i of errors) out.error(`error ${i.where}: ${i.message}`);
      out.error(loaded.length ? `fix the content of ${week} before enqueueing (weekpost check)` : `week ${week} not found in ${contentRoot}`);
      return 1;
    }
    const weekDir = join(artifact, week);
    try {
      const manifest = loadManifest(weekDir, week);
      const hashes = hashFiles(weekDir, manifest);
      const planned = planWeek({ week, posts: loaded[0].posts, manifest, fileHashes: hashes, config, enqueueAccounts: loaded[0].enqueueAccounts });
      if (loaded[0].enqueueAccounts) out.log(`${week}: enqueue_accounts = ${loaded[0].enqueueAccounts.join(", ")}`);
      const ctx: PlanContext = { postAccounts: Object.fromEntries(loaded[0].posts.map((p) => [p.id, p.accounts])), skippedAccounts: planned.skippedAccounts };
      plans.push({ week, ...planned, weekDir, hashes, ctx });
    } catch (e) {
      if (e instanceof PlanError) for (const p of e.problems) out.error(`error ${week}: ${p}`);
      else out.error(`error: ${(e as Error).message}`);
      out.error("nothing was scheduled");
      return 1;
    }
  }

  const { projectRoot: root } = projectPaths(args, cwd);
  const env = withLocalEnv(deps.env ?? process.env, root, deps.home, { tty: deps.tty ?? hasTty() });
  const fromEnv = env.GITHUB_SHA && FULL_SHA.test(env.GITHUB_SHA) ? env.GITHUB_SHA : undefined;
  const commit = commitArg ?? fromEnv ?? (deps.headCommit ?? (() => gitHeadCommit(root)))();
  const planOpts = { commit, isAncestor: deps.isAncestor ?? gitIsAncestor(root), now: new Date(now), allowPast };
  if (!commit) out.log("warning: no commit (pass --commit, or run inside a git checkout): rows are written without a commit and a stale run cannot be detected");
  const stamp: SourceStamp = { sourceCommit: commit ?? null, sourceCommittedAt: commit ? (deps.commitTime ?? ((c: string) => gitCommitTime(root, c)))(commit) : null };
  const supabaseEnv = Boolean(env.WEEKPOST_SUPABASE_URL && env.WEEKPOST_SUPABASE_KEY);

  if (dryRun) {
    for (const p of plans) {
      for (const r of p.rows) out.log(`  ${r.postId}/${r.account} ${r.type} ${r.publishAt} ${r.status ?? "scheduled"} ${r.media.length} file(s)`);
      for (const s of p.skippedAccounts) out.log(`  skip ${s} (account not in enqueue_accounts)`);
      for (const r of p.rows.filter(isPast)) out.log(`  past ${r.postId}/${r.account} ${r.publishAt}${allowPast ? "" : " (skipped without --allow-past)"}`);
    }
    // With a queue to read (credentials or an injected db) the dry run also shows what would be canceled; it never writes.
    if (deps.db || supabaseEnv) {
      try {
        const db = deps.db ?? supabaseDb(env.WEEKPOST_SUPABASE_URL ?? "", env.WEEKPOST_SUPABASE_KEY ?? "");
        for (const p of plans) for (const c of planUpserts(p.rows, await db.rows({ week: p.week }), p.ctx, planOpts).cancel) out.log(`  cancel ${c.key} (${c.reason})`);
      } catch (e) {
        out.error(`error: ${(e as Error).message}`);
        return 1;
      }
    }
    out.log(`dry run: ${plans.reduce((n, p) => n + p.rows.length, 0)} row(s) planned in ${weeks.join(", ")}; nothing was written`);
    return 0;
  }

  // 2. Read the queue, decide, then write.
  let db: OperatorDb, storage: NonNullable<EnqueueDeps["storage"]>;
  try {
    const url = env.WEEKPOST_SUPABASE_URL ?? "";
    const key = env.WEEKPOST_SUPABASE_KEY ?? "";
    db = deps.db ?? supabaseDb(url, key);
    storage = deps.storage ?? supabaseStorage(url, key, env.WEEKPOST_BUCKET || "weekpost-media");
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
  const summary = { scheduled: 0, updated: 0, skipped: [], canceled: [], revived: [] } as Required<Summary>;
  try {
    const decided = [];
    for (const p of plans) {
      const decision = planUpserts(p.rows, await db.rows({ week: p.week }), p.ctx, planOpts);
      decided.push({ p, decision, uploads: uploadsFor(p.uploads, decision) });
    }
    if (decided.some((d) => d.uploads.length)) await storage.ensureBucket?.();
    for (const { p, decision, uploads } of decided) {
      for (const u of uploads) {
        // Read again and compare: what is uploaded is what was approved, even if the file changed since the plan.
        const bytes = readArtifactFile(join(p.weekDir, u.from), u.from);
        if (sha256(bytes) !== p.hashes[u.from]) throw new Error(`${u.from} changed while enqueueing; nothing more was written`);
        await storage.put(u.to, bytes, u.contentType);
      }
      // Orphans first: if a later write fails, a post is missing until the next run, never published twice.
      for (const c of decision.cancel) {
        const [postId, account] = [c.key.slice(0, c.key.lastIndexOf("/")), c.key.slice(c.key.lastIndexOf("/") + 1)];
        await db.cancel({ postId, account }, "enqueue", stamp);
      }
      await db.insert(decision.insert.map((r) => ({ ...r, ...stamp })));
      for (const r of decision.update) await db.updateContent({ postId: r.postId, account: r.account }, { ...r, ...stamp }, { revive: r.revive });
      summary.scheduled += decision.insert.length + decision.update.length;
      summary.updated += decision.update.length;
      summary.canceled.push(...decision.cancel);
      summary.revived.push(...decision.update.filter((r) => r.revive).map((r) => `${r.postId}/${r.account}`));
      summary.skipped.push(...decision.skipped, ...p.skippedAccounts.map((key) => ({ key, reason: "account not in enqueue_accounts" })));
      out.log(`${p.week}: ${decision.insert.length} new, ${decision.update.length} updated, ${decision.skipped.length} skipped, ${decision.cancel.length} canceled`);
      for (const c of decision.cancel) out.log(`  cancel ${c.key} (${c.reason})`);
      for (const r of decision.update.filter((u) => u.revive)) out.log(`  restore ${r.postId}/${r.account} (canceled earlier when it left the YAML, and it is in it again)`);
      for (const s of decision.skipped) out.log(`  skip ${s.key} (${s.reason})`);
    }
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
  write(summary);
  out.log(`${summary.scheduled} scheduled, ${summary.skipped.length} skipped${summary.canceled.length ? `, ${summary.canceled.length} canceled` : ""}`);
  return 0;
}
