-- weekpost queue, step 7: how a Story is published.
--
-- `publish_mode` says who publishes a post: 'auto' (the Worker) or 'manual' (the operator, by hand, with the link
-- sticker). It was implicit before: a Story sat in status `manual`. Now the mode is its own column, so a manual Story
-- can also carry a fallback (`fallback_at`: the instant after which the Worker may publish it without the sticker) and
-- keep its mode while it is retried (`scheduled` + `publish_mode = 'manual'` is a fallback being retried).
--
-- Expand only: nothing is renamed or dropped and no function changes its signature, so the Worker and CLI of the
-- previous version keep running. The column has no default on purpose: a CLI of an older version inserts a Story
-- without it, and a default of 'auto' would turn that manual Story into an automatic one. A BEFORE INSERT trigger
-- fills it instead (a Story is manual, anything else auto).
--
-- `weekpost_claim` is intentionally unchanged here. A later version will teach it to claim `manual` rows whose
-- `fallback_at` has passed.
--
-- Run it once, after 0006_token_login.sql. Plain Postgres. The new functions get their own grants at the end.

begin;

alter table public.weekpost_posts
  add column publish_mode text check (publish_mode in ('auto', 'manual')),
  add column fallback_at timestamptz;

-- A Story, or a row already waiting for the operator, was manual; everything else was automatic.
update public.weekpost_posts
  set publish_mode = case when type = 'story' or status = 'manual' then 'manual' else 'auto' end;

alter table public.weekpost_posts
  alter column publish_mode set not null,
  add constraint weekpost_posts_fallback_manual check (fallback_at is null or publish_mode = 'manual'),
  add constraint weekpost_posts_manual_status check (status <> 'manual' or publish_mode = 'manual');

create function public.weekpost_posts_default_mode()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.publish_mode is null then
    new.publish_mode := case when new.type = 'story' then 'manual' else 'auto' end;
  end if;
  return new;
end;
$$;

create trigger weekpost_posts_default_mode before insert on public.weekpost_posts
  for each row execute function public.weekpost_posts_default_mode();

-- Same guard as 0003, plus: the publish mode and the fallback instant are content, frozen while publishing/published.
create or replace function public.weekpost_posts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('publishing', 'published')
    and (new.type, new.week, new.publish_at, new.caption, new.media, new.cover, new.link, new.media_hash, new.publish_mode, new.fallback_at)
      is distinct from (old.type, old.week, old.publish_at, old.caption, old.media, old.cover, old.link, old.media_hash, old.publish_mode, old.fallback_at) then
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

-- `weekpost restore`: undoes a cancel. A manual post goes back to `manual`, the others to `scheduled`, with a clean slate.
create or replace function public.weekpost_restore(p_post_id text, p_account text)
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
    set status = case when publish_mode = 'manual' then 'manual' else 'scheduled' end,
        attempts = 0, next_attempt_at = null, last_error = null, container_id = null
    where post_id = p_post_id and account = p_account and status = 'canceled';
  v_found := found;
  perform set_config('weekpost.transition', 'off', true);
  if not v_found then
    raise exception 'weekpost_posts %/%: not canceled', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

-- `weekpost resolve` for a manual Story: the operator posted it by hand (published, with its link if any) or gave up
-- (canceled). Accepts `manual`, and `scheduled` with publish_mode = 'manual' (a fallback being retried). Same errcode
-- as weekpost_resolve for anything else.
create function public.weekpost_resolve_manual(p_post_id text, p_account text, p_published boolean, p_permalink text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if p_published then
    update public.weekpost_posts
      set status = 'published', permalink = p_permalink, media_id = null, published_at = now(), last_error = null, next_attempt_at = null
      where post_id = p_post_id and account = p_account
        and (status = 'manual' or (status = 'scheduled' and publish_mode = 'manual'));
  else
    update public.weekpost_posts
      set status = 'canceled', canceled_by = 'operator', next_attempt_at = null
      where post_id = p_post_id and account = p_account
        and (status = 'manual' or (status = 'scheduled' and publish_mode = 'manual'));
  end if;
  v_found := found;
  if not v_found then
    raise exception 'weekpost_posts %/%: not manual', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

-- Asks for the fallback now: a manual Story that is still `manual` becomes eligible immediately.
create function public.weekpost_story_fallback_now(p_post_id text, p_account text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  update public.weekpost_posts
    set fallback_at = now()
    where post_id = p_post_id and account = p_account and status = 'manual' and publish_mode = 'manual';
  v_found := found;
  if not v_found then
    raise exception 'weekpost_posts %/%: not manual', p_post_id, p_account using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.weekpost_resolve_manual(text, text, boolean, text) from public;
revoke all on function public.weekpost_story_fallback_now(text, text) from public;

do $$
begin
  if exists (select from pg_roles where rolname = 'service_role') then
    grant execute on function public.weekpost_resolve_manual(text, text, boolean, text) to service_role;
    grant execute on function public.weekpost_story_fallback_now(text, text) to service_role;
  end if;
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on function public.weekpost_resolve_manual(text, text, boolean, text), public.weekpost_story_fallback_now(text, text) from anon;
  end if;
  if exists (select from pg_roles where rolname = 'authenticated') then
    revoke all on function public.weekpost_resolve_manual(text, text, boolean, text), public.weekpost_story_fallback_now(text, text) from authenticated;
  end if;
end
$$;

update public.weekpost_schema set version = 7;

commit;
