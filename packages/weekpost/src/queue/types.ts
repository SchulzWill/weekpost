// Contracts between the queue, the publisher and the storage adapters. Adapters implement
// these; nothing above them knows about PostgREST or the storage API.

export type Fetch = typeof fetch;

export type Key = { postId: string; account: string };
export type Status = "scheduled" | "publishing" | "published" | "failed" | "manual" | "canceled";
export type CanceledBy = "enqueue" | "operator";
export type PostType = "carousel" | "reel" | "story";

export interface QueueRow {
  postId: string;
  account: string;
  type: PostType;
  week: string;
  /** ISO timestamp. */
  publishAt: string;
  caption: string;
  /** Object paths in the media bucket, in publishing order. Never URLs. */
  media: string[];
  cover: string | null;
  link: string | null;
  contentHash: string | null;
  /** sha-256 over the hashes of the approved media (published files in order, then the cover). Null before migration 0002. */
  mediaHash?: string | null;
  status: Status;
  attempts: number;
  nextAttemptAt: string | null;
  claimedAt: string | null;
  containerId: string | null;
  mediaId: string | null;
  permalink: string | null;
  lastError: string | null;
  publishedAt: string | null;
  mediaPurgedAt: string | null;
  /** Set by `reschedule`: a later enqueue keeps this row's publishAt. */
  rescheduledAt: string | null;
  /** Commit whose YAML last wrote the row. Null before migration 0003. */
  sourceCommit?: string | null;
  sourceCommittedAt?: string | null;
  /** Who canceled a `canceled` row. Null (or absent) counts as the operator: rows canceled before migration 0003. */
  canceledBy?: CanceledBy | null;
}

/** Which commit wrote a row; set by the enqueue so a stale run can tell what is newer than itself. */
export type SourceStamp = { sourceCommit: string | null; sourceCommittedAt: string | null };

export type NewRow = Pick<
  QueueRow,
  "postId" | "account" | "type" | "week" | "publishAt" | "caption" | "media" | "cover" | "link" | "contentHash" | "mediaHash"
> & Partial<SourceStamp> & {
  /** Stories are published by hand, so they enter as `manual`. Default: `scheduled`. */
  status?: "scheduled" | "manual";
};

export interface Token {
  account: string;
  igUserId: string;
  accessToken: string;
  expiresAt: string;
  refreshedAt: string;
}

export interface PublisherDb {
  /** Due `scheduled` rows become `publishing` with attempts + 1. */
  claim(limit: number): Promise<QueueRow[]>;
  /** Only while `publishing`. */
  setContainer(k: Key, containerId: string | null): Promise<void>;
  markPublished(k: Key, r: { containerId: string | null; mediaId: string | null; permalink: string | null }): Promise<void>;
  markFailed(k: Key, error: string, retryInSeconds: number): Promise<"scheduled" | "failed">;
  /** Back to the queue without spending an attempt. */
  release(k: Key, containerId: string | null, retryInSeconds: number): Promise<void>;
  tokens(): Promise<Token[]>;
  /** Optimistic: false when someone else refreshed the token first. */
  saveToken(account: string, expectedRefreshedAt: string, accessToken: string, expiresAt: string): Promise<boolean>;
  duePurge(olderThanIso: string, limit: number): Promise<Pick<QueueRow, "postId" | "account" | "media" | "cover">[]>;
  markPurged(k: Key): Promise<void>;
  stuck(olderThanIso: string): Promise<Key[]>;
}

export interface OperatorDb {
  rows(filter: { week?: string; status?: Status[]; key?: Key }): Promise<QueueRow[]>;
  insert(rows: NewRow[]): Promise<void>;
  /**
   * Rewrites the content of a row that is still editable (`scheduled`, `manual`, `failed`). With `revive`, it instead
   * brings back a row the enqueue canceled (and only one the enqueue canceled): `c.status` (default `scheduled`), with
   * the attempts, error and container cleared.
   */
  updateContent(
    k: Key, c: Pick<NewRow, "caption" | "publishAt" | "media" | "cover" | "link" | "contentHash" | "mediaHash" | "status"> & Partial<SourceStamp>,
    opts?: { revive?: boolean },
  ): Promise<void>;
  /** Returns the previous status. Refuses `publishing` and `published`. `stamp` records the commit that canceled it. */
  cancel(k: Key, by: CanceledBy, stamp?: SourceStamp): Promise<Status>;
  /** Undoes a cancel: `scheduled` (`manual` for a Story) with a clean slate. Refuses a row that is not canceled. */
  restore(k: Key): Promise<void>;
  /** Only `scheduled`, or `failed` with `rearm` (which resets attempts and refuses a row that has a mediaId). */
  reschedule(k: Key, publishAt: string, opts: { rearm: boolean }): Promise<void>;
  /** Only `publishing`. */
  resolveStuck(k: Key, outcome: { published: true; permalink: string } | { published: false }): Promise<void>;
  /** Insert or replace the token of an account (`weekpost token`). */
  upsertToken(t: { account: string; igUserId: string; accessToken: string; expiresAt: string }): Promise<void>;
}

export type Db = PublisherDb & OperatorDb;

export interface Storage {
  /** Create-only: an object that already exists at the path (same content hash) is not an error. */
  put(path: string, bytes: Uint8Array, contentType: "image/jpeg" | "video/mp4"): Promise<void>;
  /** Same order as `paths`; a missing object is an error naming the path. */
  sign(paths: string[], ttlSeconds: number): Promise<string[]>;
  remove(paths: string[]): Promise<void>;
}
