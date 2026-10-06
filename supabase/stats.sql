-- Corpus: who uses the site. Paste into Supabase → SQL Editor → Run. Safe to run again.
-- Only signed-in people are counted: the site marks the day each time someone opens it.
-- Admins see the numbers in the app (Veel → Saidi statistika). Set them (comma-separated emails):
--   update private.settings set value = 'you@example.com' where key = 'admins';

create table if not exists public.activity (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  opens integer not null default 1,
  last_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.activity enable row level security;   -- no policies: nobody reads or writes it directly

create schema if not exists private;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('admins', '') on conflict (key) do nothing;

create or replace function private.corpus_is_admin(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u, private.settings s
     where u.id = uid and s.key = 'admins'
       and lower(u.email) = any (select btrim(x) from unnest(string_to_array(lower(s.value), ',')) as x)
  )
$$;

-- Called by the site when it opens: today counts as active; also says whether this person is an admin.
create or replace function public.corpus_ping() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  d date := (now() at time zone 'Europe/Tallinn')::date;
begin
  if uid is null then return jsonb_build_object('admin', false); end if;
  insert into public.activity (user_id, day) values (uid, d)
  on conflict (user_id, day) do update set opens = public.activity.opens + 1, last_at = now();
  return jsonb_build_object('admin', private.corpus_is_admin(uid));
end $$;
revoke execute on function public.corpus_ping() from public, anon;
grant execute on function public.corpus_ping() to authenticated;

-- The numbers for the admin screen. Everyone else gets an error.
create or replace function public.corpus_site_stats(p_days integer default 14) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'Europe/Tallinn')::date;
  n integer := least(greatest(coalesce(p_days, 14), 7), 60);
  ai7 bigint := 0;
  res jsonb;
begin
  if uid is null or not private.corpus_is_admin(uid) then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if to_regclass('public.ai_usage') is not null then
    execute 'select coalesce(sum(used), 0) from public.ai_usage where day > $1' into ai7 using today - 7;
  end if;

  with rev0 as (     -- every deck's statistics document: { days: { "YYYY-MM-DD": { n, ok } } }
    select d.owner, e.key, e.value
      from public.docs d
      cross join lateral jsonb_each(case when jsonb_typeof(d.data -> 'days') = 'object' then d.data -> 'days' else '{}'::jsonb end) e
     where d.coll = 'stats'
  ), rev as (       -- answers per person per day, last 60 days
    select owner, key::date as day, sum(case when jsonb_typeof(value -> 'n') = 'number' then (value ->> 'n')::numeric else 0 end)::bigint as n
      from rev0
     where key ~ '^\d{4}-\d{2}-\d{2}$' and key >= to_char(today - 60, 'YYYY-MM-DD')
     group by 1, 2
  ), days as (
    select generate_series(today - (n - 1), today, interval '1 day')::date as day
  )
  select jsonb_build_object(
    'users',         (select count(*) from auth.users),
    'new7',          (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'active_today',  (select count(*) from public.activity where day = today),
    'active7',       (select count(distinct user_id) from public.activity where day > today - 7),
    'active30',      (select count(distinct user_id) from public.activity where day > today - 30),
    'reviews_today', (select coalesce(sum(r.n), 0) from rev r where r.day = today),
    'reviews7',      (select coalesce(sum(r.n), 0) from rev r where r.day > today - 7),
    'ai7',           ai7,
    'days', (select jsonb_agg(jsonb_build_object(
                'day', ds.day,
                'active',  (select count(*) from public.activity a where a.day = ds.day),
                'reviews', (select coalesce(sum(r.n), 0) from rev r where r.day = ds.day),
                'signups', (select count(*) from auth.users u where (u.created_at at time zone 'Europe/Tallinn')::date = ds.day)
              ) order by ds.day) from days ds),
    'people', (select coalesce(jsonb_agg(p order by p.last_seen desc nulls last, p.joined desc), '[]'::jsonb) from (
                select u.email,
                       (u.created_at at time zone 'Europe/Tallinn')::date as joined,
                       (select max(a.last_at) from public.activity a where a.user_id = u.id) as last_seen,
                       (select count(*) from public.activity a where a.user_id = u.id and a.day > today - 30) as days30,
                       (select coalesce(sum(r.n), 0) from rev r where r.owner = u.id and r.day > today - 7) as reviews7
                  from auth.users u
                 order by u.created_at desc
                 limit 300) p)
  ) into res;
  return res;
end $$;
revoke execute on function public.corpus_site_stats(integer) from public, anon;
grant execute on function public.corpus_site_stats(integer) to authenticated;
