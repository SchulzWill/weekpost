// Minimal client for the Instagram API with Instagram Login (host graph.instagram.com, not Facebook Login).
// Sources (Meta):
//   publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing
//   refresh:    https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login#refresh-a-long-lived-token
// The token travels in `Authorization: Bearer <token>` (it stays out of URLs, which proxies and traces log), except in
// the token refresh, whose documented example uses the `access_token` query parameter. It never reaches a log: every
// error message goes through `redact`.
//   Bearer header on the publishing calls (`<HOST_URL>` is graph.instagram.com for Instagram Login):
//   https://developers.facebook.com/docs/instagram-platform/content-publishing
//   NOT VERIFIED: the docs show the header only on the POST calls. The status and permalink GETs use it too (the
//   Graph API convention); confirm on the first real run, and move them back to the query if Meta rejects it.
import type { Fetch } from "../queue/types.ts";

/**
 * Pinned version. Override it with `graphVersion` in the run options if Meta rejects something,
 * no code change needed. The examples in the publishing docs use the same major line.
 * Changelog: https://developers.facebook.com/docs/graph-api/changelog
 */
export const GRAPH_API_VERSION = "v26.0";

export type ContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";

export class GraphError extends Error {
  constructor(message: string, readonly code?: number, readonly subcode?: number) {
    super(message);
  }
}

export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[token]") : text;
}

export class InstagramGraph {
  constructor(
    private readonly fetchFn: Fetch,
    private readonly version: string = GRAPH_API_VERSION,
  ) {}

  private url(path: string): string {
    return `https://graph.instagram.com/${this.version}/${path}`;
  }

  private async call(
    method: "GET" | "POST", url: string, token: string, params: Record<string, string>, opts: { tokenInQuery?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const all = opts.tokenInQuery ? { ...params, access_token: token } : params;
    const auth: Record<string, string> = opts.tokenInQuery ? {} : { authorization: `Bearer ${token}` };
    let res: Response;
    try {
      res =
        method === "GET"
          ? await this.fetchFn(`${url}?${new URLSearchParams(all)}`, { headers: auth })
          : await this.fetchFn(url, {
              method,
              headers: { "content-type": "application/x-www-form-urlencoded", ...auth },
              body: new URLSearchParams(all),
            });
    } catch (e) {
      throw new GraphError(`network: ${redact(String((e as Error)?.message ?? e), token)}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.error) {
      const err = (body.error ?? {}) as { message?: string; code?: number; error_subcode?: number; error_user_msg?: string };
      const code = err.code ? ` ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ""}` : "";
      const msg = err.error_user_msg ?? err.message ?? `HTTP ${res.status}`;
      throw new GraphError(redact(`Instagram${code}: ${msg}`, token), err.code, err.error_subcode);
    }
    return body;
  }

  private async create(igUserId: string, token: string, params: Record<string, string>): Promise<string> {
    const body = await this.call("POST", this.url(`${igUserId}/media`), token, params);
    if (typeof body.id !== "string") throw new GraphError("Instagram: container response without an id");
    return body.id;
  }

  createImage(igUserId: string, token: string, o: { imageUrl: string; caption: string }) {
    return this.create(igUserId, token, { image_url: o.imageUrl, caption: o.caption });
  }

  createCarouselItem(igUserId: string, token: string, imageUrl: string) {
    return this.create(igUserId, token, { image_url: imageUrl, is_carousel_item: "true" });
  }

  createCarousel(igUserId: string, token: string, o: { children: string[]; caption: string }) {
    return this.create(igUserId, token, { media_type: "CAROUSEL", children: o.children.join(","), caption: o.caption });
  }

  createReel(igUserId: string, token: string, o: { videoUrl: string; caption: string; coverUrl?: string }) {
    return this.create(igUserId, token, {
      media_type: "REELS",
      video_url: o.videoUrl,
      caption: o.caption,
      share_to_feed: "true",
      ...(o.coverUrl ? { cover_url: o.coverUrl } : {}),
    });
  }

  async status(containerId: string, token: string): Promise<ContainerStatus> {
    const body = await this.call("GET", this.url(containerId), token, { fields: "status_code" });
    return body.status_code as ContainerStatus;
  }

  async publish(igUserId: string, token: string, creationId: string): Promise<string> {
    const body = await this.call("POST", this.url(`${igUserId}/media_publish`), token, { creation_id: creationId });
    if (typeof body.id !== "string") throw new GraphError("Instagram: media_publish response without an id");
    return body.id;
  }

  async permalink(mediaId: string, token: string): Promise<string | null> {
    const body = await this.call("GET", this.url(mediaId), token, { fields: "permalink" });
    return typeof body.permalink === "string" ? body.permalink : null;
  }

  /**
   * Insights of one post: `GET /<media-id>/insights`. Meta rejects the whole request when one metric is not valid for the
   * media type, so the caller must pass only metrics that fit it. Values that are not numbers are left out.
   * https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
   */
  async mediaInsights(mediaId: string, token: string, metrics: string[]): Promise<Record<string, number>> {
    const body = await this.call("GET", this.url(`${mediaId}/insights`), token, { metric: metrics.join(",") });
    return insightValues(body, (m) => (m.values as { value?: unknown }[] | undefined)?.[0]?.value);
  }

  /**
   * Account insights summed over a window: `GET /<ig-user-id>/insights` with `metric_type=total_value`.
   * https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
   */
  async accountInsights(igUserId: string, token: string, o: { metrics: string[]; sinceSeconds: number; untilSeconds: number }): Promise<Record<string, number>> {
    const body = await this.call("GET", this.url(`${igUserId}/insights`), token, {
      metric: o.metrics.join(","), metric_type: "total_value", period: "day", since: String(o.sinceSeconds), until: String(o.untilSeconds),
    });
    return insightValues(body, (m) => (m.total_value as { value?: unknown } | undefined)?.value);
  }

  /** `followers_count` of the account profile. */
  async followersCount(igUserId: string, token: string): Promise<number | null> {
    const body = await this.call("GET", this.url(igUserId), token, { fields: "followers_count" });
    return typeof body.followers_count === "number" ? body.followers_count : null;
  }

  /** The account a token belongs to: `GET /me`. */
  async me(token: string): Promise<{ userId: string; username: string }> {
    const body = await this.call("GET", this.url("me"), token, { fields: "user_id,username" });
    const userId = body.user_id ?? body.id;
    if ((typeof userId !== "string" && typeof userId !== "number") || typeof body.username !== "string") {
      throw new GraphError("Instagram: unexpected /me response (no user_id or username)");
    }
    return { userId: String(userId), username: body.username };
  }

  /** Succeeds only when the token may publish: `GET /<ig-user-id>/content_publishing_limit`. */
  async publishingLimit(igUserId: string, token: string): Promise<void> {
    await this.call("GET", this.url(`${igUserId}/content_publishing_limit`), token, {});
  }

  /** Long-lived token to a new 60-day one. Needs a token that is at least 24 h old and still valid. */
  async refresh(token: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const body = await this.call("GET", "https://graph.instagram.com/refresh_access_token", token, { grant_type: "ig_refresh_token" }, { tokenInQuery: true });
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new GraphError("Instagram: unexpected refresh_access_token response");
    }
    return { accessToken: body.access_token, expiresInSeconds: body.expires_in };
  }
}

/** `{ data: [{ name, ... }] }` to `{ name: number }`, reading each value with `pick`. Titles and descriptions are localized and never used. */
function insightValues(body: Record<string, unknown>, pick: (m: Record<string, unknown>) => unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []) {
    const v = pick(m);
    if (typeof m.name === "string" && typeof v === "number" && Number.isFinite(v)) out[m.name] = v;
  }
  return out;
}
