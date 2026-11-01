# Changelog

Every release of weekpost is listed here, newest first. Each one has two parts: **You need to do** (steps your project needs before or after you update) and **Improvements** (everything else). Versions are `0.x` until the contract settles; a migration in a `0.x` release only adds, so the previous Worker keeps running between the migration and the deploy.

How a release is cut: see [Releasing](docs/releasing.md).

## Unreleased

### You need to do

- Run migration `0005_metrics.sql` (`npx weekpost setup --apply --only=db.migrate`). It only adds a table, so the previous Worker keeps running.
- To use `weekpost metrics`, generate a NEW token in the Meta panel with the `instagram_business_manage_insights` permission added, then run `npx weekpost token <account>`. Tokens made before this release lack it. Publishing works without this step.
- Existing projects do not get the new agent rules, because `init` writes them only into new projects. Copy them from the template: the two `metrics --write` and `metrics --issue` lines of `.claude/settings.json`, and the `metrics` rules of `.codex/rules/weekpost.rules`.

### Improvements

- `weekpost upgrade --plan` (read-only) says what moving to the installed version would do: the lock against the installed version, uncommitted generated files, whether the config still loads, the check on every week (a lint error in a week whose posts have all gone out is only a warning), pending migrations, one line per file (`update`, `edited` with a unified diff, `new`, `removed`) and the setup steps still to do. It exits 1 when something blocks and takes `--json`. Applying the upgrade is not part of this release.
- `weekpost metrics` reads Instagram Insights and prints a weekly report with an Attention list; `--write` stores the numbers, `--issue` keeps one issue per week, `--json` prints the data. The two writing flags are blocked for Claude Code in the template, and Codex asks you before running any `metrics` command. Reading Insights needs the `instagram_business_manage_insights` permission (see "You need to do").
- `weekpost init` writes `weekpost.lock.json`: the weekpost version, the answers (no secrets) and a sha256 for each generated file. Commit it; a later upgrade uses it to tell the files you edited from the ones it can replace.
- New `weekpost_metrics` table (migration 0005) and queue-adapter reads for Instagram Insights.
- `weekpost --version` prints the installed version.
- Release script that stamps this file, sets the package version and builds the tarball.
- Codex support: `weekpost init` links `.agents/skills` to `skills/`, adds a "Skills" section to `AGENTS.md`, and writes `.codex/config.toml` and `.codex/rules/weekpost.rules` with the same limits as the Claude Code deny list, as far as Codex rules allow. See [docs/codex.md](docs/codex.md).
