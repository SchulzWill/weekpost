# Using other agents (Codex)

Back to the [README](../README.md).

`AGENTS.md` is the file the OpenAI Codex CLI reads, so the rules and the process are the same. `weekpost init` also writes what Codex needs to find the skills and to keep to the same limits. Sources: [AGENTS.md](https://developers.openai.com/codex/guides/agents-md), [skills](https://developers.openai.com/codex/skills), [rules](https://developers.openai.com/codex/rules), [config](https://developers.openai.com/codex/config-basic) and [sandbox and approvals](https://developers.openai.com/codex/sandbox) (the Codex docs; checked October 2026, and the rules feature is marked experimental there).

1. Run `npx weekpost init`, then start `codex` in the project directory.
2. When Codex asks whether to trust the project, trust it. Codex loads the project `.codex/` layer (config and rules) only for a trusted project; in an untrusted one it ignores both and only `AGENTS.md` applies.
3. Check with `/status` that the approval policy is `on-request` and the sandbox is `workspace-write`. Start from a shell without infrastructure keys, as for any agent: `npx weekpost agent-env` must exit 0.
4. Say "open the week". `AGENTS.md` tells Codex to follow `skills/open-week/SKILL.md`. You can also type `$open-week` or use `/skills`.
5. A command that needs the network (`git push`, `gh`, `weekpost sources pull`) stops and asks you, because the sandbox has no network. Approve it after reading it.

What `init` writes for Codex:

- `AGENTS.md` has a "Skills" section naming each skill file, so discovery does not depend on anything else.
- `.agents/skills` is a link to `skills/`, the folder Codex scans for skills. (Whether Codex follows a link there is not documented; the "Skills" section covers it.)
- `.codex/config.toml` sets `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"` and `network_access = false`.
- `.codex/rules/weekpost.rules` has `prefix_rule` entries. `forbidden` blocks `setup --apply`, `token`, `first-post`, `enqueue`, `wrangler`, `gh secret`, `gh pr merge`, `gh pr ready`, `gh api`, `gh workflow run` and `gh label`. `prompt` asks you first for the other `setup` forms, `cancel`, `restore`, `reschedule`, `resolve` (the `--yes` forms), `metrics` (because of `--write` and `--issue`) and `gh pr edit` / `gh pr create` (which could add the preview label).

If you would rather not trust the project config, put the same keys in `~/.codex/config.toml` and copy the rules file to `~/.codex/rules/weekpost.rules`. Check one command with `codex execpolicy check --pretty --rules .codex/rules/weekpost.rules -- npx weekpost token en`.

| | Claude Code | Codex |
|---|---|---|
| Instructions | `AGENTS.md` (through `CLAUDE.md`) | `AGENTS.md`, read from the root down to the working directory |
| Finding the skills | `.claude/skills` link, automatic | `.agents/skills` link, plus the "Skills" section of `AGENTS.md` |
| Blocking commands | `deny` list in `.claude/settings.json`, pattern match on the command text | `forbidden` and `prompt` rules in `.codex/rules/weekpost.rules`, prefix match on the command words; experimental |
| Pattern limits | A pattern like `*weekpost*--yes*` can match anywhere in the command | Rules match only the start of the command, so `--yes` cannot be matched in the middle: those commands ask for approval instead of being blocked |
| Wrappers (`sh -c`, scripts) | Can slip through | Split only for plain `&&`, `\|\|`, `;`, `\|` chains; anything with redirects, substitutions or variables is checked as one command |
| Reading `~/.config/weekpost/` | `Read(...)` is denied | No read deny in the docs (not documented). `agent-env` refuses to run while that file is readable; for real isolation, use another system user or a container |
| Sandbox | Optional, see below | `workspace-write`, no network, `.git`, `.codex` and `.agents` read-only |
| `agent-env` and the prompt-injection rules | Same | Same |
| Behavior eval (`npm run eval:agent`) | Runs on the `claude` CLI | Not available: it drives Claude Code only. Run the first week by hand and read what the agent did |

The same warning as in [Security](security.md) applies: these barriers reduce accidents and are not a security boundary.

