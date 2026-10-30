# weekpost

Your app's weekly social media, as code.

An AI agent drafts the week in a pull request. You review the copy. weekpost generates the media (carousels, Stories, Reels with voice-over), you approve the exact preview, and a worker publishes it to Instagram on schedule. Metrics come back to the agent before it drafts the next week.

> **Status:** pre-alpha. Validation, media generation, previews, the CI workflows, the queue and the publishing Worker exist. The guided setup (`init`, `setup`, `token`, `doctor`, `first-post`) exists: see [Set it up](#set-it-up). The manual steps are kept in [Manual setup](#manual-setup). Metrics do not exist yet.

## How a week works

1. **Draft:** ask your agent to "open the week". It writes `content/<YYYY-Www>/posts.yaml` and opens a pull request.
2. **Review the copy:** the `check` job validates the schema and your brand-voice rules on every push.
3. **Preview:** add the `media-ok` label. weekpost generates every image, voice-over, carousel and Reel, and links a preview with the week's cost.
4. **Approve:** merge. The exact media from the preview is queued, never regenerated, and a comment on the pull request says how many posts were scheduled, which were skipped, and which queued posts were canceled because they are no longer in the merged YAML (the merged YAML is the source of truth: a post you removed or moved to another date does not publish). If a post you removed comes back in a later merge, the enqueue brings it back too, with the content of the merge that brought it. A post you canceled yourself with `weekpost cancel` is different: it stays canceled, and the comment lists it, until you run `weekpost restore`. A post whose publish time has already passed is not queued (it would go out at once): the run does not fail, the comment lists the post, and the rest of the week is queued. Move the post to a future date, or run the enqueue workflow manually with the `allow_past` input (or `weekpost enqueue --allow-past`) to queue it anyway. Stories are exempt. If a run fails halfway, run it again: it converges.
5. **Publish:** your worker publishes each post at its scheduled time, without double-posting, retrying on failure.
6. **Learn (not built yet):** a weekly issue will collect the metrics, and the agent will read it before drafting the next week.

## What you need

- Node 22 or later.
- ffmpeg: installed with the package through `ffmpeg-static`, nothing to do.
- Chromium for Playwright (renders the slides): `npx playwright install chromium`.
- An [OpenRouter](https://openrouter.ai) API key in `OPENROUTER_API_KEY` for images, narration and the image check. `--fake-media` needs none.

To publish you also need a [Supabase](https://supabase.com) project (the queue and the private media bucket), a [Cloudflare](https://www.cloudflare.com) account (the Worker, free plan is enough) and a professional Instagram account with a long-lived token. See [Set it up](#set-it-up).

## What exists and what does not

| Step | Status |
|---|---|
| Validate content, brand-voice lint (`check`) | available |
| Generate media and the preview page (`generate`, `--fake-media`) | available |
| CI: check on every pull request, preview on a label, enqueue on merge | available as templates in `packages/weekpost/template/.github/` |
| Queue and operation without SQL (`enqueue`, `status`, `cancel`, `reschedule`, `resolve`, `package`) | available |
| Worker that publishes feed posts and Reels on schedule | available as a template in `packages/weekpost/template/worker/` |
| Stories | queued as `manual`: weekpost never publishes them, `package` gives you the files to post by hand |
| `weekpost init` (copy the template, fill in the config) | available |
| `weekpost token` | available |
| `weekpost setup --plan` (read-only list of the setup steps and what is already done) | available |
| `weekpost setup --apply` for the database and the bucket (`db.migrate`, `storage.bucket`; `--print` shows the SQL instead) | available |
| `weekpost setup --apply` for the Worker deploy and secrets, the GitHub label, secret and environment, and the local secrets file | available |
| `weekpost doctor` (read-only check of the keys, schema, bucket, Worker, secrets and tokens, with the command to fix each failure) | available |
| Weekly metrics issue | coming next |

## Set it up

Prefer a guided setup? Ask your agent to run the `setup-guide` skill.

This is the guided path. A first-timer who follows it in order should finish in about three hours, most of it creating accounts. Every command below is a `weekpost` subcommand; `npx weekpost` alone prints the list of commands and their options.

### 1. Before you start

You need:

- Node 22 or later, and `git`.
- The [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`. The repository for your content must exist on GitHub and be your `origin` before step 5: `setup` creates the label, the secrets and the environment there.
- A professional (Business or Creator) Instagram account that you own or manage. A personal account cannot publish through the API.
- A public web page for a privacy policy (any URL you control; a one-page site or a repository page is enough). Meta asks for its address when you create the app (step 4).

What it costs to run, by the numbers in this README:

| Item | Cost |
|---|---|
| Supabase (queue and media bucket) | free plan is enough |
| Cloudflare Workers (publisher, one cron every 5 minutes) | free plan is enough |
| Meta app and Instagram publishing | free |
| GitHub Actions | free minutes on a public repository; private repositories spend minutes, see [Cost of running it](#cost-of-running-it) |
| Images, narration and the image check (OpenRouter) | pay per use, about US$0.43 for the example week, capped per week (default US$5), see [What a week costs](#what-a-week-costs) |

Use an OpenRouter key with a credit limit. `weekpost doctor` warns when the key has none.

### 2. Install

weekpost ships as a tarball attached to each release; the template that `init` copies is inside it. `npx weekpost --version` prints the installed version, and [CHANGELOG.md](CHANGELOG.md) lists what each release changes. Until the first release is published, build the tarball yourself with `npm pack` in `packages/weekpost` of this repository.

```sh
mkdir my-brand-social && cd my-brand-social
git init && npm init -y
npm i <tarball URL from the latest release>
npx playwright install chromium
```

The local secrets file is named after the folder and a short hash of its full path, like `~/.config/weekpost/my-brand-social-1a2b3c4d.env`, so two folders with the same name never share secrets. A file written under the old name (`my-brand-social.env`) is copied to the new one the first time `setup --apply` or a command that reads it runs, with a warning. Installing downloads `ffmpeg-static`, about 44 MB.

### 3. Start the project

```sh
npx weekpost init
```

`init` asks for the brand name, each account (Instagram handle, language, time zone, hemisphere and the link base: the `https://` page that "link in bio" leads to), the pillars, the call to action and a contact for the privacy policy, then copies `weekpost.config.ts`, `assets/`, `content/`, `worker/`, `.github/`, `AGENTS.md`, `BRIEF.md`, `PRIVACY.md` and the agent skills, writes `weekpost.lock.json` (the version, your answers and a hash of each generated file; commit it), and runs `weekpost check`. It stops without writing anything if one of those paths already exists, and names it. Without a terminal, pass the answers as a file with `--answers=<file.json>` (format in [Manual setup](#manual-setup), step 1; the link base is the account's `linkBase`, which must start with `https://`). Then:

- Add the font and logo files that `weekpost.config.ts` names under `assets/`.
- Fill in `BRIEF.md` with your voice. The agent reads it before every draft.
- Commit, create the GitHub repository and push to `main`.

The config holds no secret.

### 4. Create the accounts

You create three accounts. Keep each value at hand; step 5 asks for them at hidden prompts and never accepts them as command arguments. Dashboards change their labels from time to time: if a name below is not on your screen, look for the closest one.

**Supabase** ([supabase.com](https://supabase.com))

1. Create a project (free plan). Save the database password when it is shown.
2. Project settings, API keys: create a **secret key** (`sb_secret_...`). The publishable key (`sb_publishable_...`) does not work; `doctor` says so.
3. Note the project URL (`https://<ref>.supabase.co`).
4. Click "Connect" at the top of the dashboard and copy the Postgres connection string, with your database password filled in. `setup` uses it once to create the tables and never saves it. If your network cannot reach the database directly, `setup --apply --only=db.migrate --print` prints the SQL for you to paste in the SQL editor instead.

**Cloudflare** ([cloudflare.com](https://www.cloudflare.com))

1. Create a free account. Nothing else to configure in the dashboard: `setup` deploys the Worker with `wrangler`.
2. Run `npx wrangler@4 login` and approve in the browser.

**Meta app with Instagram Login** ([developers.facebook.com](https://developers.facebook.com))

1. Log in with a Facebook account and register as a developer if asked.
2. My Apps, Create app. Pick the use case that manages content and messaging on Instagram (it uses "Instagram API with Instagram Login"), and give the app a name of your own.
3. In the app's basic settings, set the **Privacy Policy URL**. Meta requires a public URL, not a file. `init` wrote a generic one-page policy to `PRIVACY.md` with your brand name filled in: read it, change it to match what you do (fill in `<CONTACT>` if `init` did not have one), publish it on any public web page (your site, a GitHub Pages page) and paste that address here.
4. In the Instagram product, open "API setup with Instagram login". Add your Instagram professional account to the app (an Instagram tester role): accept the invitation in the Instagram app, under the website permissions of the account's settings.
5. In the same panel, generate the token for that account with the permissions `instagram_business_basic` and `instagram_business_content_publish`. Copy it and keep it for step 6. It is long-lived (about 60 days); the Worker renews it.
6. Leave the app in development mode. You do not need App Review or Business Verification to publish on your own account.

What Meta requires of you (checked against Meta's pages on 30 October 2026; read the originals, [Platform Terms](https://developers.facebook.com/terms/) and [Developer Policies](https://developers.facebook.com/devpolicy/)):

- **Your app, your account.** Each person creates their own Meta app and is its developer. Use it only on professional accounts you own or manage. Meta's own table lists "my app is only for a business I own or manage" as needing Standard Access only. Do not use one app for clients or third parties, do not host weekpost for other people, and do not create a new app to get around a block.
- **A privacy policy** on a public URL, registered in the app. The Platform Terms ask for one from every developer.
- **50 posts per 24 hours.** The API docs say 50 (one page also says 100); weekpost plans with 50. A carousel counts as one post.
- **Label AI content.** Meta requires its disclosure label on photorealistic video or realistic synthetic audio. weekpost cannot set that label through the API: add it in the Instagram app after publishing, or avoid that kind of audio.
- **Development mode is not a promise.** Meta's documentation describes development mode as meant for development, and says content generated in it, such as test posts, can be seen only by people with a role on the app. Nothing in the Terms forbids using it on your own account, and Meta's App Review table says Standard Access is enough for that, but check with `first-post` that the post is public for you. Meta can change these rules at any time (it shut down an Instagram API about three months after announcing it), so expect to revisit this.
- **Limits.** Up to 50 testers per app, 15 apps per person (archived apps count), and a tester account must be public.

### 5. Plan and apply

```sh
npx weekpost setup --plan
```

Read-only. It lists every step and whether it is already done: logins, Chromium, the database schema, the media bucket, the Worker deploy and its secrets, the GitHub label, the Actions secret, the `weekpost` environment, the local secrets file and one token per account.

```sh
npx weekpost setup --apply
```

At a terminal, it asks before each step. It will prompt, hidden, for the Supabase URL and secret key, the OpenRouter key and the connection string. `--only=<step-id>` runs one step (ids are in the `--plan` output), and there is no `--yes`. Run it again after a failure: each step checks first and continues where it stopped. The Instagram token is yours, in the next step.

### 6. Save the token

```sh
npx weekpost token <account>
```

`<account>` is the account id from `weekpost.config.ts` (for example `en`). Copy the token from the Meta panel and run the command: it reads the clipboard, or use `--prompt` to paste it at a hidden prompt. It checks with Instagram that the token belongs to the handle in the config and can publish, saves it in your database, and clears the clipboard. It needs a terminal. Do one account at a time.

### 7. Check everything

```sh
npx weekpost doctor
```

Read-only. Prints `ok`, `warn` or `fail` for each check and, under each problem, the command that fixes it. Exit code 1 if anything fails. Run it again whenever something looks wrong; `--json` gives the same result for scripts. See [Troubleshooting](#troubleshooting).

### 8. Publish a first post

```sh
npx weekpost first-post <account>
```

This publishes a **public** card with your brand name and handle on the real account, through your own Worker, to prove the whole path. It asks for a caption (or `--caption=<text>`) and asks you to confirm the handle (`--yes` skips the question; the command always needs a terminal). It then waits for the permalink: the Worker runs every 5 minutes, so allow up to 15 (`--timeout=<minutes>`). Delete the post in Instagram afterwards if you do not want to keep it. Running it again the same day does not queue a second post; it only keeps watching.

### 9. Your first week with the agent

1. Start your agent from a shell without infrastructure keys: `npx weekpost agent-env` must exit 0. Claude Code is the one tested.
2. Ask it to "open the week". It writes `content/<YYYY-Www>/posts.yaml` from `BRIEF.md` and opens a pull request.
3. Read the copy. The `check` job runs on the pull request.
4. Add the `media-ok` label yourself (the agent cannot). The preview workflow generates the media with OpenRouter and links a preview with its cost. Open it with `npx weekpost preview <pr-number>`.
5. Merge. The approved media goes to the queue, and a comment says what was scheduled.
6. Watch with `npx weekpost status`. After publishing days run `npx weekpost status --failed`: the Worker does not notify you.

How the layers that keep the agent away from your keys work is in [Security](#security). What each workflow does is in [What the workflows do](#what-the-workflows-do).

### Troubleshooting

`doctor` prints the check id before each message; `first-post` prints an explanation when the Worker fails.

| You see | Likely cause | What to do |
|---|---|---|
| `node: ... needs 22 or newer` | old Node | install Node 22 or later |
| `chromium` fails | Playwright browser missing | `npx weekpost setup --apply --only=project.deps` |
| `logins` fails: not logged in | `gh` or `wrangler` has no session | `gh auth login` and `npx wrangler@4 login`, then `doctor` again (step 4) |
| `openrouter`: key rejected | wrong or revoked key | create a new key, then `npx weekpost setup --apply --only=github.secrets` |
| `openrouter` warns: no credit limit | key without a cap | set a limit at openrouter.ai/settings/keys |
| `supabase.key`: publishable key | you copied the wrong key | copy the `sb_secret_...` key (step 4), then `npx weekpost setup --apply --only=local.secrets` |
| `supabase.schema` fails | migrations not applied | `npx weekpost setup --apply --only=db.migrate` (or `--print` and paste the SQL) |
| `supabase.bucket` fails | bucket missing | `npx weekpost setup --apply --only=storage.bucket` |
| `worker.deployed` fails | not deployed, or not logged in to Cloudflare | `npx weekpost setup --apply --only=worker.deploy` |
| `secrets.worker`, `secrets.actions`, `secrets.environment` or `secrets.local` fail | a secret was not set | `npx weekpost setup --apply --only=<that check's step>`: `worker.secrets`, `github.secrets`, `github.environment`, `local.secrets` |
| `github.label` fails | label missing (or `origin` is not a GitHub repository) | push to GitHub, then `npx weekpost setup --apply --only=github.label` |
| `github.workflows`: not pinned to a commit SHA | a workflow uses a tag | replace each tag with the full commit SHA of that release |
| `token.<account>`: no token saved | step 6 not done | `npx weekpost token <account>` |
| `token.<account>`: Instagram did not accept the token | expired or revoked | generate a new token in the Meta panel, then `npx weekpost token <account>` |
| `token.<account>`: belongs to another handle | token from another account | generate the token while the right account is selected |
| `token.<account>`: cannot publish | missing `instagram_business_content_publish` | generate it again with both permissions (step 4.5) |
| `token.<account>`: expires in N days | renewal not happening | check the Worker (`worker.deployed`) and the logs ([Reading the Worker logs](#reading-the-worker-logs)) |
| `graph.version` warns | the Graph API version weekpost uses is near its end | update weekpost |
| `first-post`: needs a terminal | run from an agent shell or a script | run it yourself in a terminal; `--yes` does not replace the terminal |
| `first-post`: no Instagram token | step 6 not done | `npx weekpost token <account>`, then `npx weekpost restore <post-id> --account=<account>` |
| `first-post`: Instagram refused the token, or the token cannot publish | expired, or wrong permissions | new token with both permissions, `npx weekpost token <account>` |
| `first-post`: Instagram rejected the image | not a professional account, or Meta-side problem | check the account type (step 1) and try again |
| `first-post`: the Worker could not read the media or the database | Worker secrets wrong | `npx weekpost setup --apply --only=worker.secrets` |
| `first-post`: timed out, still scheduled | the Worker has not run | `npx weekpost doctor` (`worker.deployed`), `npx weekpost status`, and the Worker logs |
| `first-post`: canceled | post was canceled | `npx weekpost restore <post-id> --account=<account>` |

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

`first-post` checks that your Worker really publishes. After `token`, run `npx weekpost first-post en --caption="Hello"` in a terminal (`--yes` skips the confirmation but never the terminal): it confirms the account handle, renders a plain card with your brand name (no paid API), queues it for about a minute ahead and watches the queue for up to 15 minutes (`--timeout=<minutes>`; the Worker's cron runs every 5 minutes), then prints the permalink. **The post is public on the real account**, so the caption is yours and required (without `--caption` it asks). If it fails, it translates the Worker's error and points to the README step to fix. Repeating the command the same day never queues a second post: it finds the existing row and keeps watching it. Delete the post on Instagram when you are done; weekpost does not delete media.

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

## Security

`weekpost init` writes the files that let an agent (Claude Code is the one tested) open the week and read the queue: `AGENTS.md` (the rules), `BRIEF.md` (your voice, you fill it in), `skills/open-week`, `skills/queue-status` and `skills/setup-guide`, with `.claude/skills` (Claude Code) and `.agents/skills` (Codex) linked to `skills/` (a copy where links are not available). For Codex it also writes `.codex/config.toml` and `.codex/rules/weekpost.rules` (see [Using other agents (Codex)](#using-other-agents-codex)).

What the agent is told to do: read `content/`, run `sources pull`, `check` and `status`, write `content/<week>/`, and open the pull request. What it is told not to do: add the preview label (your approval), merge, or change the queue. Topics, news and issue text are treated as data, never as instructions, because that is where a prompt injection would come from.

### What the barriers are, and what they are not

Four barriers reduce accidents and keep a cooperative agent in line. They are not a security boundary. An agent under prompt injection that runs as your system user can get around every one of them.

1. `weekpost agent-env` exits 1 if the shell holds infrastructure keys (`WEEKPOST_SUPABASE_*`, `CLOUDFLARE_*`, `DATABASE_URL`) or if the local secrets file `~/.config/weekpost/<folder>-<hash>.env` exists and your user can read it. The second case is the normal one after `setup`, so `agent-env` fails on your own machine unless the agent runs in a sandbox or as another system user.
2. Commands that write outside the repository (`token`, `first-post`, `setup --apply`) need a terminal, and the other writing commands read the local secrets file only with one. The terminal check proves there is a terminal, not that a human is at it: `script` gives a program a terminal and can feed it the answers, so this check prevents accidents, nothing more.
3. `.claude/settings.json` denies, among others, `setup --apply`, `token`, `first-post`, `enqueue`, queue commands with `--yes`, `wrangler`, `gh secret`, `gh pr merge`, `gh pr edit --add-label`, `gh api`, `gh workflow run` and reading `~/.config/weekpost/`. Claude Code documents Bash patterns as fragile: they match the command text as written, not every way to run the same program (`sh -c '...'`, a wrapper, a script that calls it).
4. The agent's instructions say what is data and what is not. An injected instruction can still convince a model to ignore them.

To check that these limits hold against the real agent, run `npm run eval:agent -w weekpost` (needs the `claude` CLI; it calls the model and spends your plan, so it is not part of `npm test` or any CI). It runs the open-week, prompt-injection and cancel scenarios three times each in a throwaway project with a fake `npx`/`weekpost`/`gh`, and passes only if every run passes.

### Using other agents (Codex)

`AGENTS.md` is the file the OpenAI Codex CLI reads, so the rules and the process are the same. `weekpost init` also writes what Codex needs to find the skills and to keep to the same limits. Sources: [AGENTS.md](https://developers.openai.com/codex/guides/agents-md), [skills](https://developers.openai.com/codex/skills), [rules](https://developers.openai.com/codex/rules), [config](https://developers.openai.com/codex/config-basic) and [sandbox and approvals](https://developers.openai.com/codex/sandbox) (the Codex docs; checked October 2026, and the rules feature is marked experimental there).

1. Run `npx weekpost init`, then start `codex` in the project directory.
2. When Codex asks whether to trust the project, trust it. Codex loads the project `.codex/` layer (config and rules) only for a trusted project; in an untrusted one it ignores both and only `AGENTS.md` applies.
3. Check with `/status` that the approval policy is `on-request` and the sandbox is `workspace-write`. Start from a shell without infrastructure keys, as for any agent: `npx weekpost agent-env` must exit 0.
4. Say "open the week". `AGENTS.md` tells Codex to follow `skills/open-week/SKILL.md`. You can also type `$open-week` or use `/skills`.
5. A command that needs the network (`git push`, `gh`, `weekpost sources pull`) stops and asks you, because the sandbox has no network. Approve it after reading it.

What `init` writes for Codex:

- `AGENTS.md` has a "Skills" section naming each skill file, so discovery does not depend on anything else.
- `.agents/skills` is a link to `skills/`, the folder Codex scans for skills. (Whether Codex follows a link there is not documented; the "Skills" section covers it.)
- `.codex/config.toml` sets `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"` and `network_access = false`.
- `.codex/rules/weekpost.rules` has `prefix_rule` entries. `forbidden` blocks `setup --apply`, `token`, `first-post`, `enqueue`, `wrangler`, `gh secret`, `gh pr merge`, `gh pr ready`, `gh api`, `gh workflow run` and `gh label`. `prompt` asks you first for the other `setup` forms, `cancel`, `restore`, `reschedule`, `resolve` (the `--yes` forms) and `gh pr edit` / `gh pr create` (which could add the preview label).

If you would rather not trust the project config, put the same keys in `~/.codex/config.toml` and copy the rules file to `~/.codex/rules/weekpost.rules`. Check one command with `codex execpolicy check --pretty --rules .codex/rules/weekpost.rules -- npx weekpost token en`.

| | Claude Code | Codex |
|---|---|---|
| Instructions | `AGENTS.md` (through `CLAUDE.md`) | `AGENTS.md`, read from the root down to the working directory |
| Finding the skills | `.claude/skills` link, automatic | `.agents/skills` link, plus the "Skills" section of `AGENTS.md` |
| Blocking commands | `deny` list in `.claude/settings.json`, pattern match on the command text | `forbidden` and `prompt` rules in `.codex/rules/weekpost.rules`, prefix match on the command words; experimental |
| Pattern limits | A pattern like `*weekpost*--yes*` can match anywhere in the command | Rules match only the start of the command, so `--yes` cannot be matched in the middle: those commands ask for approval instead of being blocked |
| Wrappers (`sh -c`, scripts) | Can slip through | Split only for plain `&&`, `\|\|`, `;`, `\|` chains; anything with redirects, substitutions or variables is checked as one command |
| Reading `~/.config/weekpost/` | `Read(...)` is denied | No read deny in the docs (not documented). `agent-env` refuses to run while that file is readable; for real isolation, use another system user or a container |
| Sandbox | Optional, see below | `workspace-write`, no network, `.git`, `.codex` and `.agents` read-only |
| `agent-env` and the prompt-injection rules | Same | Same |
| Behavior eval (`npm run eval:agent`) | Runs on the `claude` CLI | Not available: it drives Claude Code only. Run the first week by hand and read what the agent did |

The same warning as in [Security](#security) applies: these barriers reduce accidents and are not a security boundary.

### What actually isolates the agent

Run the agent in a sandbox (the Claude Code sandbox, a container or a VM), or as another system user that cannot read `~/.config/weekpost/` or the Cloudflare login in `~/.wrangler/`, with network access limited to what it needs. Give it a fine-grained GitHub token for the repository with only `Contents` and `Pull requests` write access, not your `gh auth` login. That token stops the agent from touching secrets, workflows and settings. It does not stop it from adding a label or merging a pull request, because both fall under `Pull requests` (labels) and `Contents` (merge). Windows is not covered.

### Human approval is a convention

The preview label and the merge are your approval, and nothing but the agent's obedience and the deny list above holds them back. The workflow cannot tell who added the label. If your GitHub plan allows it, protect `main` with a required review (branch protection or a ruleset) so a merge needs someone other than the agent's identity. Private repositories on the free plan cannot; there, review every pull request yourself before you add the label.

## Cost of running it

- **Media:** see the next section; paid per use through OpenRouter, capped per week.
- **Worker:** one cron every 5 minutes. The free plan allows 5 crons per account and 50 subrequests per run; with the default of 2 posts per run, two carousels of 10 images fit (priced at 20 subrequests each in the worst case: 3 status checks and 2 attempts to record). The publisher counts the real calls before claiming, so when a token renewal takes part of the budget it claims fewer posts and the rest wait for the next run.
- **GitHub Actions minutes:** the check is a few minutes. The preview runs again on every push while the label is on; the media cache avoids paying the media API twice, but a private repository spends minutes each time. Remove the label while you keep editing, add it back for the final preview.
- **Supabase:** media is deleted 7 days after publishing, so storage stays small.

## What a week costs

Media is paid per use through OpenRouter. The numbers below are the estimates weekpost uses when the API does not report a cost; the real figure is written to `out/<week>/costs.jsonl` and to the manifest as `spentUsd`.

| Item | Estimate | When |
|---|---|---|
| Image, `seedream-4.5` (default) | US$0.04 | one per slide, Reel segment or Story image |
| Image, `gpt-image-2` | US$0.005 | same, when a post sets `image_model` |
| Image check (vision judge) | US$0.02 | one per generated image |
| Narration | US$0.00008 | per character of the Reel narration, per account |

Identical prompts and inputs are served from the cache, so re-running a week costs nothing. A weekly cap stops the run when it is reached (`budget.weeklyUsd`, default US$5). In the GitHub workflows the cap is counted per pull request, not per week: each pull request starts a fresh cost record, so N pull requests for the same week can spend up to N times the cap.

Example week (`examples/horta-viva`): 1 carousel with 3 slides, 1 Story and 1 Reel with 3 segments, so 7 images.

```
7 images x US$0.04               = US$0.28
7 image checks x US$0.02         = US$0.14
87 narration characters x 0.00008 = US$0.007
                                   ---------
                                   about US$0.43   (about US$0.18 with gpt-image-2)
```

## Try it

```sh
git clone <this repository>
cd weekpost
npm install
npx playwright install chromium
npx weekpost check 2026-W45 --project=examples/horta-viva
npx weekpost generate 2026-W45 --project=examples/horta-viva --fake-media
```

`--fake-media` replaces images, narration and the image check with local placeholders: no key, no cost. Open `examples/horta-viva/out/2026-W45/index.html` for the preview, and `manifest.json` next to it for the list of files and their SHA-256 hashes. Drop `--fake-media` and set `OPENROUTER_API_KEY` to generate real media.

## Repo layout

```
packages/weekpost/   the CLI and the library (config, content, lint, media, render)
examples/horta-viva/ a fictional brand with a full week to try
examples/plugins/    an example brand-voice lint plugin
packages/weekpost/template/   starting point `weekpost init` copies (config, worker, GitHub workflows)
```

## Principles

- **Content as code:** the week lives in your repo, and the pull request is where the approval happens.
- **What you approve is what ships:** the published media is byte-for-byte the media in the approved preview.
- **Bring your own keys:** your repo, your Meta app, your database, your worker. Nothing is hosted for you.
- **Your brand, your rules:** accounts, languages, voices and brand-voice lint rules are configuration and plugins.
- **Any agent:** directives live in `AGENTS.md` and `skills/`. Tested with Claude Code; Codex is set up but less proven ([details](#using-other-agents-codex)).

## Manual setup

This is the same setup as [Set it up](#set-it-up), done by hand. `npx weekpost setup --apply` does these steps for you: the schema (a connection string typed at a hidden prompt, or `--print` to get the SQL and paste it in the SQL editor yourself), the bucket, the Worker deploy and secrets, the GitHub label, secret and environment, and `~/.config/weekpost/<folder>-<hash>.env` (mode 0600). Every secret goes in on stdin or at a hidden prompt, never as an argument. Use `--only=<step-id>` for one step. The Instagram token is still yours: see step 4 below. Nothing in this repository deploys, writes a secret or creates an account unless you run `--apply` and say yes.

1. **Project.** Install the package from a release tarball (`npm i <url of the weekpost-x.y.z.tgz asset on the release>`; the template ships inside it), then run `npx weekpost init` in your repository. It asks for the brand name, each account (handle, language, time zone, hemisphere), the pillars and the call to action, then copies `weekpost.config.ts`, `assets/`, `content/`, `worker/` and `.github/` and runs `weekpost check`. It stops without writing anything if one of those paths already exists, and names it. Without a terminal (an agent shell, a script), pass the answers as a file: `npx weekpost init --answers=answers.json`.

   ```json
   {
     "brandName": "My App",
     "accounts": [{ "handle": "myapp", "lang": "en", "timeZone": "Europe/London", "hemisphere": "north" }],
     "pillars": ["tip", "story"],
     "cta": ["link in bio"],
     "previewLabel": "media-ok",
     "contact": "privacy@myapp.example"
   }
   ```

   Each account may also set `id`, `voice` and `linkBase` (an `https://` URL); `previewLabel` is optional and is also written into the preview workflow; `contact` (e-mail or URL) goes into `PRIVACY.md`, and without it `<CONTACT>` stays there for you to fill in. The file holds no secret. Then add the font and logo files the config names under `assets/` and run `npx playwright install chromium`. Installing weekpost downloads `ffmpeg-static`, about 44 MB.
2. **Supabase.** In the SQL editor of your project, run `packages/weekpost/migrations/0001_queue.sql`, `0002_media_hash.sql`, `0003_stale_runs.sql` and `0004_operator_functions.sql` (from this repository), once each, in order. Run `0004` before you deploy the matching version of weekpost: `cancel` and `reschedule` call the functions it adds. It creates three tables with the prefix `weekpost_` (`weekpost_posts`, `weekpost_tokens`, `weekpost_schema`), the functions the Worker calls, and the grants for the server-side role. Create a **secret key** (`sb_secret_...`) in the API keys page.
3. **Media bucket.** The first real `enqueue` creates a private bucket named `weekpost-media` (50 MiB per file, JPEG and MP4 only). To use another name, set `WEEKPOST_BUCKET` in the workflow and in the Worker. You can also create the bucket yourself in the dashboard, private.
4. **Instagram token.** The Worker reads the token from the table, not from a secret, because a renewal returns a new token. Seed one row per account, using the same id as in `weekpost.config.ts` (here `en`) and the numeric id of the Instagram professional account:

   ```sql
   insert into public.weekpost_tokens (account, ig_user_id, access_token, expires_at)
   values ('en', '<numeric account id>', '<long-lived token>', now() + interval '60 days');
   ```

   Run it in the SQL editor and never commit the token. The Worker renews it when fewer than 30 days are left and logs `ERROR_token_expiring` when fewer than 7 are left.
5. **Worker.** In `worker/`, set the two secrets and deploy it yourself:

   ```sh
   cd worker
   npx wrangler secret put WEEKPOST_SUPABASE_URL
   npx wrangler secret put WEEKPOST_SUPABASE_KEY
   npx wrangler deploy
   ```

   It has one cron (every 5 minutes) and no HTTP route. For a smoke test with a short-lived token, set `WEEKPOST_REFRESH_TOKENS = "false"` in `wrangler.toml`. The other variables are listed there.
6. **GitHub Actions.** In the repository settings:
   - Create the label `media-ok` (it must match `ci.previewLabel` in `weekpost.config.ts` and the label in `weekpost-preview.yml`).
   - Add the secret `OPENROUTER_API_KEY` (use a key with a spending limit). Only the preview uses it.
   - Create an environment named `weekpost`, restrict its deployment branches to `main`, and add the secrets `WEEKPOST_SUPABASE_URL` and `WEEKPOST_SUPABASE_KEY` to it. Only the enqueue step uses them.
   - Optional: a hosted preview on Cloudflare Pages for reviewing from a phone. Set the variable `WEEKPOST_PREVIEW_PAGES=true` and the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and put Cloudflare Access in front of the project: the preview holds unpublished posts.

## Releasing

For the maintainer. A release is a version in `packages/weekpost/package.json`, a section in [CHANGELOG.md](CHANGELOG.md) and a tarball made by `npm pack`. The script does the local part and publishes nothing.

1. While you work, add each change under `## Unreleased` in `CHANGELOG.md`, in one of two parts: **You need to do** (a step a project must take before or after updating, such as a migration or a new secret) or **Improvements** (everything else). Both headings must be there; write `(none)` under the one you do not use.
2. From a clean `main`, run `npm run release -- 0.2.0` (`--dry-run` only checks; `--tag` also creates the local tag `v0.2.0`). Versions are `0.x.y` and cannot go down. It renames `Unreleased` to the version and date, opens a new empty `Unreleased`, sets the version in `package.json` and `package-lock.json`, runs `npm run verify`, and writes `dist/weekpost-0.2.0.tgz` and `dist/release-notes-0.2.0.md`.
3. It then prints the commands to run yourself: commit, tag, push, and `gh release create v0.2.0 dist/weekpost-0.2.0.tgz --notes-file dist/release-notes-0.2.0.md`. Projects install the tarball from that release page.

A migration in a `0.x` release only adds (tables, columns, functions), so the previous Worker keeps working between the migration and the deploy. One that removes something waits for a major version and is called out under **You need to do**.

## License

[MIT](LICENSE)
