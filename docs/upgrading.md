# Upgrading a project

How to move a project you already set up to a newer weekpost. It usually takes a few minutes; longer if you edited generated files. Run step 3 yourself in a terminal.

Before you start, read the "You need to do" part of every release between your version and the new one in the [CHANGELOG](../CHANGELOG.md).

0. **Start clean.** The project must be a git repository, with your changes to generated files (workflows, `worker/`, skills, agent settings) committed or stashed; `--plan` blocks otherwise.
1. **Install the new version.** `npm i -D weekpost@latest`. Then run `npx weekpost doctor`: it warns if `gh` cannot push workflow changes.
2. **Read the plan.** `npx weekpost upgrade --plan` lists what would change and writes nothing: no file, no database, no GitHub. It exits 1 if something blocks the upgrade (it says what). Your agent can run this one.
3. **Apply it, yourself.** `npx weekpost upgrade --apply`. It needs a terminal; there is no `--yes`. It asks before the database migrations, before replacing or deleting a file you edited, and before the Worker deploy. Files you never edited and the lock are written without asking. A coding agent has no terminal, and the command refuses to run without one, so only you run it. The template's agent permissions also deny it, but only from this version on: a project set up earlier gets that rule from this upgrade (unless you keep your own edited `.claude/settings.json` or `.codex/rules/weekpost.rules`; then copy the `upgrade --apply` rules from the template).
4. **Review.** `git status` and `git diff` show every file it changed. The Worker deploy at the end of `--apply` goes live before this review. To review first, answer no to the deploy, review and merge, then run `npx weekpost setup --apply --only=worker.deploy`.
5. **Handle `*.weekpost-new*` files** (see below), then commit and open a pull request.

## What `--apply` does

It goes in this order. If a step fails, the later ones do not run, and running `--apply` again continues from where it stopped.

| Step | What it touches | Can you undo it? |
|---|---|---|
| 1. Database | When migrations are pending, it asks for your Postgres connection string (Supabase dashboard, "Connect"; see [setup](setup.md), step 4). It is used once and never saved. So far every migration only adds (a table, a column, or a relaxed constraint), so your data stays; the CHANGELOG says so for each release. | **No.** A migration cannot be rolled back. If one fails, it is rolled back and the ones before it stay applied. |
| 2. Files | Writes the files weekpost generated (the workflows, `worker/`, the agent skills and settings, `AGENTS.md`, `CLAUDE.md`), adds new ones, and asks before deleting one the new version no longer has. It asks before replacing a file you edited. Your `content/`, config, `BRIEF.md`, `PRIVACY.md` and `assets/` are never touched. | Yes, with git: `git checkout -- <file>`. |
| 3. Lock | Updates `weekpost.lock.json`, which records the version and the files. | Yes, with git. |
| 4. Worker | Offers to deploy `worker/` to your live Worker, using what is on disk now (not yet committed). Scheduled posts use it from the next run. | The deploy is live. To go back, restore the previous `worker/` (`git checkout HEAD -- worker/` before you commit, or `git checkout <previous-commit> -- worker/` after) and run `npx weekpost setup --apply --only=worker.deploy`. |

Because the database goes first, a failure there leaves your files exactly as they were.

### Files you edited

For a generated file you changed that the new version also changes, `--apply` shows the difference and asks:

- **keep** (the default): your version stays.
- **take**: the new version replaces yours. Commit first if you want a way back.
- **side**: your version stays and the new one is written next to it as `<file>.weekpost-new` (or `-2`, `-3`... if that name is taken). Merge what you want into your file, then delete the `*.weekpost-new*` file. Do not commit it. New projects ignore these files in git; a project set up earlier does not, so `git add -A` would commit them.

### Pasting the SQL into Supabase

If you would rather not give weekpost your connection string, run `npx weekpost upgrade --apply --print`. When migrations are pending, it prints only those and stops without changing anything. Paste the SQL into the Supabase SQL editor, then run `npx weekpost upgrade --apply` again (without `--print`) for the files and the Worker. If no migration is pending, there is nothing to print and the run goes on to the files.

To know which migrations are pending, `--print` needs the Supabase URL and secret key saved on this machine (`npx weekpost setup --apply --only=local.secrets`). Without them it stops and prints nothing.

### If you decline the Worker deploy

The files and the lock are updated, but the Worker still runs the old version. weekpost records this in the lock: `upgrade --apply` offers the deploy again until it is done, and you can run `npx weekpost setup --apply --only=worker.deploy` yourself. Deploy before the next scheduled post.

## Permissions

`gh` needs the `workflow` scope to push changes to `.github/workflows/`, which an upgrade does. `npx weekpost doctor` warns if it is missing; fix it with `gh auth refresh -s workflow`.
