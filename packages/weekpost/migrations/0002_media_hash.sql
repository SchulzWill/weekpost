-- weekpost queue, step 2: the hash of the approved media.
--
-- `media_hash` is a sha-256 over the sha-256 of every published file plus the cover, as approved in the preview.
-- The enqueue compares it (with content_hash and publish_at) to decide whether a row is already queued, so a
-- regenerated image with the same caption is not mistaken for the one that was approved. Null on rows written
-- before this migration: the next enqueue refreshes the ones that are still editable.
--
-- Run it once, after 0001_queue.sql. Plain Postgres, no grants needed (the table-level grants cover new columns).

begin;

alter table public.weekpost_posts
  add column media_hash text check (media_hash is null or media_hash ~ '^[0-9a-f]{64}$');

-- Same guard as before, with the media hash frozen together with the rest of the content.
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
  new.updated_at := now();
  return new;
end;
$$;

update public.weekpost_schema set version = 2;

commit;
