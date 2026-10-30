// Contract of a topic source: where the weekly ideas come from (news, a notes file, issues, a database).
// An adapter returns plain data. `weekpost sources pull` cleans it and treats it as untrusted text.

export interface SourceItem {
  /** Stable within the source. */
  id: string;
  title: string;
  /** `https://`; the page the reader opens. */
  url: string;
  /** ISO 8601 with a time zone. */
  publishedAt: string;
  /** Who published it first (for a "Sources:" line in the caption). */
  outlet?: string;
  originalUrl?: string;
  summary?: string;
  tags?: string[];
}

export interface SourceQuery {
  /** The target week, `YYYY-Www`. */
  week: string;
  /** The window to read: the ISO week before the target week, in UTC. `from` is inclusive, `to` exclusive. */
  from: string;
  to: string;
  limit: number;
}

export interface SourceContext {
  projectDir: string;
  /**
   * Only the `WEEKPOST_SOURCE_*` variables, never the infrastructure secrets. This filters what weekpost hands over; it is
   * not isolation: an adapter is your own code, runs in this process and can read `process.env`.
   */
  env: Record<string, string | undefined>;
}

export interface SourceAdapter {
  name: string;
  pull(query: SourceQuery, ctx: SourceContext): Promise<SourceItem[]>;
}
