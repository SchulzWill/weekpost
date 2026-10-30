// State machine for ONE post: container -> wait for `FINISHED` -> `media_publish` -> record the ids.
// Guarantees against publishing twice:
//   * only a post returned by `db.claim` gets here (`for update skip locked` -> `publishing`);
//   * `mediaId` already recorded -> only close the state, never publish;
//   * `containerId` already recorded -> reuse it (a Reel Meta is still processing resumes without a new container);
//   * container `PUBLISHED` (it went out but the record failed) -> close without publishing again;
//   * an error after `media_publish` never becomes a new publish attempt: the id and permalink are best-effort.
import { isBucketPath } from "../queue/supabase.ts";
import type { PublisherDb, QueueRow, Storage, Token } from "../queue/types.ts";
import type { InstagramGraph } from "./instagram.ts";

export interface PublishDeps {
  db: PublisherDb;
  storage: Pick<Storage, "sign">;
  graph: InstagramGraph;
  sleep: (ms: number) => Promise<void>;
  log: (event: string, data: Record<string, unknown>) => void;
  /** Status checks per run before the post goes back to the queue (each one is a subrequest). */
  maxPolls?: number;
  pollIntervalMs?: number;
  signedUrlTtlSeconds?: number;
}

/** Status checks per run before a post goes back to the queue. The subrequest budget is priced on it. */
export const MAX_POLLS = 3;

export type Outcome = "published" | "pending" | "retry" | "failed";

async function mediaUrls(deps: PublishDeps, entries: string[]): Promise<string[]> {
  // Bucket paths only: a URL or a malformed path is an error and is never fetched by Meta.
  for (const p of entries) if (!isBucketPath(p)) throw new Error(`invalid media path (expected a bucket path): ${p.slice(0, 80)}`);
  return deps.storage.sign(entries, deps.signedUrlTtlSeconds ?? 3600);
}

export const retryDelaySeconds = (attempts: number) => 300 * 2 ** Math.max(0, attempts - 1);

async function createContainer(post: QueueRow, token: Token, deps: PublishDeps): Promise<string> {
  const { graph } = deps;
  const urls = await mediaUrls(deps, [...post.media, ...(post.cover ? [post.cover] : [])]);
  const media = urls.slice(0, post.media.length);
  const cover = post.cover ? urls[post.media.length] : undefined;
  const id = token.igUserId;
  const t = token.accessToken;
  if (post.type === "reel") return graph.createReel(id, t, { videoUrl: media[0]!, caption: post.caption, coverUrl: cover });
  if (media.length === 1) return graph.createImage(id, t, { imageUrl: media[0]!, caption: post.caption });
  const children: string[] = [];
  for (const url of media) children.push(await graph.createCarouselItem(id, t, url));
  return graph.createCarousel(id, t, { children, caption: post.caption });
}

export async function processPost(post: QueueRow, token: Token | undefined, deps: PublishDeps): Promise<Outcome> {
  const { db, graph, log } = deps;
  const ref = { postId: post.postId, account: post.account };
  const maxPolls = deps.maxPolls ?? MAX_POLLS;
  let containerId = post.containerId;
  try {
    if (post.mediaId) {
      await db.markPublished(ref, { containerId, mediaId: post.mediaId, permalink: post.permalink });
      return "published";
    }
    if (post.type === "story") throw new Error("Stories are published by hand (the API cannot create the link sticker)");
    if (!token) throw new Error(`no Instagram token for account ${post.account}`);
    const t = token.accessToken;

    if (!containerId) {
      containerId = await createContainer(post, token, deps);
      await db.setContainer(ref, containerId); // before any wait: if the run dies, the next one resumes
      log("container_created", { post: post.postId, account: post.account, type: post.type });
    }

    for (let poll = 0; ; poll++) {
      const status = await graph.status(containerId, t);
      if (status === "PUBLISHED") {
        // It went out but the record was never written. Close without publishing again.
        await db.markPublished(ref, { containerId, mediaId: null, permalink: null });
        log("already_published", { post: post.postId, account: post.account });
        return "published";
      }
      if (status === "FINISHED") break;
      if (status === "ERROR" || status === "EXPIRED") {
        await db.setContainer(ref, null); // dead container: the next attempt creates another
        throw new Error(`Meta marked the container as ${status}`);
      }
      if (poll + 1 >= maxPolls) {
        await db.release(ref, containerId, 120); // does not spend an attempt
        log("still_processing", { post: post.postId, account: post.account });
        return "pending";
      }
      await deps.sleep(deps.pollIntervalMs ?? 10_000);
    }

    const mediaId = await graph.publish(token.igUserId, t, containerId);
    let permalink: string | null = null;
    try {
      permalink = await graph.permalink(mediaId, t);
    } catch {
      /* the post is out; no permalink for now */
    }
    for (let i = 0; ; i++) {
      try {
        await db.markPublished(ref, { containerId, mediaId, permalink });
        break;
      } catch (e) {
        if (i >= 1) {
          // Stays `publishing` (safe: nobody picks it up again). Alert so a human resolves it.
          log("ERROR_record_published", { post: post.postId, account: post.account, mediaId, error: String(e) });
          return "failed";
        }
      }
    }
    log("post_published", { post: post.postId, account: post.account, mediaId });
    return "published";
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 1800);
    const status = await db.markFailed(ref, msg, retryDelaySeconds(post.attempts));
    log("post_failed", { post: post.postId, account: post.account, status, attempts: post.attempts, error: msg });
    return status === "failed" ? "failed" : "retry";
  }
}
