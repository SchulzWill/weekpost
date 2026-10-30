// Refresh of the long-lived token (60 days): `GET /refresh_access_token?grant_type=ig_refresh_token`.
// Meta needs a token that is at least 24 h old and still valid. We refresh when less than 30 days are left
// (and the token is over a day old), which leaves ~30 days of slack for the cron to fail without losing access.
// The token never goes to a log.
import type { PublisherDb, Token } from "../queue/types.ts";
import type { InstagramGraph } from "./instagram.ts";

const DAY = 86_400_000;
export const REFRESH_WHEN_LEFT_MS = 30 * DAY;
export const MIN_AGE_MS = DAY;
export const ALERT_WHEN_LEFT_MS = 7 * DAY;

export function needsRefresh(t: Token, now: number): boolean {
  return Date.parse(t.expiresAt) - now < REFRESH_WHEN_LEFT_MS && now - Date.parse(t.refreshedAt) >= MIN_AGE_MS;
}

export interface RefreshOptions {
  /** false: never call Meta, only warn about tokens close to expiry (test tokens, smoke runs). */
  refresh: boolean;
}

export async function refreshTokens(
  tokens: Map<string, Token>, db: PublisherDb, graph: InstagramGraph, now: number,
  log: (e: string, d: Record<string, unknown>) => void, opts: RefreshOptions = { refresh: true },
): Promise<void> {
  for (const t of tokens.values()) {
    if (Date.parse(t.expiresAt) - now < ALERT_WHEN_LEFT_MS) log("ERROR_token_expiring", { account: t.account, expiresAt: t.expiresAt });
    if (!opts.refresh || !needsRefresh(t, now)) continue;
    try {
      const r = await graph.refresh(t.accessToken);
      const expiresAt = new Date(now + r.expiresInSeconds * 1000).toISOString();
      const saved = await db.saveToken(t.account, t.refreshedAt, r.accessToken, expiresAt);
      if (saved) {
        tokens.set(t.account, { ...t, accessToken: r.accessToken, expiresAt, refreshedAt: new Date(now).toISOString() });
        log("token_refreshed", { account: t.account, expiresAt });
      } else {
        log("token_refresh_lost_race", { account: t.account });
      }
    } catch (e) {
      log("ERROR_token_refresh", { account: t.account, error: String((e as Error).message) });
    }
  }
}
