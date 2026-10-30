-- weekpost queue: posts waiting to be published, Instagram tokens, and the schema version.
--
-- Plain Postgres. Anything that only exists on Supabase (roles, the storage schema) is either
-- guarded by a role check below or lives outside this file.
--
-- Rules:
-- * A worker only picks posts through weekpost_claim (for update skip locked), which moves
--   them to `publishing`. Only weekpost_mark_published / weekpost_mark_failed / weekpost_release
--   leave `publishing`.
-- * A post in `publishing` or `published` never changes content (trigger), so a later
--   merge cannot rewrite what already went out.
-- * Row level security is on, with no policy: only the table owner and roles granted below can read.

begin;

create table public.weekpost_schema (
  version int not null check (version > 0)
);
insert into public.weekpost_schema (version) values (1);

create table public.weekpost_posts (
  post_id text not null check (post_id ~ '^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$' and length(post_id) <= 120),
  account text not null check (account ~ '^[a-z][a-z0-9-]{0,15}$'),
  type text not null check (type in ('carousel', 'reel', 'story')),
  week text not null check (week ~ '^\d{4}-W\d{2}$'),
  publish_at timestamptz not null,
  caption text not null check (length(caption) <= 2200),
  -- Object paths in the media bucket, in publishing order: carousels 2..10 images,
  -- reels and stories one file (reels may have a cover).
  media jsonb not null check (
    jsonb_typeof(media) = 'array'
    and jsonb_array_length(media) between 1 and 10
    and (type <> 'carousel' or jsonb_array_length(media) >= 2)
  ),
  cover text,
  link text,
  content_hash text,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'publishing', 'published', 'failed', 'manual', 'canceled')),
  attempts int not null default 0 check (attempts between 0 and 10),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  container_id text,
  media_id text,
  permalink text,
  last_error text check (length(last_error) <= 2000),
  published_at timestamptz,
  media_purged_at timestamptz,
  -- Set by `weekpost reschedule`: a later enqueue keeps this row's publish_at.
  rescheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, account)
);

create index weekpost_posts_due on public.weekpost_posts (publish_at) where status = 'scheduled';
create index weekpost_posts_to_purge on public.weekpost_posts (published_at)
  where status = 'published' and media_purged_at is null;

create table public.weekpost_tokens (
  account text primary key check (account ~ '^[a-z][a-z0-9-]{0,15}$'),
  ig_user_id text not null check (ig_user_id ~ '^\d+$'),
  access_token text not null check (length(access_token) > 20),
  expires_at timestamptz not null,
  refreshed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.weekpost_schema enable row level security;
alter table public.weekpost_posts enable row level security;
alter table public.weekpost_tokens enable row level security;
revoke all on public.weekpost_schema, public.weekpost_posts, public.weekpost_tokens from public;

-- Content is frozen once claimed; updated_at always moves.
create function public.weekpost_posts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('publishing', 'published')
    and (new.type, new.week, new.publish_at, new.caption, new.media, new.cover, new.link)
      is distinct from (old.type, old.week, old.publish_at, old.caption, old.media, old.cover, old.link) then
    raise exception 'weekpost_posts %/%: content cannot change while status is %', old.post_id, old.account, old.status
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger weekpost_posts_guard before update on public.weekpost_posts
  for each row execute function public.weekpost_posts_guard();

-- Claims up to p_limit due posts (oldest publish_at first) and moves them to `publishing`.
create function public.weekpost_claim(p_limit int)
returns setof public.weekpost_posts
language sql
security invoker
set search_path = ''
as $$
  update public.weekpost_posts p
    set status = 'publishing', attempts = p.attempts + 1, claimed_at = now()
    from (
      select post_id, account from public.weekpost_posts
        where status = 'scheduled' and publish_at <= now()
          and (next_attempt_at is null or next_attempt_at <= now())
        order by publish_at
        limit greatest(least(p_limit, 50), 0)
        for update skip locked
    ) due
    where p.post_id = due.post_id and p.account = due.account
    returning p.*;
$$;

create function public.weekpost_mark_published(
  p_post_id text, p_account text, p_container_id text, p_media_id text, p_permalink text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.weekpost_posts
    set status = 'published', container_id = p_container_id, media_id = p_media_id, permalink = p_permalink,
        published_at = now(), last_error = null, next_attempt_at = null
    where post_id = p_post_id and account = p_account and status = 'publishing';
  if not found then
    raise exception 'weekpost_posts %/%: not in publishing', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

-- One failed attempt: back to the queue after p_retry_in, until the 3rd attempt; then `failed`.
create function public.weekpost_mark_failed(p_post_id text, p_account text, p_error text, p_retry_in interval)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  update public.weekpost_posts
    set status = case when attempts >= 3 then 'failed' else 'scheduled' end,
        next_attempt_at = case when attempts >= 3 then null else now() + p_retry_in end,
        last_error = left(p_error, 2000)
    where post_id = p_post_id and account = p_account and status = 'publishing'
    returning status into v_status;
  if not found then
    raise exception 'weekpost_posts %/%: not in publishing', p_post_id, p_account using errcode = 'no_data_found';
  end if;
  return v_status;
end;
$$;

-- Back to the queue without spending an attempt; keeps the container id so a reel the platform is
-- still processing resumes on the next run instead of creating a second container.
create function public.weekpost_release(p_post_id text, p_account text, p_container_id text, p_retry_in interval)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.weekpost_posts
    set status = 'scheduled', attempts = greatest(attempts - 1, 0),
        container_id = coalesce(p_container_id, container_id),
        next_attempt_at = now() + p_retry_in, last_error = null
    where post_id = p_post_id and account = p_account and status = 'publishing';
  if not found then
    raise exception 'weekpost_posts %/%: not in publishing', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.weekpost_claim(int) from public;
revoke all on function public.weekpost_mark_published(text, text, text, text, text) from public;
revoke all on function public.weekpost_mark_failed(text, text, text, interval) from public;
revoke all on function public.weekpost_release(text, text, text, interval) from public;

-- Supabase only: the service_role role does not exist in plain Postgres. The grant check runs
-- before row level security, even for service_role, so the grants are required there.
-- anon and authenticated get nothing.
do $$
begin
  if exists (select from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.weekpost_schema, public.weekpost_posts, public.weekpost_tokens to service_role;
    grant execute on function public.weekpost_claim(int) to service_role;
    grant execute on function public.weekpost_mark_published(text, text, text, text, text) to service_role;
    grant execute on function public.weekpost_mark_failed(text, text, text, interval) to service_role;
    grant execute on function public.weekpost_release(text, text, text, interval) to service_role;
  end if;
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on public.weekpost_schema, public.weekpost_posts, public.weekpost_tokens from anon;
    revoke all on function public.weekpost_claim(int), public.weekpost_mark_published(text, text, text, text, text),
      public.weekpost_mark_failed(text, text, text, interval), public.weekpost_release(text, text, text, interval) from anon;
  end if;
  if exists (select from pg_roles where rolname = 'authenticated') then
    revoke all on public.weekpost_schema, public.weekpost_posts, public.weekpost_tokens from authenticated;
    revoke all on function public.weekpost_claim(int), public.weekpost_mark_published(text, text, text, text, text),
      public.weekpost_mark_failed(text, text, text, interval), public.weekpost_release(text, text, text, interval) from authenticated;
  end if;
end
$$;

commit;
