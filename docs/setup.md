# Set it up

The guided setup, from an empty folder to a first public post. Back to the [README](../README.md).

This is the guided path. If your agent is Claude Code or Codex, you can ask it to run the `setup-guide` skill instead. A first-timer who follows it in order should finish in about three hours, most of it creating accounts. Every command below is a `weekpost` subcommand; `npx weekpost` alone prints the list of commands and their options.

### 1. Before you start

You need:

- Node 22 or later, and `git`.
- The [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`. The repository for your content must exist on GitHub and be your `origin` before step 5: `setup` creates the label, the secrets and the environment there.
- A professional (Business or Creator) Instagram account that you own or manage. A personal account cannot publish through the API.
- A public web page for a privacy policy (any URL you control; a one-page site or a repository page is enough). Meta asks for its address when you create the app (step 4).

What it costs to run (details in [What it could cost](../README.md#what-it-could-cost)):

| Item | Cost |
|---|---|
| Supabase (queue and media bucket) | free plan is enough |
| Cloudflare Workers (publisher, one cron every 5 minutes) | free plan is enough |
| Meta app and Instagram publishing | free |
| GitHub Actions | free minutes on a public repository; private repositories spend minutes |
| Images, narration and the image check (OpenRouter) | pay per use, about US$0.82 measured for the example week, capped per week (default US$5) |

Use an OpenRouter key with a credit limit. `weekpost doctor` warns when the key has none.

### 2. Install

weekpost ships as a tarball; the template that `init` copies is inside it. There is no release yet, so build the tarball from a clone of this repository first (this is the path that works today; a release will add a download URL):

```sh
git clone https://github.com/SchulzWill/weekpost.git
(cd weekpost/packages/weekpost && npm pack --pack-destination ..)   # writes weekpost/weekpost-<version>.tgz
```

`npx weekpost --version` prints the installed version, and [CHANGELOG.md](../CHANGELOG.md) lists what each release changes.

```sh
mkdir my-brand-social && cd my-brand-social
git init && npm init -y
npm i /path/to/weekpost/weekpost-<version>.tgz
npx playwright install chromium
```

The local secrets file is named after the folder and a short hash of its full path, like `~/.config/weekpost/my-brand-social-1a2b3c4d.env`, so two folders with the same name never share secrets. Installing downloads `ffmpeg-static`, about 44 MB.

### 3. Start the project

```sh
npx weekpost init
```

`init` asks for the brand name, each account (Instagram handle, language, time zone, hemisphere and the link base: the `https://` page that "link in bio" leads to), the pillars, the call to action and a contact for the privacy policy, then copies `weekpost.config.ts`, `assets/`, `content/`, `worker/`, `.github/`, `AGENTS.md`, `BRIEF.md`, `PRIVACY.md` and the agent skills, writes `weekpost.lock.json` (the version, your answers and a hash of each generated file; commit it), and runs `weekpost check`. It stops without writing anything if one of those paths already exists, and names it. Without a terminal, pass the answers as a file with `--answers=<file.json>` (format in [Manual setup](manual-setup.md), step 1; the link base is the account's `linkBase`, which must start with `https://`). Then:

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

Read-only. Prints `ok`, `warn` or `fail` for each check and, under each problem, the command that fixes it. Exit code 1 if anything fails. Run it again whenever something looks wrong; `--json` gives the same result for scripts. See [Troubleshooting](troubleshooting.md).

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

How the layers that keep the agent away from your keys work is in [Security](security.md). What each workflow does is in [What the workflows do](operate.md#what-the-workflows-do).

Something failed? [Troubleshooting](troubleshooting.md) has a table by error.
