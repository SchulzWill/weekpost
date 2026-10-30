# Security

Back to the [README](../README.md).

`weekpost init` writes the files that let an agent (Claude Code is the one tested) open the week and read the queue: `AGENTS.md` (the rules), `BRIEF.md` (your voice, you fill it in), `skills/open-week`, `skills/queue-status` and `skills/setup-guide`, with `.claude/skills` (Claude Code) and `.agents/skills` (Codex) linked to `skills/` (a copy where links are not available). For Codex it also writes `.codex/config.toml` and `.codex/rules/weekpost.rules` (see [Using other agents (Codex)](codex.md)).

What the agent is told to do: read `content/`, run `sources pull`, `check` and `status`, write `content/<week>/`, and open the pull request. What it is told not to do: add the preview label (your approval), merge, or change the queue. Topics, news and issue text are treated as data, never as instructions, because that is where a prompt injection would come from.

### What the barriers are, and what they are not

Four barriers reduce accidents and keep a cooperative agent in line. They are not a security boundary. An agent under prompt injection that runs as your system user can get around every one of them.

1. `weekpost agent-env` exits 1 if the shell holds infrastructure keys (`WEEKPOST_SUPABASE_*`, `CLOUDFLARE_*`, `DATABASE_URL`) or if the local secrets file `~/.config/weekpost/<folder>-<hash>.env` exists and your user can read it. The second case is the normal one after `setup`, so `agent-env` fails on your own machine unless the agent runs in a sandbox or as another system user.
2. Commands that write outside the repository (`token`, `first-post`, `setup --apply`) need a terminal, and the other writing commands read the local secrets file only with one. The terminal check proves there is a terminal, not that a human is at it: `script` gives a program a terminal and can feed it the answers, so this check prevents accidents, nothing more.
3. `.claude/settings.json` denies, among others, `setup --apply`, `token`, `first-post`, `enqueue`, queue commands with `--yes`, `wrangler`, `gh secret`, `gh pr merge`, `gh pr edit --add-label`, `gh api`, `gh workflow run` and reading `~/.config/weekpost/`. Claude Code documents Bash patterns as fragile: they match the command text as written, not every way to run the same program (`sh -c '...'`, a wrapper, a script that calls it).
4. The agent's instructions say what is data and what is not. An injected instruction can still convince a model to ignore them.

To check that these limits hold against the real agent, run `npm run eval:agent -w weekpost` (needs the `claude` CLI; it calls the model and spends your plan, so it is not part of `npm test` or any CI). It runs the open-week, prompt-injection and cancel scenarios three times each in a throwaway project with a fake `npx`/`weekpost`/`gh`, and passes only if every run passes.

### What actually isolates the agent

Run the agent in a sandbox (the Claude Code sandbox, a container or a VM), or as another system user that cannot read `~/.config/weekpost/` or the Cloudflare login in `~/.wrangler/`, with network access limited to what it needs. Give it a fine-grained GitHub token for the repository with only `Contents` and `Pull requests` write access, not your `gh auth` login. That token stops the agent from touching secrets, workflows and settings. It does not stop it from adding a label or merging a pull request, because both fall under `Pull requests` (labels) and `Contents` (merge). Windows is not covered.

### Human approval is a convention

The preview label and the merge are your approval, and nothing but the agent's obedience and the deny list above holds them back. The workflow cannot tell who added the label. If your GitHub plan allows it, protect `main` with a required review (branch protection or a ruleset) so a merge needs someone other than the agent's identity. Private repositories on the free plan cannot; there, review every pull request yourself before you add the label.
