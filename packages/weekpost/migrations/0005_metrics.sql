-- weekpost queue, step 5: the Insights collected by `weekpost metrics`.
--
-- One row per (scope, post, account, day, metric) in a long table, so a metric that Meta adds or retires needs
-- no migration. `scope` is 'post' (post_id set) or 'account' (post_id is the empty string). Re-collecting the same
-- day overwrites the value.
--
-- Run it once, after 0004_operator_functions.sql. Additive only: the Worker of the previous version keeps working
-- between this migration and its next deploy. Plain Postgres; the grants at the end are conditional like in 0001.

begin;

create table public.weekpost_metrics (
  scope text not null check (scope in ('post', 'account')),
  post_id text not null default '' check (
    (scope = 'post' and post_id ~ '^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$' and length(post_id) <= 120) or (scope = 'account' and post_id = '')
  ),
  account text not null check (account ~ '^[a-z][a-z0-9-]{0,15}$'),
  collected_on date not null,
  metric text not null check (metric ~ '^[a-z][a-z0-9_]{0,63}$'),
  value bigint not null check (value >= 0),
  created_at timestamptz not null default now(),
  primary key (scope, post_id, account, collected_on, metric)
);

create index weekpost_metrics_by_day on public.weekpost_metrics (collected_on);

alter table public.weekpost_metrics enable row level security;
revoke all on public.weekpost_metrics from public;

do $$
begin
  if exists (select from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.weekpost_metrics to service_role;
  end if;
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on public.weekpost_metrics from anon;
  end if;
  if exists (select from pg_roles where rolname = 'authenticated') then
    revoke all on public.weekpost_metrics from authenticated;
  end if;
end
$$;

update public.weekpost_schema set version = 5;

commit;
