# Manual setup

This is the same setup as [Set it up](setup.md), done by hand. `npx weekpost setup --apply` does these steps for you: the schema (a connection string typed at a hidden prompt, or `--print` to get the SQL and paste it in the SQL editor yourself), the bucket, the Worker deploy and secrets, the GitHub label, secret and environment, and `~/.config/weekpost/<folder>-<hash>.env` (mode 0600). Every secret goes in on stdin or at a hidden prompt, never as an argument. Use `--only=<step-id>` for one step. The Instagram token is still yours: see step 4 below. Nothing in this repository deploys, writes a secret or creates an account unless you run `--apply` and say yes.

1. **Project.** Install the package from a release tarball (`npm i <url of the weekpost-x.y.z.tgz asset on the release>`; the template ships inside it), then run `npx weekpost init` in your repository. It asks for the brand name, each account (handle, language, time zone, hemisphere), the pillars and the call to action, then copies `weekpost.config.ts`, `assets/`, `content/`, `worker/` and `.github/` and runs `weekpost check`. It stops without writing anything if one of those paths already exists, and names it. Without a terminal (an agent shell, a script), pass the answers as a file: `npx weekpost init --answers=answers.json`.

   ```json
   {
     "brandName": "My App",
     "accounts": [{ "handle": "myapp", "lang": "en", "timeZone": "Europe/London", "hemisphere": "north" }],
     "pillars": ["tip", "story"],
     "cta": ["link in bio"],
     "previewLabel": "media-ok",
     "contact": "privacy@myapp.example"
   }
   ```

   Each account may also set `id`, `voice` and `linkBase` (an `https://` URL); `previewLabel` is optional and is also written into the preview workflow; `contact` (e-mail or URL) goes into `PRIVACY.md`, and without it `<CONTACT>` stays there for you to fill in. The file holds no secret. Then add the font and logo files the config names under `assets/` and run `npx playwright install chromium`. Installing weekpost downloads `ffmpeg-static`, about 44 MB.
2. **Supabase.** In the SQL editor of your project, run `packages/weekpost/migrations/0001_queue.sql`, `0002_media_hash.sql`, `0003_stale_runs.sql`, `0004_operator_functions.sql` and `0005_metrics.sql` (from this repository), once each, in order. Run `0004` before you deploy the matching version of weekpost: `cancel` and `reschedule` call the functions it adds. `0005` adds the table the Instagram metrics are stored in. Together they create four tables with the prefix `weekpost_` (`weekpost_posts`, `weekpost_tokens`, `weekpost_schema`, `weekpost_metrics`), the functions the Worker calls, and the grants for the server-side role. Create a **secret key** (`sb_secret_...`) in the API keys page.
3. **Media bucket.** The first real `enqueue` creates a private bucket named `weekpost-media` (50 MiB per file, JPEG and MP4 only). To use another name, set `WEEKPOST_BUCKET` in the workflow and in the Worker. You can also create the bucket yourself in the dashboard, private.
4. **Instagram token.** The Worker reads the token from the table, not from a secret, because a renewal returns a new token. Seed one row per account, using the same id as in `weekpost.config.ts` (here `en`) and the numeric id of the Instagram professional account:

   ```sql
   insert into public.weekpost_tokens (account, ig_user_id, access_token, expires_at)
   values ('en', '<numeric account id>', '<long-lived token>', now() + interval '60 days');
   ```

   Run it in the SQL editor and never commit the token. The Worker renews it when fewer than 30 days are left and logs `ERROR_token_expiring` when fewer than 7 are left.
5. **Worker.** In `worker/`, set the two secrets and deploy it yourself:

   ```sh
   cd worker
   npx wrangler secret put WEEKPOST_SUPABASE_URL
   npx wrangler secret put WEEKPOST_SUPABASE_KEY
   npx wrangler deploy
   ```

   It has one cron (every 5 minutes) and no HTTP route. For a smoke test with a short-lived token, set `WEEKPOST_REFRESH_TOKENS = "false"` in `wrangler.toml`. The other variables are listed there.
6. **GitHub Actions.** In the repository settings:
   - Create the label `media-ok` (it must match `ci.previewLabel` in `weekpost.config.ts` and the label in `weekpost-preview.yml`).
   - Add the secret `OPENROUTER_API_KEY` (use a key with a spending limit). Only the preview uses it.
   - Create an environment named `weekpost`, restrict its deployment branches to `main`, and add the secrets `WEEKPOST_SUPABASE_URL` and `WEEKPOST_SUPABASE_KEY` to it. Only the enqueue step uses them.
   - Optional: a hosted preview on Cloudflare Pages for reviewing from a phone. Set the variable `WEEKPOST_PREVIEW_PAGES=true` and the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and put Cloudflare Access in front of the project: the preview holds unpublished posts.
