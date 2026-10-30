// weekpost first-post <account> [--caption=<text>] [--yes] [--timeout=<minutes>] [--project=<dir>]
// Proves that your own Worker publishes: renders one plain brand card (no paid API), uploads it, queues a
// row for about a minute from now, then watches the queue until the permalink appears or the timeout ends.
// The post is PUBLIC on the real account, with the caption you give. Needs a terminal or --yes.
// One post per account per local day: the id is fixed, so repeating the command never queues a second one.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import { isoWeekOf } from "../content/week.ts";
import { formatLocal } from "../queue/operate.ts";
import { mediaHashOf } from "../queue/plan.ts";
import { supabaseDb } from "../queue/supabase.ts";
import { supabaseStorage } from "../queue/storage.ts";
import type { OperatorDb, QueueRow, Storage } from "../queue/types.ts";
import { brandFrom, esc, type Brand } from "../render/brand.ts";
import { withBrowser } from "../render/png.ts";
import { projectPaths, type Out } from "./check.ts";
import { optionOf, positional } from "./queueCommon.ts";
import { hasTty, requireTty, SecretError, withLocalEnv } from "./secrets.ts";

const USAGE = "usage: weekpost first-post <account> [--caption=<text>] [--yes] [--timeout=<minutes>] [--project=<dir>]";
const LEAD_MS = 60_000;
const POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MIN = 15; // the Worker's cron runs every 5 minutes, plus slack
const MAX_CAPTION = 2200;

export type FirstPostDeps = {
  /** Home directory the local secrets file is read from. Default: the real one; tests pass a temporary one. */
  home?: string;
  config?: WeekpostConfig;
  db?: Pick<OperatorDb, "rows" | "insert">;
  storage?: Storage & { ensureBucket?: () => Promise<void> };
  /** JPEG bytes of the card. Default: rendered with the brand of the config. */
  render?: (brandName: string, handle: string, account: string) => Promise<Uint8Array>;
  tty?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** Visible prompt for the caption. */
  ask?: (label: string) => Promise<string>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
};

/** Fixed per day, so a repeated run finds the row instead of queuing another. */
export const firstPostId = (localDate: string) => `${localDate}-weekpost-first-post`;

/** Turns the Worker's `last_error` into what to do next, pointing at the step in docs/setup.md. */
export function explainFailure(lastError: string | null, account: string): string {
  const e = lastError ?? "";
  if (/no Instagram token/i.test(e)) return `the Worker has no token for "${account}". Run: weekpost token ${account} (docs/setup.md, step 6), then run first-post again tomorrow or restore the post.`;
  if (/#190|OAuth|expired|invalid.*token/i.test(e)) return `Instagram refused the token. Generate a new long-lived token and run: weekpost token ${account} (docs/setup.md, step 6).`;
  if (/#10\b|#200|permission/i.test(e)) return `the token cannot publish. Generate it again with the instagram_business_content_publish permission and run: weekpost token ${account} (docs/setup.md, step 6).`;
  if (/container|image|JPEG|media/i.test(e)) return `Instagram rejected the image (${e.slice(0, 160)}). Check that the account is a professional account (docs/setup.md, step 1) and try again.`;
  if (/Supabase|storage|signed/i.test(e)) return `the Worker could not read the media or the database (${e.slice(0, 160)}). Check the Worker secrets WEEKPOST_SUPABASE_URL and WEEKPOST_SUPABASE_KEY (docs/setup.md, step 5).`;
  if (!e) return "no reason was recorded. Open the Worker logs and filter by ERROR (docs/operate.md, \"Reading the Worker logs\").";
  return `${e.slice(0, 300)}. See "Reading the Worker logs" in docs/operate.md.`;
}

function cardHtml(brand: Brand, handle: string, account: string): string {
  const { colors: T } = brand;
  return `<!doctype html><html lang="${brand.lang(account)}"><head><meta charset="utf-8"><style>
${brand.fontFaces}
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1350px;overflow:hidden}
body{font-family:${brand.fontStack};background:${T.dark};color:${T.onDark};display:flex;flex-direction:column;justify-content:center;align-items:center;gap:56px;padding:80px;text-align:center;-webkit-font-smoothing:antialiased}
.lockup svg,.lockup img{height:96px;width:auto;display:block}
h1{font-size:96px;font-weight:800;line-height:1.05;letter-spacing:-.02em;text-wrap:balance}
p{font-size:40px;color:${T.onDarkMuted}}
</style></head><body>
<div class="lockup">${brand.lockup(true)}</div>
<h1>${esc(brand.name)}</h1>
<p>@${esc(handle)}</p>
</body></html>`;
}

async function renderCard(config: WeekpostConfig, projectRoot: string, handle: string, account: string): Promise<Uint8Array> {
  const html = cardHtml(brandFrom(config, projectRoot), handle, account);
  const dir = mkdtempSync(join(tmpdir(), "weekpost-first-post-"));
  try {
    const file = join(dir, "card.jpg");
    await withBrowser(async (render) => render(html, file, { width: 1080, height: 1350 }));
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function ttyConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function ttyAsk(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${label}: `);
  } finally {
    rl.close();
  }
}

// Returns the exit code.
export async function runFirstPost(args: string[], out: Out = console, cwd = process.cwd(), deps: FirstPostDeps = {}): Promise<number> {
  const [accountId] = positional(args);
  if (!accountId) {
    out.error(USAGE);
    return 2;
  }
  const yes = args.includes("--yes"); // skips the confirmation prompt; it never replaces the terminal
  const tty = deps.tty ?? hasTty();
  const blocked = requireTty("first-post", out, tty);
  if (blocked) return blocked;
  const timeoutArg = optionOf(args, "timeout");
  const timeoutMin = timeoutArg === undefined ? DEFAULT_TIMEOUT_MIN : Number(timeoutArg);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
    out.error(`--timeout must be a number of minutes greater than 0, got "${timeoutArg}"`);
    return 2;
  }
  let caption = optionOf(args, "caption");
  if (caption === undefined) {
    if (!tty) {
      out.error("the post is public: pass --caption=<text> (there is no terminal to ask on)");
      return 2;
    }
    try {
      caption = await (deps.ask ?? ttyAsk)("Caption for the first post (public)");
    } catch (e) {
      out.error(e instanceof SecretError ? e.message : "could not read the caption");
      return 1;
    }
  }
  caption = caption.trim();
  if (!caption) {
    out.error("the caption is empty; the post is public, so write something");
    return 2;
  }
  if (caption.length > MAX_CAPTION) {
    out.error(`the caption has ${caption.length} characters; Instagram allows ${MAX_CAPTION}`);
    return 1;
  }

  const { projectRoot } = projectPaths(args, cwd);
  let config = deps.config;
  if (!config) {
    try {
      config = (await loadConfig(projectRoot)).config;
    } catch (e) {
      out.error(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`);
      return 1;
    }
  }
  const account = config.accounts[accountId];
  if (!account) {
    out.error(`unknown account "${accountId}"; the config has: ${Object.keys(config.accounts).join(", ")}`);
    return 1;
  }

  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = withLocalEnv(deps.env ?? process.env, projectRoot, deps.home, { tty });
  const localDate = formatLocal(now().toISOString(), account.timeZone).slice(0, 10);
  const postId = firstPostId(localDate);
  const key = { postId, account: accountId };

  let db = deps.db;
  let storage = deps.storage;
  try {
    db ??= supabaseDb(env.WEEKPOST_SUPABASE_URL ?? "", env.WEEKPOST_SUPABASE_KEY ?? "");
    storage ??= supabaseStorage(env.WEEKPOST_SUPABASE_URL ?? "", env.WEEKPOST_SUPABASE_KEY ?? "", env.WEEKPOST_BUCKET || "weekpost-media");
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }

  try {
    const existing = (await db.rows({ key }))[0];
    if (existing) {
      out.log(`${postId} already exists for "${accountId}" (${existing.status}); nothing new is queued`);
    } else {
      out.log(`This will publish a PUBLIC post on @${account.handle} (account "${accountId}"):\n  caption: ${caption}`);
      if (!yes && !(await (deps.confirm ?? ttyConfirm)(`Publish on @${account.handle}?`))) {
        out.error("nothing was queued");
        return 1;
      }
      const bytes = await (deps.render ?? ((_n, handle, acc) => renderCard(config!, projectRoot, handle, acc)))(config.brand.name, account.handle, accountId);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const path = `${isoWeekOf(localDate)}/${postId}/${accountId}/${sha}.jpg`;
      await storage!.ensureBucket?.();
      await storage!.put(path, bytes, "image/jpeg");
      const publishAt = new Date(now().getTime() + LEAD_MS).toISOString();
      await db.insert([{
        postId, account: accountId, type: "carousel", week: isoWeekOf(localDate), publishAt, caption, media: [path], cover: null, link: null,
        contentHash: createHash("sha256").update(`${caption}|${sha}`).digest("hex"), mediaHash: mediaHashOf([sha], null),
      }]);
      out.log(`queued ${postId}/${accountId} for ${publishAt}`);
    }
    return await watch(db, key, accountId, postId, timeoutMin, now, sleep, out);
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

async function watch(
  db: Pick<OperatorDb, "rows">, key: { postId: string; account: string }, accountId: string, postId: string,
  timeoutMin: number, now: () => Date, sleep: (ms: number) => Promise<void>, out: Out,
): Promise<number> {
  const deadline = now().getTime() + timeoutMin * 60_000;
  out.log(`waiting for the Worker (it runs every 5 minutes; up to ${timeoutMin} min)...`);
  let last: QueueRow | undefined;
  for (;;) {
    last = (await db.rows({ key }))[0];
    if (!last) {
      out.error(`${postId} is not in the queue`);
      return 1;
    }
    if (last.status === "published") {
      out.log(last.permalink ? `published: ${last.permalink}` : "published (no permalink was recorded; check the account)");
      return 0;
    }
    if (last.status === "failed") {
      out.error(`failed: ${explainFailure(last.lastError, accountId)}`);
      return 1;
    }
    if (last.status === "canceled") {
      out.error(`${postId} was canceled. To bring it back run: weekpost restore ${postId} --account=${accountId}`);
      return 1;
    }
    if (last.status === "manual") {
      out.error(`${postId} is marked manual and will not be published by the Worker`);
      return 1;
    }
    if (now().getTime() >= deadline) break;
    await sleep(POLL_MS);
  }
  out.error(
    `timed out after ${timeoutMin} min: the post is still ${last.status}. The Worker may not be running (docs/setup.md, step 5) or the cron has not fired yet. ` +
      `Check with: weekpost status. Running first-post again today only keeps watching; it never queues a second post.`,
  );
  return 1;
}
