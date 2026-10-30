-- weekpost queue, step 3: protection against stale enqueue runs.
--
-- Part 1 (source commit). Each row remembers the commit whose YAML last wrote it (`source_commit`) and the instant
-- of that commit. The enqueue only cancels or rewrites a row written by that same commit or one of its ancestors,
-- so a re-run of an old merge, or two runs finishing out of order, never undo what a newer merge queued. Null on
-- rows written before this migration: they count as older than everything.
--
-- Part 2 (status transitions). A row that is `publishing` or `published` can no longer change status except
-- through the publisher functions (weekpost_mark_published / mark_failed / release / resolve), which raise the
-- session flag `weekpost.transition` for the duration of their own update. Before, an upsert from the enqueue that
-- sent status = 'scheduled' for identical content moved a published post back to the queue, and a second claim
-- could publish a `publishing` one twice.
--
-- Part 3 (who canceled). `canceled_by` tells a post the enqueue canceled (it left the approved YAML) from one the
-- operator canceled (`weekpost cancel`). The enqueue brings back the first kind when the YAML has the post again;
-- the second stays canceled until `weekpost restore` (the function weekpost_restore below). Rows canceled before this
-- migration have no value and count as the operator's.
--
-- Run it once, after 0002_media_hash.sql. Plain Postgres. The table-level grants cover the new columns; the new
-- function gets its own grants at the end.

begin;

alter table public.weekpost_posts
  add column source_commit text check (source_commit is null or source_commit ~ '^[0-9a-f]{40}$'),
  add column source_committed_at timestamptz,
  add column canceled_by text check (canceled_by in ('enqueue', 'operator')),
  add constraint weekpost_posts_canceled_by_status check (canceled_by is null or status = 'canceled');

-- Same guard as 0002, plus: status cannot leave publishing/published (or an operator's cancel) outside the functions
-- below, and canceled_by follows the status.
create or replace function public.weekpost_posts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('publishing', 'published')
    and (new.type, new.week, new.publish_at, new.caption, new.media, new.cover, new.link, new.media_hash)
      is distinct from (old.type, old.week, old.publish_at, old.caption, old.media, old.cover, old.link, old.media_hash) then
    raise exception 'weekpost_posts %/%: content cannot change while status is %', old.post_id, old.account, old.status
      using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status
    and old.status in ('publishing', 'published')
    and coalesce(current_setting('weekpost.transition', true), '') <> 'on' then
    raise exception 'weekpost_posts %/%: status cannot change from % to % outside the publisher functions', old.post_id, old.account, old.status, new.status
      using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status then
    if old.status = 'canceled' and old.canceled_by is distinct from 'enqueue'
      and coalesce(current_setting('weekpost.transition', true), '') <> 'on' then
      raise exception 'weekpost_posts %/%: canceled by the operator; use weekpost restore', old.post_id, old.account
        using errcode = 'check_violation';
    end if;
    new.canceled_by := case when new.status = 'canceled' then coalesce(new.canceled_by, 'operator') end;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- The functions that leave `publishing` (bodies as in 0001, plus the session flag around their update).
create or replace function public.weekpost_mark_published(
  p_post_id text, p_account text, p_container_id text, p_media_id text, p_permalink text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  perform set_config('weekpost.transition', 'on', true);
  update public.weekpost_posts
    set status = 'published', container_id = p_container_id, media_id = p_media_id, permalink = p_permalink,
        published_at = now(), last_error = null, next_attempt_at = null
    where post_id = p_post_id and account = p_account and status = 'publishing';
  v_found := found; -- PERFORM below resets FOUND
  perform set_config('weekpost.transition', 'off', true);
  if not v_found then
    raise exception 'weekpost_posts %/%: not in publishing', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

create or replace function public.weekpost_mark_failed(p_post_id text, p_account text, p_error text, p_retry_in interval)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  perform set_config('weekpost.transition', 'on', true);
  update public.weekpost_posts
    set status = case when attempts >= 3 then 'failed' else 'scheduled' end,
        next_attempt_at = case when attempts >= 3 then null else now() + p_retry_in end,
        last_error = left(p_error, 2000)
    where post_id = p_post_id and account = p_account and status = 'publishing'
    returning status into v_status;
  perform set_config('weekpost.transition', 'off', true);
  if v_status is null then
    raise exception 'weekpost_posts %/%: not in publishing', p_post_id, p_account using errcode = 'no_data_found';
  end if;
  return v_status;
end;
$$;

create or replace function public.weekpost_release(p_post_id text, p_account text, p_container_id text, p_retry_in interval)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  perform set_config('weekpost.transition', 'on', true);
  update public.weekpost_posts
    set status = 'scheduled', attempts = greatest(attempts - 1, 0),
        container_id = coalesce(p_container_id, container_id),
        next_attempt_at = now() + p_retry_in, last_error = null
    where post_id = p_post_id and account = p_account and status = 'publishing';
  v_found := found;
  perform set_config('weekpost.transition', 'off', true);
  if not v_found then
    raise exception 'weekpost_posts %/%: not in publishing', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

-- `weekpost resolve`: settles a post stuck in publishing, as published (with its link) or back to the queue.
-- It was a plain PATCH from the CLI; the guard above now refuses that.
create function public.weekpost_resolve(p_post_id text, p_account text, p_published boolean, p_permalink text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  perform set_config('weekpost.transition', 'on', true);
  if p_published then
    update public.weekpost_posts
      set status = 'published', permalink = p_permalink, published_at = now(), last_error = null, next_attempt_at = null
      where post_id = p_post_id and account = p_account and status = 'publishing';
  else
    update public.weekpost_posts
      set status = 'scheduled', attempts = 0, next_attempt_at = null
      where post_id = p_post_id and account = p_account and status = 'publishing';
  end if;
  v_found := found;
  perform set_config('weekpost.transition', 'off', true);
  if not v_found then
    raise exception 'weekpost_posts %/%: not in publishing', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

-- `weekpost restore`: undoes a cancel. A Story goes back to `manual`, the others to `scheduled`, with a clean slate.
create function public.weekpost_restore(p_post_id text, p_account text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  perform set_config('weekpost.transition', 'on', true);
  update public.weekpost_posts
    set status = case when type = 'story' then 'manual' else 'scheduled' end,
        attempts = 0, next_attempt_at = null, last_error = null, container_id = null
    where post_id = p_post_id and account = p_account and status = 'canceled';
  v_found := found;
  perform set_config('weekpost.transition', 'off', true);
  if not v_found then
    raise exception 'weekpost_posts %/%: not canceled', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.weekpost_resolve(text, text, boolean, text) from public;
revoke all on function public.weekpost_restore(text, text) from public;

do $$
begin
  if exists (select from pg_roles where rolname = 'service_role') then
    grant execute on function public.weekpost_resolve(text, text, boolean, text) to service_role;
    grant execute on function public.weekpost_restore(text, text) to service_role;
  end if;
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on function public.weekpost_resolve(text, text, boolean, text), public.weekpost_restore(text, text) from anon;
  end if;
  if exists (select from pg_roles where rolname = 'authenticated') then
    revoke all on function public.weekpost_resolve(text, text, boolean, text), public.weekpost_restore(text, text) from authenticated;
  end if;
end
$$;

update public.weekpost_schema set version = 3;

commit;
