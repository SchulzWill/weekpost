// Pure planning of `weekpost enqueue`: turns an approved week (manifest v1 plus the files on disk) into queue rows,
// the uploads they need, and the decision to insert, update or skip each row. No network, no disk.
import { createHash } from "node:crypto";
import type { WeekpostConfig } from "../config/schema.ts";
import { contentHash } from "../content/hash.ts";
import type { Post } from "../content/post.ts";
import { captionFor } from "../lint/caption.ts";
import type { Manifest } from "../render/manifest.ts";
import { realImageFile } from "../render/jobs.ts";
import type { NewRow, QueueRow } from "./types.ts";

export type Upload = { from: string; to: string; contentType: "image/jpeg" | "video/mp4" };
export type PlannedRow = NewRow;
export type SkippedAccount = string;
/** `kind` names the categories the PR comment explains; the others (unchanged, wrong status) have none. */
export type Skipped = { key: string; reason: string; kind?: "newer" | "operator" | "past" };
/** An update; with `revive`, the row was canceled by the enqueue and comes back to the queue. */
export type PlannedUpdate = PlannedRow & { revive?: true };
export type Canceled = { key: string; reason: string };
/** What the approved YAML says, to explain why a queued row is no longer wanted. */
export type PlanContext = { postAccounts: Record<string, string[]>; skippedAccounts: string[] };

/** One hash for the media a row was approved with: the sha-256 of each published file in order, then the cover. */
export function mediaHashOf(publishHashes: string[], coverHash: string | null): string {
  return createHash("sha256").update(`${publishHashes.join(",")}|${coverHash ?? ""}`).digest("hex");
}

export class PlanError extends Error {
  constructor(readonly problems: string[]) {
    super(`the manifest does not match the merged content:\n- ${problems.join("\n- ")}`);
  }
}

const parts = (zone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });

function offsetMs(fmt: Intl.DateTimeFormat, instant: number): number {
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/** "YYYY-MM-DD" + "HH:MM" local to an IANA zone -> UTC ISO instant. Uses the zone rules, not a fixed offset. */
export function localToUtc(date: string, time: string, zone: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const fmt = parts(zone);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - offsetMs(fmt, wall);
  utc = wall - offsetMs(fmt, utc); // second pass: the offset may be the one on the other side of a change
  return new Date(utc).toISOString();
}

const contentTypeOf = (file: string): Upload["contentType"] => (file.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
const MEDIA_FILE = /^[a-z0-9-]+\/[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|mp4)$/;

export interface PlanInput {
  week: string;
  posts: Post[];
  manifest: Manifest;
  /** sha-256 of each file as it is on disk, keyed by the path in the manifest. A missing key means no file. */
  fileHashes: Record<string, string>;
  config: WeekpostConfig;
  /** From posts.yaml; absent = all accounts. */
  enqueueAccounts?: string[];
}

export function planWeek(input: PlanInput): { rows: PlannedRow[]; uploads: Upload[]; skippedAccounts: SkippedAccount[] } {
  const { week, posts, manifest, fileHashes, config, enqueueAccounts } = input;
  const problems: string[] = [];
  const rows: PlannedRow[] = [];
  const uploads: Upload[] = [];
  const skippedAccounts: string[] = [];
  if (manifest.week !== week) problems.push(`the manifest is for week ${manifest.week}, not ${week}`);

  for (const post of posts) {
    const accounts = enqueueAccounts ? post.accounts.filter((a) => enqueueAccounts.includes(a)) : post.accounts;
    skippedAccounts.push(...post.accounts.filter((a) => !accounts.includes(a)).map((a) => `${post.id}/${a}`));
    if (!accounts.length) continue;
    const entry = manifest.posts.find((p) => p.id === post.id);
    if (!entry) {
      problems.push(`${post.id}: missing from the manifest of the approved preview`);
      continue;
    }
    if (entry.error) {
      problems.push(`${post.id}: the preview had a generation error: ${entry.error}`);
      continue;
    }
    const hash = contentHash(post);
    if (entry.contentHash !== hash) {
      problems.push(`${post.id}: the post changed after the preview (contentHash differs); generate and review the week again`);
      continue;
    }
    if (entry.type !== post.type) problems.push(`${post.id}: type ${entry.type} in the manifest, ${post.type} in the content`);

    for (const acc of accounts) {
      const where = `${post.id}/${acc}`;
      const media = entry.accounts[acc];
      if (!media) {
        problems.push(`${where}: no media in the manifest`);
        continue;
      }
      const zone = config.accounts[acc]?.timeZone;
      if (!zone) {
        problems.push(`${where}: account ${acc} is not in the config`);
        continue;
      }
      if (entry.timeZones[acc] !== zone) problems.push(`${where}: time zone ${entry.timeZones[acc] ?? "(none)"} in the manifest, ${zone} in the config`);
      const expectedCount = post.type === "carousel" ? post.slides.length : 1;
      if (media.publish.length !== expectedCount) {
        problems.push(`${where}: ${media.publish.length} published file(s), ${expectedCount} ${post.type === "carousel" ? "slide(s)" : "file expected"}`);
      }
      const caption = captionFor(post, acc, config);
      // A Story's caption in the manifest carries a note about the link sticker, so only the other types are compared.
      if (post.type !== "story" && media.caption !== caption) problems.push(`${where}: caption differs from the one the preview approved`);

      const cover = media.cover;
      if (realImageFile(post) && !cover) problems.push(`${where}: the first segment is a real photo but the manifest has no cover`);
      const files = [...media.publish, ...(cover ? [cover] : [])];
      let ok = true;
      for (const f of files) {
        if (!MEDIA_FILE.test(f) || !f.startsWith(`${post.id}/${acc}/`)) {
          problems.push(`${where}: ${f} is outside ${post.id}/${acc}/`);
          ok = false;
        } else if (fileHashes[f] === undefined) {
          problems.push(`${where}: ${f}: file is missing from the artifact`);
          ok = false;
        } else if (fileHashes[f] !== media.sha256[f]) {
          problems.push(`${where}: ${f}: hash on disk differs from the manifest`);
          ok = false;
        }
      }
      if (!ok || (realImageFile(post) && !cover) || media.publish.length !== expectedCount) continue;

      // Content-addressed: <week>/<post>/<account>/<sha256>.<ext>. A changed file gets a new name, so an upload can
      // never replace bytes a queued (or publishing) row still points to, and the CDN never serves a stale copy.
      const to = (f: string) => `${week}/${post.id}/${acc}/${fileHashes[f]}${f.slice(f.lastIndexOf("."))}`;
      for (const f of files) if (!uploads.some((u) => u.to === to(f))) uploads.push({ from: f, to: to(f), contentType: contentTypeOf(f) });
      rows.push({
        postId: post.id, account: acc, type: post.type, week,
        publishAt: localToUtc(post.date, post.times[acc], zone),
        caption, media: media.publish.map(to), cover: cover ? to(cover) : null,
        link: post.link[acc] ?? null, contentHash: hash,
        mediaHash: mediaHashOf(media.publish.map((f) => fileHashes[f]), cover ? fileHashes[cover] : null),
        ...(post.type === "story" ? { status: "manual" as const } : {}),
      });
    }
  }
  if (problems.length) throw new PlanError(problems);
  return { rows, uploads, skippedAccounts };
}

const key = (r: { postId: string; account: string }) => `${r.postId}/${r.account}`;
const sameInstant = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();

export type PlanOptions = {
  /** The commit whose YAML this run reads. */
  commit?: string;
  /** True when `ancestor` is `descendant` or one of its ancestors. */
  isAncestor?: (ancestor: string, descendant: string) => boolean;
  /** The clock. With it, a post whose publish time has passed is skipped (Stories are exempt) unless `allowPast`. */
  now?: Date;
  allowPast?: boolean;
};

/**
 * Decides insert, update or skip for each planned row against the rows already in the queue.
 * - A row written by a commit that is not this one or one of its ancestors was queued by a newer merge (this run is a
 *   re-run of an old merge, or finished out of order): it is neither canceled nor rewritten. Rows without a commit are old.
 * - `publishing` and `published` rows are never touched (the content is frozen, and Meta may still be reading the media).
 * - A post (new, rewritten or brought back) whose publish time is already past is skipped, not failed: it would go out
 *   at once, in a burst with the others, and one such post must not hold back the rest of the week. `allowPast` queues it
 *   with its own time. Stories are exempt (published by hand), and so is filling in the media hash of an old row.
 * - A `canceled` row stays canceled when the operator canceled it (`weekpost cancel`; `weekpost restore` undoes that). One the
 *   enqueue canceled (the post left the YAML) comes back, with the current content, when the YAML has it again.
 *   A Story is only rewritten while it is still `manual`.
 * - A row with the same contentHash, media hash and publish time is skipped: the media already queued is not replaced.
 *   A different media hash (a second preview of the same YAML was approved) is an update, while the row is still editable.
 * - A `scheduled`, `failed` or `manual` row of the week that is not in the plan is canceled: the approved YAML is the source
 *   of truth (a post removed, a date changed, an account dropped). `publishing`, `published` and `canceled` are left alone.
 * - A row rescheduled by hand keeps its time until its content changes; even then the time stays.
 */
export function planUpserts(
  rows: PlannedRow[], existing: QueueRow[], ctx?: PlanContext, opts: PlanOptions = {},
): { insert: PlannedRow[]; update: PlannedUpdate[]; skipped: Skipped[]; cancel: Canceled[] } {
  const current = new Map(existing.map((r) => [key(r), r]));
  const insert: PlannedRow[] = [];
  const update: PlannedUpdate[] = [];
  const skipped: Skipped[] = [];
  const cancel: Canceled[] = [];
  const planned = new Set(rows.map(key));
  const newer = (r: QueueRow): Skipped | null =>
    opts.commit && opts.isAncestor && r.sourceCommit && !opts.isAncestor(r.sourceCommit, opts.commit)
      ? { key: key(r), kind: "newer", reason: `queued by a newer commit (${r.sourceCommit.slice(0, 7)}), this run reads ${opts.commit.slice(0, 7)}; left as it is` }
      : null;
  /** A past time, as a skip; null when the post may be queued. Stories (`manual`) are exempt. */
  const past = (row: PlannedRow, publishAt: string): Skipped | null =>
    opts.now && !opts.allowPast && row.status !== "manual" && new Date(publishAt).getTime() < opts.now.getTime()
      ? { key: key(row), kind: "past", reason: `publish time ${new Date(publishAt).toISOString()} is in the past; use --allow-past (the workflow input allow_past) to queue it anyway, or move the post to a future date` }
      : null;
  for (const old of existing) {
    if (planned.has(key(old)) || !(["scheduled", "failed", "manual"] as const).includes(old.status as "scheduled")) continue;
    const stale = newer(old);
    if (stale) skipped.push(stale);
    else cancel.push({ key: key(old), reason: orphanReason(old, ctx) });
  }
  for (const row of rows) {
    const found = current.get(key(row));
    if (!found) {
      const late = past(row, row.publishAt);
      if (late) skipped.push(late);
      else insert.push(row);
    }
    else if (found.status === "publishing" || found.status === "published") skipped.push({ key: key(row), reason: `status is ${found.status}` });
    else if (found.status === "canceled") {
      if (found.canceledBy !== "enqueue") {
        skipped.push({
          key: key(row), kind: "operator",
          reason: `canceled by the operator; run "weekpost restore ${row.postId} --account=${row.account}" to bring it back`,
        });
      } else {
        const stale = newer(found);
        const publishAt = found.rescheduledAt ? found.publishAt : row.publishAt;
        const late = past(row, publishAt);
        if (stale) skipped.push(stale);
        else if (late) skipped.push(late);
        else update.push({ ...row, publishAt, revive: true });
      }
    } else if (row.status && found.status !== row.status) skipped.push({ key: key(row), reason: `status is ${found.status}` });
    else {
      const publishAt = found.rescheduledAt ? found.publishAt : row.publishAt;
      if (found.contentHash === row.contentHash && (found.mediaHash ?? null) === row.mediaHash && sameInstant(found.publishAt, publishAt)) skipped.push({ key: key(row), reason: "already queued, unchanged" });
      else {
        const stale = newer(found);
        // Filling in the hash of a row written before it existed changes nothing the publisher would act on.
        const backfill = found.contentHash === row.contentHash && sameInstant(found.publishAt, publishAt) && found.mediaHash == null;
        const late = backfill ? null : past(row, publishAt);
        if (stale) skipped.push(stale);
        else if (late) skipped.push(late);
        else update.push({ ...row, publishAt });
      }
    }
  }
  return { insert, update, skipped, cancel };
}

function orphanReason(old: QueueRow, ctx?: PlanContext): string {
  if (!ctx) return "not in the approved plan";
  if (ctx.skippedAccounts.includes(key(old))) return "the account is not in enqueue_accounts";
  const accounts = ctx.postAccounts[old.postId];
  if (!accounts) return "the post is no longer in the week's YAML (removed, or its id/date changed)";
  if (!accounts.includes(old.account)) return "the account is no longer in the post";
  return "not in the approved plan";
}

/** Only the media of rows that will be written; a skipped row never touches the bucket. */
export function uploadsFor(uploads: Upload[], plan: { insert: PlannedRow[]; update: PlannedRow[] }): Upload[] {
  const wanted = new Set([...plan.insert, ...plan.update].flatMap((r) => [...r.media, ...(r.cover ? [r.cover] : [])]));
  return uploads.filter((u) => wanted.has(u.to));
}
