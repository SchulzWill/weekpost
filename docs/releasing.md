# Releasing

For the maintainer. A release is a version in `packages/weekpost/package.json`, a section in [CHANGELOG.md](../CHANGELOG.md) and a tarball made by `npm pack`. The script does the local part and publishes nothing.

1. While you work, add each change under `## Unreleased` in `CHANGELOG.md`, in one of two parts: **You need to do** (a step a project must take before or after updating, such as a migration or a new secret) or **Improvements** (everything else). Both headings must be there; write `(none)` under the one you do not use.
2. From a clean `main`, run `npm run release -- 0.2.0` (`--dry-run` only checks; `--tag` also creates the local tag `v0.2.0`). Versions are `0.x.y` and cannot go down. It renames `Unreleased` to the version and date, opens a new empty `Unreleased`, sets the version in `package.json` and `package-lock.json`, runs `npm run verify`, and writes `dist/weekpost-0.2.0.tgz` and `dist/release-notes-0.2.0.md`.
3. It then prints the commands to run yourself: commit, tag, push, and `gh release create v0.2.0 dist/weekpost-0.2.0.tgz --notes-file dist/release-notes-0.2.0.md`. Projects install the tarball from that release page.

A migration in a `0.x` release only adds (tables, columns, functions), so the previous Worker keeps working between the migration and the deploy. One that removes something waits for a major version and is called out under **You need to do**.
