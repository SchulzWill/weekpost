// `weekpost sources pull`: runs the configured adapters for a week and cleans what they return.
// Everything an adapter returns is untrusted text (news, notes, issues): it is stripped, cut and validated here
// before the week skill reads it.
import type { SourceAdapter, SourceItem } from "./types.ts";

export const TITLE_MAX = 300;
export const SUMMARY_MAX = 1200;
const WEEK = /^(\d{4})-W(\d{2})$/;
const DAY = 86_400_000;
const WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

export class SourceError extends Error {}

/** The ISO week before `week`, Monday 00:00 UTC to the next Monday (`from` inclusive, `to` exclusive). */
export function previousWeekWindow(week: string): { from: string; to: string } {
  const m = WEEK.exec(week);
  if (!m) throw new Error(`"${week}" is not a week; use YYYY-Www (e.g. 2026-W44)`);
  const year = Number(m[1]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstMonday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY;
  const monday = firstMonday + (Number(m[2]) - 1) * 7 * DAY;
  return { from: new Date(monday - 7 * DAY).toISOString(), to: new Date(monday).toISOString() };
}

/** Only the variables meant for sources. The infrastructure secrets never reach an adapter. */
export function sourceEnv(...envs: Record<string, string | undefined>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const env of envs) for (const [k, v] of Object.entries(env)) if (k.startsWith("WEEKPOST_SOURCE_") && v) out[k] = v;
  return out;
}

const URL_MAX = 2048;
const TAGS_MAX = 10;
const ERROR_MAX = 300;

const cut = (s: string, max: number) => [...s].slice(0, max).join("");

/** No HTML, no control characters, NFC, single spaces. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return cut(
    value
      .replace(/<[^>]*>/g, "")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      // Variation selectors can carry hidden bytes. U+FE0F (emoji presentation) stays.
      .replace(/[\uFE00-\uFE0E\u{E0100}-\u{E01EF}]/gu, "")
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length > URL_MAX) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** The cleaned item, or null when it cannot be trusted (no title, no https URL, no dated moment). */
export function normalizeItem(raw: SourceItem): SourceItem | null {
  const title = clean(raw?.title, TITLE_MAX);
  const url = httpsUrl(raw?.url);
  const id = clean(raw?.id, 200);
  if (!title || !url || !id || typeof raw.publishedAt !== "string" || !WITH_ZONE.test(raw.publishedAt.trim())) return null;
  const time = Date.parse(raw.publishedAt.trim());
  if (Number.isNaN(time)) return null;
  const item: SourceItem = { id, title, url, publishedAt: new Date(time).toISOString() };
  const outlet = clean(raw.outlet, 200);
  if (outlet) item.outlet = outlet;
  const original = httpsUrl(raw.originalUrl);
  if (original) item.originalUrl = original;
  const summary = clean(raw.summary, SUMMARY_MAX);
  if (summary) item.summary = summary;
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => clean(t, 60)).filter(Boolean).slice(0, TAGS_MAX) : [];
  if (tags.length) item.tags = tags;
  return item;
}

export type PulledItem = SourceItem & { source: string };
export type PullResult = { from: string; to: string; items: PulledItem[]; dropped: number };

export async function pullSources(o: {
  adapters: SourceAdapter[];
  week: string;
  limit: number;
  projectDir: string;
  /** Already filtered, or not: it is filtered again here. */
  env: Record<string, string | undefined>;
}): Promise<PullResult> {
  const { from, to } = previousWeekWindow(o.week);
  const env = sourceEnv(o.env);
  const hide = (text: string) => Object.values(env).reduce((acc, v) => (v.length >= 4 ? acc.split(v).join("[hidden]") : acc), text);
  const seen = new Set<string>();
  const items: PulledItem[] = [];
  let dropped = 0;

  for (const adapter of o.adapters) {
    let raw: unknown;
    try {
      raw = await adapter.pull({ week: o.week, from, to, limit: o.limit }, { projectDir: o.projectDir, env });
    } catch (e) {
      throw new SourceError(hide(`source "${adapter.name}" failed: ${(e as Error)?.message ?? String(e)}`).slice(0, ERROR_MAX));
    }
    if (!Array.isArray(raw)) throw new SourceError(`source "${adapter.name}" failed: it must return a list of items`);
    for (const r of raw as SourceItem[]) {
      const item = normalizeItem(r);
      if (!item || seen.has(item.url)) {
        if (!item) dropped += 1;
        continue;
      }
      seen.add(item.url);
      items.push({ source: adapter.name, ...item });
    }
  }
  const byDate = (a: PulledItem, b: PulledItem) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt);
  // Over the limit, keep the newest.
  const kept = items.sort(byDate).slice(-o.limit);
  return { from, to, items: kept, dropped };
}
