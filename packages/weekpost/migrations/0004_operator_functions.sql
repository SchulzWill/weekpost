-- weekpost queue, step 4: the operator's status transitions live in SQL.
--
-- `weekpost cancel` and `weekpost reschedule` used to read the row, decide in the CLI, and PATCH it with a status
-- guard. Now each is one function that locks the row, checks its status and writes in the same statement block, the
-- way weekpost_restore and weekpost_resolve already do (0003). The CLI only calls them.
--
-- Run it once, after 0003_stale_runs.sql. Plain Postgres. The new functions get their own grants at the end.

begin;

-- `weekpost cancel` and the enqueue's cancel. Returns the status the row had. Refuses publishing and published.
-- A row that is already canceled is left alone (it keeps its canceled_by) and answers 'canceled'. The source commit
-- stamp is written only when given.
create function public.weekpost_cancel(
  p_post_id text, p_account text, p_by text, p_source_commit text, p_source_committed_at timestamptz)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_by is null or p_by not in ('enqueue', 'operator') then
    raise exception 'weekpost_posts %/%: canceled_by must be enqueue or operator', p_post_id, p_account
      using errcode = 'invalid_parameter_value';
  end if;
  select status into v_status from public.weekpost_posts
    where post_id = p_post_id and account = p_account for update;
  if not found then
    raise exception 'weekpost_posts %/%: not found', p_post_id, p_account using errcode = 'no_data_found';
  end if;
  if v_status in ('publishing', 'published') then
    raise exception 'weekpost_posts %/%: cannot cancel, status is %', p_post_id, p_account, v_status
      using errcode = 'check_violation';
  end if;
  if v_status = 'canceled' then
    return v_status;
  end if;
  update public.weekpost_posts
    set status = 'canceled', canceled_by = p_by, next_attempt_at = null,
        source_commit = coalesce(p_source_commit, source_commit),
        source_committed_at = coalesce(p_source_committed_at, source_committed_at)
    where post_id = p_post_id and account = p_account;
  return v_status;
end;
$$;

-- `weekpost reschedule`. A scheduled row only; a failed one too when p_rearm (clean slate, back to scheduled), unless
-- it already has a media id (Instagram may have published it).
create function public.weekpost_reschedule(p_post_id text, p_account text, p_publish_at timestamptz, p_rearm boolean)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_media_id text;
begin
  select status, media_id into v_status, v_media_id from public.weekpost_posts
    where post_id = p_post_id and account = p_account for update;
  if not found then
    raise exception 'weekpost_posts %/%: not found', p_post_id, p_account using errcode = 'no_data_found';
  end if;
  if v_status <> 'scheduled' and not (p_rearm and v_status = 'failed') then
    raise exception 'weekpost_posts %/%: cannot reschedule, status is %', p_post_id, p_account, v_status
      using errcode = 'check_violation';
  end if;
  if p_rearm and v_media_id is not null then
    raise exception 'weekpost_posts %/%: cannot rearm, it has a media id', p_post_id, p_account
      using errcode = 'check_violation';
  end if;
  if p_rearm then
    update public.weekpost_posts
      set publish_at = p_publish_at, rescheduled_at = now(),
          status = 'scheduled', attempts = 0, next_attempt_at = null, last_error = null
      where post_id = p_post_id and account = p_account;
  else
    update public.weekpost_posts
      set publish_at = p_publish_at, rescheduled_at = now()
      where post_id = p_post_id and account = p_account;
  end if;
end;
$$;

revoke all on function public.weekpost_cancel(text, text, text, text, timestamptz) from public;
revoke all on function public.weekpost_reschedule(text, text, timestamptz, boolean) from public;

do $$
begin
  if exists (select from pg_roles where rolname = 'service_role') then
    grant execute on function public.weekpost_cancel(text, text, text, text, timestamptz) to service_role;
    grant execute on function public.weekpost_reschedule(text, text, timestamptz, boolean) to service_role;
  end if;
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on function public.weekpost_cancel(text, text, text, text, timestamptz), public.weekpost_reschedule(text, text, timestamptz, boolean) from anon;
  end if;
  if exists (select from pg_roles where rolname = 'authenticated') then
    revoke all on function public.weekpost_cancel(text, text, text, text, timestamptz), public.weekpost_reschedule(text, text, timestamptz, boolean) from authenticated;
  end if;
end
$$;

update public.weekpost_schema set version = 4;

commit;
