// Lint plugins: user code, imported by weekpost.config.ts, that adds rules to the core ones.
import type { WeekpostConfig } from "../config/schema.ts";
import type { Issue, Post } from "../content/post.ts";

export type LintContext = { config: WeekpostConfig; account: string; lang: string };

export interface LintPlugin {
  name: string;
  // Rules about the whole post. Return issues with the `where` you want (default: the post id).
  lintPost?(post: Post, ctx: { config: WeekpostConfig }): Issue[];
  // Rules about one text field in one account. `where` defaults to "<id> <account> <field>".
  lintText?(text: string, field: string, ctx: LintContext): Issue[];
  // Fixed closing line appended to the published caption of the post for that account.
  // `ctx` is optional for callers; plugins that ignore it keep working.
  captionSuffix?(post: Post, account: string, ctx?: { config: WeekpostConfig }): string | undefined;
}

// Runs a plugin hook; a plugin that throws becomes an error issue instead of crashing the check.
export function guarded(plugin: LintPlugin, where: string, run: () => Issue[] | undefined): Issue[] {
  try {
    return run() ?? [];
  } catch (e) {
    return [{ level: "error", where, message: `plugin "${plugin.name}" failed: ${(e as Error).message}` }];
  }
}
