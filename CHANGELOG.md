# Changelog

Every release of weekpost is listed here, newest first. Each one has two parts: **You need to do** (steps your project needs before or after you update) and **Improvements** (everything else). Versions are `0.x` until the contract settles; a migration in a `0.x` release only adds, so the previous Worker keeps running between the migration and the deploy.

How a release is cut: see [Releasing](README.md#releasing).

## Unreleased

### You need to do

- Run migration `0005_metrics.sql` (`npx weekpost setup --apply --only=db.migrate`). It only adds a table, so the previous Worker keeps running.

### Improvements

- `weekpost init` writes `weekpost.lock.json`: the weekpost version, the answers (no secrets) and a sha256 for each generated file. Commit it; a later upgrade uses it to tell the files you edited from the ones it can replace.
- New `weekpost_metrics` table (migration 0005) and queue-adapter reads for Instagram Insights.
- `weekpost --version` prints the installed version.
- Release script that stamps this file, sets the package version and builds the tarball.
