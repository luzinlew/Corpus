-- Corpus AI: plans and daily limits. Paste into Supabase → SQL Editor → Run. Safe to run again.
-- Also part of setup.sql (section 4) for new projects.

-- Plan per user. No row = the free plan. Users can read their own row, only SQL (you) can change it:
--   give someone more:  insert into public.ai_plans (user_id, plan, daily_limit)
--                         select id, 'pro', 200 from auth.users where email = 'friend@example.com'
--                         on conflict (user_id) do update set plan = excluded.plan, daily_limit = excluded.daily_limit;
create table if not exists public.ai_plans (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free',
  daily_limit integer not null check (daily_limit >= 0),
  updated_at timestamptz not null default now()
);
alter table public.ai_plans enable row level security;
drop policy if exists "read own plan" on public.ai_plans;
create policy "read own plan" on public.ai_plans for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.ai_plans to authenticated;

-- Requests used per user per day (Tallinn time). Read-only for users; only corpus_ai_take writes.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  used integer not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
drop policy if exists "read own usage" on public.ai_usage;
create policy "read own usage" on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.ai_usage to authenticated;

-- Free daily limit for everyone without a plan row:  update private.settings set value = '30' where key = 'ai_free_daily';
create schema if not exists private;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('ai_free_daily', '20')
on conflict (key) do nothing;

-- Takes p_units of today's allowance for the signed-in user, atomically. p_units = 0 just reports.
-- Never gives units back, so calling it directly can only use up one's own allowance.
create or replace function public.corpus_ai_take(p_units integer default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  d date := (now() at time zone 'Europe/Tallinn')::date;
  lim integer; pl text; cur integer;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if p_units is null or p_units < 0 or p_units > 20 then raise exception 'bad_units' using errcode = '22023'; end if;
  select daily_limit, plan into lim, pl from public.ai_plans where user_id = uid;
  if lim is null then
    select coalesce(nullif(value, '')::integer, 20) into lim from private.settings where key = 'ai_free_daily';
    lim := coalesce(lim, 20); pl := 'free';
  end if;
  insert into public.ai_usage (user_id, day, used) values (uid, d, 0) on conflict (user_id, day) do nothing;
  update public.ai_usage set used = used + p_units
   where user_id = uid and day = d and used + p_units <= lim
  returning used into cur;
  if cur is null then
    select used into cur from public.ai_usage where user_id = uid and day = d;
    return jsonb_build_object('ok', false, 'plan', pl, 'limit', lim, 'used', cur);
  end if;
  return jsonb_build_object('ok', true, 'plan', pl, 'limit', lim, 'used', cur);
end $$;
revoke execute on function public.corpus_ai_take(integer) from public, anon;
grant execute on function public.corpus_ai_take(integer) to authenticated;
