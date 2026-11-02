-- weekpost queue, step 6: the login mode of each token.
--
-- `login` says which Instagram API the token belongs to: 'instagram' (Instagram API with Instagram Login, host
-- graph.instagram.com, the only mode before this migration) or 'unified' (Instagram API with Unified login, host
-- graph.facebook.com). Existing rows keep 'instagram' through the default. A token of the unified mode can be created
-- without an expiry, so `expires_at` may now be null.
--
-- Run it once, after 0005_metrics.sql, and before you deploy the matching version of weekpost: that version reads
-- `login`. Expand only: the Worker of the previous version keeps working on rows written before this migration.

begin;

alter table public.weekpost_tokens
  add column login text not null default 'instagram' check (login in ('instagram', 'unified')),
  alter column expires_at drop not null;

update public.weekpost_schema set version = 6;

commit;
