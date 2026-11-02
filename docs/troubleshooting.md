# Troubleshooting

When `doctor`, `first-post` or `metrics` reports a problem. Back to the [README](../README.md) or the [setup guide](setup.md).

`doctor` prints the check id before each message; `first-post` prints an explanation when the Worker fails.

| You see | Likely cause | What to do |
|---|---|---|
| `node: ... needs 22 or newer` | old Node | install Node 22 or later |
| `chromium` fails | Playwright browser missing | `npx weekpost setup --apply --only=project.deps` |
| `logins` fails: not logged in | `gh` or `wrangler` has no session | `gh auth login` and `npx wrangler@4 login`, then `doctor` again (step 4 of [setup](setup.md#4-create-the-accounts)) |
| `openrouter`: key rejected | wrong or revoked key | create a new key, then `npx weekpost setup --apply --only=github.secrets` |
| `openrouter` warns: no credit limit | key without a cap | set a limit at openrouter.ai/settings/keys |
| `token.<account>.insights` warns, or `token` prints "cannot read Insights" | the token lacks `instagram_manage_insights` (Unified login) or `instagram_business_manage_insights` (older apps); posts still publish, only `weekpost metrics` is affected | Unified login: add `instagram_manage_insights` to the configuration (item 5 of [step 4](setup.md#4-create-the-accounts)) and generate the token again; older apps: generate it again with all three permissions. Then `npx weekpost token <account>` |
| `supabase.key`: publishable key | you copied the wrong key | copy the `sb_secret_...` key (step 4 of [setup](setup.md#4-create-the-accounts)), then `npx weekpost setup --apply --only=local.secrets` |
| `supabase.schema` fails | migrations not applied | `npx weekpost setup --apply --only=db.migrate` (or `--print` and paste the SQL) |
| `supabase.bucket` fails | bucket missing | `npx weekpost setup --apply --only=storage.bucket` |
| `worker.deployed` fails | not deployed, or not logged in to Cloudflare | `npx weekpost setup --apply --only=worker.deploy` |
| `secrets.worker`, `secrets.actions`, `secrets.environment` or `secrets.local` fail | a secret was not set | `npx weekpost setup --apply --only=<that check's step>`: `worker.secrets`, `github.secrets`, `github.environment`, `local.secrets` |
| `github.label` fails | a label (`media-ok` or `metrics`) is missing (or `origin` is not a GitHub repository) | push to GitHub, then `npx weekpost setup --apply --only=github.label` (safe to re-run; or: `gh label create metrics`) |
| `github.metrics-workflow` warns | the project predates `weekpost-metrics` | copy `.github/workflows/weekpost-metrics.yml` from the template, see [operate](operate.md#what-the-workflows-do) |
| `weekpost-metrics` run fails | environment `weekpost` lacks the Supabase secrets, or the run was not on `main` | check Settings > Environments, then `gh workflow run weekpost-metrics --ref main` |
| `github.workflows`: not pinned to a commit SHA | a workflow uses a tag | replace each tag with the full commit SHA of that release |
| Meta dashboard: no "API setup with Unified login" | the app is not connected to a business portfolio | connect it in the use case's Customize page (item 3 of [step 4](setup.md#4-create-the-accounts)) |
| Meta dashboard: your Instagram account is missing when you generate the token | it belongs to another business portfolio, or to none | add it to the portfolio the app uses (item 2 of [step 4](setup.md#4-create-the-accounts)) and pick that portfolio at login |
| Meta dashboard: the tester invitation stays "Pending" | the account has not accepted it | on Instagram: profile settings, Website permissions, Apps and websites, Tester invites; the account must be public |
| `(#10) ... account type is not business or creator` | a personal Instagram account | switch it to a professional account (step 1 of [setup](setup.md#1-before-you-start)) |
| `token`: "the database is at schema N, and a Unified login token needs schema 6" | the project was set up before migration 0006 | `npx weekpost setup --apply --only=db.migrate`, then `npx weekpost setup --apply --only=worker.deploy`, then `npx weekpost token <account>` again |
| `token`: "could not read the database schema version" | the Supabase URL or key is missing or wrong in this terminal | `npx weekpost doctor` (see `supabase.key` and `secrets.local`) |
| `token.<account>`: no token saved | step 6 not done | `npx weekpost token <account>` |
| `token.<account>`: Instagram did not accept the token | expired or revoked (a Unified login token also dies if the app or the account leaves the business portfolio) | generate a new token in the Meta dashboard, then `npx weekpost token <account>` |
| `token`: "token not accepted by Instagram Login nor Unified login" | the token is incomplete, expired or revoked, or it is not an Instagram token | copy it again from Generate access tokens (item 6 of [step 4](setup.md#4-create-the-accounts); Meta shows it once, so generate a new one if needed), then run `token` again |
| `token.<account>`: belongs to another handle | token from another account | generate the token while the right account is selected |
| `token`: "this Unified login token sees no Instagram account", or "this token sees @..., but account ... is @..." | when you generated the token, you picked a portfolio that does not own the account, or the account is not in the portfolio | add the account to the business portfolio (item 2 of [step 4](setup.md#4-create-the-accounts)), generate the token again picking that portfolio and account, then `npx weekpost token <account>` |
| `token.<account>`: cannot publish | missing `instagram_content_publish` (Unified login) or `instagram_business_content_publish` (older apps) | add it to the configuration (item 5 of [step 4](setup.md#4-create-the-accounts)) and generate the token again |
| `metrics`: Attention line "cannot read Insights" | the token lacks the Insights permission (publishing still works) | as for `token.<account>.insights` above |
| `token.<account>`: expires in N days (Instagram Login) | renewal not happening | check the Worker (`worker.deployed`) and the logs ([Reading the Worker logs](operate.md#reading-the-worker-logs)) |
| `token.<account>`: generated with a 60-day expiry (Unified login) | weekpost cannot renew a Unified login token | set the configuration's expiry to **Token will never expire** (item 5 of [step 4](setup.md#4-create-the-accounts)), generate the token again, then `npx weekpost token <account>` and answer `never` |
| `graph.version` warns | the Graph API version weekpost uses is near its end | update weekpost |
| `first-post`: needs a terminal | run from an agent shell or a script | run it yourself in a terminal; `--yes` does not replace the terminal |
| `first-post`: no Instagram token | step 6 not done | `npx weekpost token <account>`, then `npx weekpost restore <post-id> --account=<account>` |
| `first-post`: Instagram refused the token, or the token cannot publish | expired, or wrong permissions | new token with the three permissions of item 5 of [step 4](setup.md#4-create-the-accounts), `npx weekpost token <account>` |
| `first-post`: Instagram rejected the image | not a professional account, or Meta-side problem | check the account type (step 1 of [setup](setup.md#1-before-you-start)) and try again |
| `first-post`: the Worker could not read the media or the database | Worker secrets wrong | `npx weekpost setup --apply --only=worker.secrets` |
| `first-post`: timed out, still scheduled | the Worker has not run | `npx weekpost doctor` (`worker.deployed`), `npx weekpost status`, and the Worker logs |
| `first-post`: canceled | post was canceled | `npx weekpost restore <post-id> --account=<account>` |
