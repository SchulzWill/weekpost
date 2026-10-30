// Deletes the media from the bucket some days after `published` (Meta already holds its own copy).
// `mediaPurgedAt` makes the sweep idempotent. Only valid bucket paths are deleted (never URLs, never `..`).
import { isBucketPath } from "../queue/supabase.ts";
import type { PublisherDb, Storage } from "../queue/types.ts";

export const PURGE_AFTER_DAYS = 7;
export const PURGE_BATCH = 3;

export async function purgeOldMedia(
  db: PublisherDb, storage: Pick<Storage, "remove">, now: number, log: (e: string, d: Record<string, unknown>) => void,
  afterDays: number = PURGE_AFTER_DAYS,
): Promise<number> {
  const due = await db.duePurge(new Date(now - afterDays * 86_400_000).toISOString(), PURGE_BATCH);
  if (!due.length) return 0;
  const paths = due.flatMap((p) => [...p.media, ...(p.cover ? [p.cover] : [])]).filter((m) => isBucketPath(m));
  await storage.remove([...new Set(paths)]);
  for (const p of due) await db.markPurged({ postId: p.postId, account: p.account });
  log("media_purged", { posts: due.length, objects: paths.length });
  return due.length;
}
