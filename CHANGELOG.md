# Changelog

Every release of weekpost is listed here, newest first. Each one has two parts: **You need to do** (steps your project needs before or after you update) and **Improvements** (everything else). Versions are `0.x` until the contract settles; a migration in a `0.x` release only adds, so the previous Worker keeps running between the migration and the deploy.

How a release is cut: see [Releasing](README.md#releasing).

## Unreleased

### You need to do

(none yet)

### Improvements

- `weekpost init` writes `weekpost.lock.json`: the weekpost version and a sha256 for each generated file. Commit it; a later upgrade uses it to tell the files you edited from the ones it can replace.
- `weekpost --version` prints the installed version.
- Release script that stamps this file, sets the package version and builds the tarball.
