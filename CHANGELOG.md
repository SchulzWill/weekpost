# Changelog

Every release of weekpost is listed here, newest first. Each one has two parts: **You need to do** (steps your project needs before or after you update) and **Improvements** (everything else). Versions are `0.x` until the contract settles; a migration in a `0.x` release only adds, so the previous Worker keeps running between the migration and the deploy.

How a release is cut: see [Releasing](docs/releasing.md).

## Unreleased

### You need to do

(none yet)

### Improvements

(none yet)

## 0.1.1 - 2026-11-13

### You need to do

(none yet)

### Improvements

- The npm package no longer ships test files and test fixtures, so it is smaller.
- The install docs and `weekpost init` now point to `npm i -D weekpost` instead of a release tarball.
- `bin` in `package.json` uses the form npm normalizes to (`bin/weekpost.js`).

## 0.1.0 - 2026-11-05

### You need to do

- Run migration `0005_metrics.sql` (`npx weekpost setup --apply --only=db.migrate`). It only adds a table, so the previous Worker keeps running.
- Run migration `0006_token_login.sql` too (same command, run it before you deploy this version: the Worker reads the new column). It adds a `login` column to `weekpost_tokens` (existing tokens stay `instagram`) and lets `expires_at` be empty, so the previous Worker keeps running.
- To use `weekpost metrics`, generate a NEW token in the Meta panel with the `instagram_business_manage_insights` permission added, then run `npx weekpost token <account>`. Tokens made before this release lack it. Publishing works without this step.
- Existing projects do not get the new agent rules, because `init` writes them only into new projects. Copy them from the template: the two `metrics --write` and `metrics --issue` lines of `.claude/settings.json`, and the `metrics` rules of `.codex/rules/weekpost.rules`.

### Improvements

- After installing a new weekpost, run `weekpost upgrade --plan` to see, without writing anything, which generated files change (with a diff for those you edited), what blocks the upgrade, and the pending migrations. Exits 1 when something blocks; `--json` is available. Applying the upgrade isn't available yet. A lint error in a week whose posts have all gone out is only a warning, but its `posts.yaml` must still pass the new schema (a schema error blocks even in a past week: add the missing field or delete the week).
- `weekpost metrics` reads Instagram Insights and prints a weekly report with an Attention list; `--write` stores the numbers, `--issue` keeps one issue per week, `--json` prints the data. The two writing flags are blocked for Claude Code in the template, and Codex asks you before running any `metrics` command. Reading Insights needs the `instagram_business_manage_insights` permission (see "You need to do").
- `weekpost init` writes `weekpost.lock.json`: the weekpost version, the answers (no secrets) and a sha256 for each generated file. Commit it; a later upgrade uses it to tell the files you edited from the ones it can replace.
- New `weekpost_metrics` table (migration 0005) and queue-adapter reads for Instagram Insights.
- Optional `metrics.extra` in `weekpost.config.ts`: an async function of yours (30 s, up to 10 rows, label up to 60 and value up to 120 characters) whose numbers join the weekly report; its secrets come from the optional `WEEKPOST_METRICS_EXTRA_ENV`, a dotenv secret in the `weekpost` environment or a shell variable. A failure or a row over the limits becomes an Attention line. Off by default; see docs/operate.md.
- The Instagram client can talk to either Meta host: `graph.instagram.com` (Instagram Login, the default for every existing token) or `graph.facebook.com` (Unified login). The queue stores the mode per token (migration 0006); a token without an expiry is never refreshed and never raises an expiry alert. Nothing changes for existing accounts.
- Tokens from Meta's "API setup with Unified login" (the only setup newer Meta apps offer) work alongside Instagram Login tokens, per account. `weekpost token` finds out which kind a token is (`--login=instagram|unified` to say it yourself), checks that it can see the configured account, asks how long it lasts ("never" by default) and saves the mode with it; it refuses a Unified login token until migration 0006 is applied. The Worker publishes each post through the API of its account's token and never tries to renew a Unified login token. `weekpost doctor` checks each token on its own API, shows a `token.<account>.login` line, reports a token without expiry as ok, and warns two weeks ahead about a Unified login token made with a 60-day expiry.
- `weekpost metrics` reads each account through the API of its token: Unified login accounts on `graph.facebook.com`, without `profile_views` and `website_clicks` (Meta does not list them for that API, and one unknown metric would fail the whole account request). A token without an expiry gets no expiry line in the report, and the "cannot read Insights" fix names the right Meta setup and permission for each kind of token.
- The setup guide (`docs/setup.md` step 4, the `setup-guide` skill and the troubleshooting table) now walks through "API setup with Unified login", the only setup new Meta apps offer: business portfolio, a configuration with `instagram_basic`, `instagram_content_publish` and `instagram_manage_insights`, a token that never expires, and the Instagram tester invite. The Instagram login steps stay as a short note for older apps.
- `weekpost --version` prints the installed version.
- Release script that stamps this file, sets the package version and builds the tarball.
- Codex support: `weekpost init` links `.agents/skills` to `skills/`, adds a "Skills" section to `AGENTS.md`, and writes `.codex/config.toml` and `.codex/rules/weekpost.rules` with the same limits as the Claude Code deny list, as far as Codex rules allow. See [docs/codex.md](docs/codex.md).
