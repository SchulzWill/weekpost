# Operate

Day-to-day use: the workflows, the queue commands, topic sources and the Worker logs. Back to the [README](../README.md).

## What the workflows do

| Workflow | When | Secrets |
|---|---|---|
| `weekpost-check` | every pull request that touches `content/` or the config | none |
| `weekpost-preview` | label `media-ok` on a pull request from a branch of the same repository, and again on every push while the label stays | `OPENROUTER_API_KEY` |
| `weekpost-enqueue` | push to `main` that touches a week folder, or manually with a pull request number (the job refuses any ref other than `main`) | `WEEKPOST_SUPABASE_URL`, `WEEKPOST_SUPABASE_KEY` (environment `weekpost`) |

Several merges in a row all reach the queue: the enqueue runs once per merge and runs may overlap. Every queued row remembers the commit that wrote it (`--commit`, which the workflow sets to the merge commit), and a run only cancels or rewrites rows written by its own commit or an ancestor of it. So re-running an old merge, or two runs finishing out of order, never undoes what a newer merge queued: those rows are left alone and the comment lists them as skipped (`queued by a newer commit`). The workflow checks out the full history so git can answer that question.

The preview is kept as an artifact for 30 days. Open it with `npx weekpost preview <pr-number>` (needs the [GitHub CLI](https://cli.github.com)). If you merge without a preview, or the artifact has expired, the enqueue writes nothing and comments what to do: re-apply the label, which generates new media and needs a new review. Pull requests from forks never run the preview. The workflows have no `pull_request_target`, minimal permissions, and every third-party action pinned to a commit SHA.

## Operate

Every `posts.yaml` starts with `version: <n>`, the version of the file format it was written in (today `1`). A newer weekpost keeps reading the older versions, so updating the package never asks you to edit a week that is already written, and weekpost never rewrites one: the file on disk stays byte for byte as it was. `weekpost check` validates each week by the version it declares; a version this weekpost does not read gets an error that says which one.

The queue commands read `WEEKPOST_SUPABASE_URL` and `WEEKPOST_SUPABASE_KEY` (the secret key) from the environment or, at a terminal, from the local file `~/.config/weekpost/` that `setup` writes. Commands that write (`cancel`, `reschedule`, `resolve`, `restore`, `first-post`, `enqueue`, `token`) do not read that file without a terminal; there, set the variables in the environment (CI does). `status` and `doctor` always read the file. Without `--yes`, the commands that change a post show the before and after and ask.

```sh
npx weekpost status                      # posts not finished yet (scheduled, manual, publishing, failed)
npx weekpost status --week=2026-W45      # one week, any state
npx weekpost status --failed --json
npx weekpost cancel <post-id> --account=en
npx weekpost restore <post-id> --account=en                              # undo a cancel (scheduled again; a Story goes back to manual)
npx weekpost reschedule <post-id> --account=en --at="2026-11-09 18:30"   # local time of the account
npx weekpost reschedule <post-id> --account=en --at="2026-11-09 18:30" --rearm   # a failed post: try again
npx weekpost resolve <post-id> --account=en --published=<permalink>      # stuck in publishing: it did go out
npx weekpost resolve <post-id> --account=en --not-published              # stuck in publishing: it did not
npx weekpost package 2026-W45            # caption, time and media per post, for posting by hand (Stories)
```

`token` needs a terminal (it refuses to run from an agent shell). Copy the long-lived token from the Meta panel and run `npx weekpost token en`: it reads the clipboard (or a hidden prompt with `--prompt`), confirms on the Graph API that the token belongs to the account's handle and may publish, saves it in `weekpost_tokens` (59 days) and clears the clipboard. It never prints the token.

`first-post` checks that your Worker really publishes. After `token`, run `npx weekpost first-post en --caption="Hello"` in a terminal (`--yes` skips the confirmation but never the terminal): it confirms the account handle, renders a plain card with your brand name (no paid API), queues it for about a minute ahead and watches the queue for up to 15 minutes (`--timeout=<minutes>`; the Worker's cron runs every 5 minutes), then prints the permalink. **The post is public on the real account**, so the caption is yours and required (without `--caption` it asks). If it fails, it translates the Worker's error and points to the step in [docs/setup.md](setup.md) to fix. Repeating the command the same day never queues a second post: it finds the existing row and keeps watching it. Delete the post on Instagram when you are done; weekpost does not delete media.

`cancel` works on posts that have not gone out, and `restore` undoes it (it refuses a publish time already past unless you add `--allow-past`, because the post would go out at once). `reschedule` only moves scheduled posts (or failed ones with `--rearm`), and the new time wins over later merges until the YAML changes again. `resolve` only works on a post stuck in `publishing` for more than 30 minutes. Failed posts are retried up to 3 times, waiting 5 and then 10 minutes, before they stay `failed`.

### Topic sources

`sources` in `weekpost.config.ts` is an optional list of adapters (`{ name, pull(query, ctx) }` returning `{ id, title, url, publishedAt, outlet?, originalUrl?, summary?, tags? }[]`). `npx weekpost sources pull 2026-W45` asks each one for the previous ISO week, strips HTML and control characters, cuts long fields, keeps only `https://` URLs, removes duplicates and writes `content/2026-W45/sources.json`. Adapters get only the `WEEKPOST_SOURCE_*` variables from the environment and `.env.local`. Exit codes: 0 items (or no source configured), 4 no items in the window, 1 a source failed.

The built-in `ideasFile` reads lines like `- an idea — https://example.com/page` from a file in your repo and dates each one by the commit of its line:

```ts
import { defineConfig, ideasFile } from "weekpost";
export default defineConfig({ /* ... */ sources: [ideasFile({ path: "content/ideas.md" })] });
```

### Reading the Worker logs

The Worker logs one JSON line per event. In the Cloudflare dashboard, open the Worker's logs and filter by `ERROR`.

| Event | What it means | What to do |
|---|---|---|
| `ERROR_no_token` | no account has a token | seed the row in `weekpost_tokens` (step 4) |
| `ERROR_token_expiring` | a token has fewer than 7 days left | check that renewal works; if `ERROR_token_refresh` also shows, generate a new token and update the row |
| `ERROR_token_refresh` | Meta refused the renewal | the token may be revoked or too new (needs 24 hours); replace it by hand |
| `ERROR_post` | the database could not record a post's state; the post stays in `publishing` | run `status`, then `resolve` once you know whether it went out |
| `ERROR_record_published` | the post went live but recording it failed | `resolve --published=<permalink>` with the link from the account |
| `ERROR_post_stuck_publishing` | a post has been in `publishing` for over 30 minutes | check the account, then `resolve` |
| `ERROR_budget` | the run could not fit the planned posts in the subrequest limit (50 on the free plan) and took fewer | no action; lower `WEEKPOST_MAX_POSTS_PER_RUN` if it repeats |
| `ERROR_maintenance` | cleaning old media or looking for stuck posts failed | usually temporary; check the Supabase status if it repeats |
| `ERROR_run` | the whole run failed | read the `error` field; usually a wrong URL or key |

A post that fails but is still retried logs `post_failed` without the `ERROR` prefix. When it fails for good, `status --failed` lists it with the reason. The Worker does not notify you: until the metrics Action exists, run `status --failed` after publishing days.

## Limits

- **Worker subrequests:** one cron every 5 minutes. The free Cloudflare plan allows 5 crons per account and 50 subrequests per run. With the default of 2 posts per run, two carousels of 10 images fit (priced at 20 subrequests each in the worst case: 3 status checks and 2 attempts to record). The publisher counts the real calls before claiming, so when a token renewal takes part of the budget it claims fewer posts and the rest wait for the next run.
- **GitHub Actions minutes:** the check takes a few minutes. The preview runs again on every push while the `media-ok` label is on. The media cache keeps you from paying the media API twice, but a private repository spends minutes each time. Remove the label while you keep editing and add it back for the final preview.
- **Supabase storage:** media is deleted 7 days after publishing, so storage stays small.
- **Weekly media cap:** in the GitHub workflows `budget.weeklyUsd` is counted per pull request, not per week: each pull request starts a fresh cost record, so N pull requests for the same week can spend up to N times the cap.
