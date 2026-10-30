// Pure rules of the operator commands (`status`, `cancel`, `reschedule`, `resolve`): which states allow what, the
// before/after shown for confirmation, and the messages that name the post, the account and the reason.
import { isoWeekOf } from "../content/week.ts";
import { localToUtc } from "./plan.ts";
import type { Key, QueueRow, Status } from "./types.ts";

export const STUCK_AFTER_MINUTES = 30;

export const label = (k: Key) => `${k.postId}/${k.account}`;

/** Week folder of a post id: ids start with the post date. */
export function weekOfPostId(postId: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(postId);
  if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) throw new Error(`"${postId}" is not a post id (ids start with the date, like 2026-10-12-tip)`);
  return isoWeekOf(m[1]);
}

/** "YYYY-MM-DD HH:MM" of an instant in an IANA zone. Falls back to UTC when the zone is unknown. */
export function formatLocal(iso: string, zone: string | undefined): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: zone ?? "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export type Zones = Record<string, string>;

export function statusLine(r: QueueRow, zones: Zones): string {
  const zone = zones[r.account];
  const bits = [`${label(r)}`, r.status.padEnd(10), `${formatLocal(r.publishAt, zone)} ${zone ?? "UTC"}`];
  if (r.rescheduledAt) bits.push("(time set by the CLI)");
  if (r.attempts > 0 && r.status !== "published") bits.push(`attempts ${r.attempts}`);
  if (r.status === "published" && r.permalink) bits.push(r.permalink);
  if (r.status === "canceled") bits.push(`(canceled by the ${r.canceledBy === "enqueue" ? "enqueue" : "operator"})`);
  if (r.lastError && (r.status === "failed" || r.status === "scheduled")) bits.push(`error: ${r.lastError.slice(0, 120)}`);
  return bits.join("  ");
}

export function statusJson(r: QueueRow, zones: Zones) {
  const timeZone = zones[r.account] ?? "UTC";
  return { ...r, localTime: formatLocal(r.publishAt, timeZone), timeZone };
}

export type Change = { ok: true; key: Key; before: string; after: string } | { ok: false; key: Key; reason: string };
const refuse = (r: Key, reason: string): Change => ({ ok: false, key: r, reason });

export function planCancel(r: QueueRow): Change {
  if (r.status === "canceled") return refuse(r, `${label(r)} is already canceled`);
  if (r.status === "publishing") return refuse(r, `cannot cancel ${label(r)}: it is being published right now; wait for it to finish or fail`);
  if (r.status === "published") return refuse(r, `cannot cancel ${label(r)}: it is already published${r.permalink ? ` (${r.permalink})` : ""}; delete it on Instagram`);
  return { ok: true, key: r, before: r.status, after: "canceled" };
}

/** Undoes a cancel. A time already past is refused unless `allowPast`: the row would be due at once (Stories are published by hand, so they are exempt). */
export function planRestore(r: QueueRow, opts: { zone?: string; now: Date; allowPast: boolean }): Change {
  if (r.status !== "canceled") return refuse(r, `cannot restore ${label(r)}: status is ${r.status}; only a canceled post can be restored`);
  const when = `${formatLocal(r.publishAt, opts.zone)} ${opts.zone ?? "UTC"}`;
  const past = r.type !== "story" && new Date(r.publishAt).getTime() <= opts.now.getTime();
  if (past && !opts.allowPast) {
    return refuse(r, `cannot restore ${label(r)}: its time ${when} is in the past, so it would go out at once; use --allow-past if that is what you want`);
  }
  return {
    ok: true, key: r, before: `canceled (by the ${r.canceledBy === "enqueue" ? "enqueue" : "operator"})`,
    after: `${r.type === "story" ? "manual" : "scheduled"}, ${when}${past ? " (in the past: it goes out at the next publisher run)" : ""}`,
  };
}

/** `at` is "YYYY-MM-DD HH:MM", local time of the account. */
export function parseLocalTime(at: string, zone: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(at.trim());
  if (!m || Number.isNaN(Date.parse(`${m[1]}T${m[2]}:00Z`)) || new Date(`${m[1]}T${m[2]}:00Z`).toISOString().slice(0, 16) !== `${m[1]}T${m[2]}`) {
    throw new Error(`--at must be a real date and time as "YYYY-MM-DD HH:MM" (local time of the account), got "${at}"`);
  }
  return localToUtc(m[1], m[2], zone);
}

export function planReschedule(r: QueueRow, publishAt: string, opts: { rearm: boolean; zone?: string; now: Date }): Change {
  const zone = opts.zone;
  if (r.status === "failed" && !opts.rearm) return refuse(r, `cannot reschedule ${label(r)}: it failed (${r.attempts} attempt(s)); use --rearm to try again`);
  if (r.status !== "scheduled" && r.status !== "failed") {
    const why: Partial<Record<Status, string>> = {
      publishing: "it is being published right now", published: "it is already published", canceled: "it is canceled", manual: "Stories are published by hand",
    };
    return refuse(r, `cannot reschedule ${label(r)}: status is ${r.status}${why[r.status] ? ` (${why[r.status]})` : ""}`);
  }
  if (opts.rearm && r.mediaId) return refuse(r, `cannot rearm ${label(r)}: it already has a media id (${r.mediaId}); check Instagram first, it may be published`);
  if (new Date(publishAt).getTime() <= opts.now.getTime()) return refuse(r, `cannot reschedule ${label(r)}: ${formatLocal(publishAt, zone)} is in the past`);
  const when = (iso: string) => `${formatLocal(iso, zone)} ${zone ?? "UTC"}`;
  const rearmNote = r.status === "failed" ? ", attempts reset to 0" : "";
  return { ok: true, key: r, before: `${r.status}, ${when(r.publishAt)}`, after: `scheduled, ${when(publishAt)}${rearmNote}` };
}

export type Outcome = { published: true; permalink: string } | { published: false };

export function planResolve(r: QueueRow, outcome: Outcome, now: Date): Change {
  if (r.status !== "publishing") return refuse(r, `cannot resolve ${label(r)}: status is ${r.status}; only a row stuck in publishing can be resolved`);
  const since = r.claimedAt ? now.getTime() - new Date(r.claimedAt).getTime() : Infinity;
  if (since < STUCK_AFTER_MINUTES * 60_000) {
    return refuse(r, `cannot resolve ${label(r)}: it has been publishing for ${Math.floor(since / 60_000)} min; wait until ${STUCK_AFTER_MINUTES} min in case the publisher is still working`);
  }
  if (outcome.published && !/^https:\/\/[^\s]+$/.test(outcome.permalink)) return refuse(r, `--published needs the post's https link, got "${outcome.permalink}"`);
  return {
    ok: true, key: r, before: "publishing",
    after: outcome.published ? `published (${outcome.permalink})` : "scheduled, attempts reset to 0 (it will be tried again; check Instagram first so it is not posted twice)",
  };
}
