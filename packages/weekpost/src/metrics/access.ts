// Does a token have `instagram_business_manage_insights`? Asked the way `weekpost metrics` finds out: one small account
// Insights call, and Meta's permission errors (codes 10 and 200) mean the permission is missing. Any other failure
// (network, rate limit, a token Meta rejects) proves nothing about the permission, so it counts as "unknown".
//   https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
import type { InstagramGraph } from "../publisher/instagram.ts";
import { classify } from "./collect.ts";

export type InsightsAccess = "ok" | "missing" | "unknown";

export async function insightsAccess(graph: Pick<InstagramGraph, "accountInsights">, igUserId: string, token: string, now: Date): Promise<InsightsAccess> {
  const until = Math.floor(now.getTime() / 1000);
  try {
    await graph.accountInsights(igUserId, token, { metrics: ["reach"], sinceSeconds: until - 86_400, untilSeconds: until });
    return "ok";
  } catch (e) {
    return classify(e).kind === "no-permission" ? "missing" : "unknown";
  }
}

/** The warning for a token that cannot read Insights. Publishing works without the permission, so it is never an error. */
export const noInsightsMessage = (account: string) =>
  `the token for \`${account}\` cannot read Insights, so \`weekpost metrics\` will have no numbers (posts still publish). Generate it again in Meta's "API setup with Instagram login" with all three permissions (setup step 4, item 5), then run \`npx weekpost token ${account}\`.`;
