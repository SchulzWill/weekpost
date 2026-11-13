# Upgrading a project

How to move a project you already set up to a newer weekpost. Plan about ten minutes, and run step 3 yourself in a terminal.

1. **Install the new version.** `npm i -D weekpost@latest`
2. **Read the plan.** `npx weekpost upgrade --plan` lists what would change and writes nothing: no file, no database, no GitHub. It exits 1 if something blocks the upgrade (it says what). Your agent can run this one.
3. **Apply it, yourself.** `npx weekpost upgrade --apply`. It needs a terminal and asks before each step; there is no `--yes`. A coding agent has no terminal and its permissions deny the command, so only you run it.
4. **Review.** `git status` and `git diff` show every file it changed.
5. **Handle `*.weekpost-new*` files** (see below), then commit and open a pull request.

Read the [CHANGELOG](../CHANGELOG.md) first: each release lists what your project needs to do.

## What `--apply` does

It goes in this order. If a step fails, the later ones do not run, and running `--apply` again continues from where it stopped.

| Step | What it touches | Can you undo it? |
|---|---|---|
| 1. Database | Runs the migrations that are pending in your Supabase project. It asks for your Postgres connection string. | **No.** A migration cannot be rolled back. In a `0.x` release a migration only adds, so your data stays. If one fails, it is rolled back and the ones before it stay applied. |
| 2. Files | Rewrites the files weekpost generated (the workflows, the Worker, the agent skills). It asks about each file you edited. Your `content/`, config, `BRIEF.md`, `PRIVACY.md` and `assets/` are never touched. | Yes, with git: `git checkout -- <file>`. |
| 3. Lock | Updates `weekpost.lock.json`, which records the version and the files. | Yes, with git. |
| 4. Worker | Offers to deploy `worker/` to your live Worker, using what is on disk now (not yet committed). Scheduled posts use it from the next run. | The deploy is live. To go back, redeploy the previous commit. |

Because the database goes first, a failure there leaves your files exactly as they were.

### Files you edited

For a generated file you changed that the new version also changes, `--apply` shows the difference and asks:

- **keep** (the default): your version stays.
- **take**: the new version replaces yours. Commit first if you want a way back.
- **side**: your version stays and the new one is written next to it as `<file>.weekpost-new` (or `-2`, `-3`... if that name is taken). Merge what you want into your file, then delete the `*.weekpost-new*` file. Do not commit it.

### Pasting the SQL into Supabase

If you would rather not give weekpost your connection string, run `npx weekpost upgrade --apply --print`. It prints the migration SQL and stops, changing nothing else. Paste it into the Supabase SQL editor, then run `npx weekpost upgrade --apply` again (without `--print`) for the files and the Worker.

### If you decline the Worker deploy

The files and the lock are updated, but the Worker still runs the old version. weekpost records this in the lock: `upgrade --apply` offers the deploy again until it is done, and you can run `npx weekpost setup --apply --only=worker.deploy` yourself. Deploy before the next scheduled post.

## Permissions

`gh` needs the `workflow` scope to push changes to `.github/workflows/`, which an upgrade does. `npx weekpost doctor` warns if it is missing; fix it with `gh auth refresh -s workflow`.
