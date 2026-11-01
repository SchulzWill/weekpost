---
name: setup-guide
description: Guides a person through installing weekpost, account by account, until the first post is live. Use when asked to "set up", "install", "configure weekpost", "doctor failed", "what is left to set up", or in Portuguese "instalar", "configurar", "o doctor falhou", "o que falta configurar".
---

# Set up weekpost, guided

You walk a person through the setup. The accounts are theirs and the secrets never pass through you: you read the state, say the next step, print the exact command, and wait for them to run it in their own terminal. Aim for 1 to 1.5 hours; nearly all of it is creating accounts, and the Meta app is the slow one.

Read-only commands are yours: `npx weekpost doctor --json` and `npx weekpost setup --plan --json`. Their output holds no secret. Everything that writes is the person's: `setup --apply`, `token`, `first-post`, `wrangler`, `gh auth login`.

## The loop

1. Run `npx weekpost doctor --json` and `npx weekpost setup --plan --json`.
2. Take the first item that is not `ok` (`doctor`: `level` is `fail` before `warn`; `setup --plan`: `state` is `todo`, `needs-you` or `unknown`). Say in one or two sentences what it is and why.
3. If an account or a file is missing, give the account step below. Otherwise give the command in `fix` (doctor) or `commands`/`guide` (plan).
4. Print the exact command for the person to run in their terminal, and stop. Wait for them to say it is done.
5. Run `doctor` again and show what changed: which ids went from fail to ok, and what is next. Go back to step 2.

Never make the person type or paste a key, token, password or connection string into this chat. Never ask for one, and if one appears, tell them to rotate it. The values go into the hidden prompts of `setup --apply` and `token`. You do not read `~/.config/weekpost/`.

If `doctor` shows `warn` because this shell has no keys (for example `openrouter`), that is expected here: tell the person to run `npx weekpost doctor` in their own terminal for the full picture.

## Do the slow account first

Before anything else, tell the person to start the Meta app (step "Meta app" below): the Instagram tester invitation and the app panel take the longest. They can create the Supabase and Cloudflare accounts while it loads. Dashboards rename things; if a label is not on their screen, ask them to look for the closest one.

## Accounts and what to copy

Direct links open the dashboard home or the official docs. Do not describe deeper clicks from memory; use the docs link.

**GitHub** ([github.com/new](https://github.com/new), [gh auth login](https://cli.github.com/manual/gh_auth_login))
- The content repository must exist on GitHub and be `origin`. The person runs `gh auth login`.
- Fixes `logins`, `github.label`, `secrets.actions`, `secrets.environment`.

**Supabase** ([dashboard](https://supabase.com/dashboard), [API keys](https://supabase.com/docs/guides/api/api-keys), [connection string](https://supabase.com/docs/guides/database/connecting-to-postgres))
- Create a project on the free plan and save the database password.
- Copy three things for the hidden prompts of `setup --apply`: the project URL, the **secret** key (`sb_secret_...`; the publishable key fails `supabase.key`) and the Postgres connection string with the password filled in.
- If the network cannot reach the database: `npx weekpost setup --apply --only=db.migrate --print` prints the SQL for the SQL editor.

**Cloudflare** ([dashboard](https://dash.cloudflare.com), [wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/))
- Create a free account. Nothing to configure in the dashboard. The person runs `npx wrangler@4 login` and approves in the browser.

**OpenRouter** ([keys](https://openrouter.ai/settings/keys))
- Create a key with a credit limit. It goes in the hidden prompt of `setup --apply --only=github.secrets`.

**Meta app with Instagram Login** ([apps](https://developers.facebook.com/apps), [docs](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login))
- Needs a professional (Business or Creator) Instagram account they own, and a public page for a privacy policy.
- Create an app whose use case manages content on Instagram ("Instagram API with Instagram Login"), set the Privacy Policy URL, add the Instagram account as a tester and accept the invitation in the Instagram app.
- Generate the token for that account with `instagram_business_basic`, `instagram_business_content_publish` and `instagram_business_manage_insights` (the last is only for `weekpost metrics`), and copy it. Leave the app in development mode.
- Then the person runs `npx weekpost token <account>` (the account id from `weekpost.config.ts`), one account at a time. It reads the clipboard; `--prompt` uses a hidden prompt.

The weekpost repository (https://github.com/SchulzWill/weekpost) has the full steps in `docs/setup.md` and the error table in `docs/troubleshooting.md`.

## Order of the commands

The plan lists the order. The usual one: `npx playwright install chromium`, then `npx weekpost setup --apply` (asks before each step; `--only=<step-id>` runs one), then `npx weekpost token <account>`, then `npx weekpost first-post <account>`.

## When `doctor` fails: id to fix

The `fix` field of each failing check already holds the command. Use this table to explain it and to know what the person must do first.

| Check id | Cause | The person runs |
|---|---|---|
| `config` | `weekpost.config.ts` does not parse | fix the file, then `npx weekpost check` |
| `node` | Node older than 22 | install Node 22 or later |
| `chromium` | Playwright browser missing | `npx weekpost setup --apply --only=project.deps` |
| `logins` | `gh` or `wrangler` has no session | `gh auth login`, `npx wrangler@4 login` |
| `openrouter` | key rejected, or no credit limit | new key with a limit, then `npx weekpost setup --apply --only=github.secrets` |
| `supabase.key` | publishable key, or none found | copy the `sb_secret_...` key, then `npx weekpost setup --apply --only=local.secrets` |
| `supabase.schema` | migrations not applied | `npx weekpost setup --apply --only=db.migrate` |
| `supabase.bucket` | bucket missing | `npx weekpost setup --apply --only=storage.bucket` |
| `worker.deployed` | not deployed, or no Cloudflare login | `npx weekpost setup --apply --only=worker.deploy` |
| `secrets.worker` | Worker secrets not set | `npx weekpost setup --apply --only=worker.secrets` |
| `secrets.actions` | Actions secret not set | `npx weekpost setup --apply --only=github.secrets` |
| `secrets.environment` | `weekpost` environment or its secrets missing | `npx weekpost setup --apply --only=github.environment` |
| `secrets.local` | local secrets file missing | `npx weekpost setup --apply --only=local.secrets` |
| `github.label` | label missing, or `origin` is not on GitHub | push to GitHub, then `npx weekpost setup --apply --only=github.label` |
| `github.workflows` | an action is pinned to a tag, not a commit SHA | replace each tag with the full commit SHA |
| `token.<account>` | no token, rejected, wrong handle, cannot publish, or expiring | new token with all three permissions, then `npx weekpost token <account>` |
| `graph.version` | Graph API version near its end | update weekpost |

A `warn` is not a blocker: say what it means and go on.

## Finish

When `doctor` exits 0, tell the person to run in their terminal: `npx weekpost first-post <account>`. It publishes a public test post through their own Worker and waits for the link (allow up to 15 minutes, the Worker runs every 5). Ask them for the permalink it prints, confirm the post is public, and remind them they can delete it. Then point to the next skill: "open the week".

If `first-post` fails, match the message with the `first-post` rows of the table in `docs/troubleshooting.md` (weekpost repository).

## Never

- Ask for, accept or repeat a secret, or read `~/.config/weekpost/`.
- Run `setup --apply`, `token`, `first-post`, `enqueue`, `wrangler`, `gh secret`, or any command with `--yes`.
- Create an account for the person or click through a dashboard for them.
