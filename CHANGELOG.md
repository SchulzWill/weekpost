# Changelog

Every release of weekpost is listed here, newest first. Each one has two parts: **You need to do** (steps your project needs before or after you update) and **Improvements** (everything else). Versions are `0.x` until the contract settles; a migration in a `0.x` release only adds, so the previous Worker keeps running between the migration and the deploy.

How a release is cut: see [Releasing](docs/releasing.md).

## Unreleased

### You need to do

(none yet)

### Improvements

- `weekpost init` writes `weekpost.lock.json`: the weekpost version, the answers (no secrets) and a sha256 for each generated file. Commit it; a later upgrade uses it to tell the files you edited from the ones it can replace.
- `weekpost --version` prints the installed version.
- Release script that stamps this file, sets the package version and builds the tarball.
- Codex support: `weekpost init` links `.agents/skills` to `skills/`, adds a "Skills" section to `AGENTS.md`, and writes `.codex/config.toml` and `.codex/rules/weekpost.rules` with the same limits as the Claude Code deny list, as far as Codex rules allow. See [docs/codex.md](docs/codex.md).
