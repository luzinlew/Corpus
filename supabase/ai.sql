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

-- Cap for the whole site per day (all people together), so that many accounts cannot add up to an unlimited bill.
-- Change it:  update private.settings set value = '500' where key = 'ai_global_daily';
insert into private.settings (key, value) values ('ai_global_daily', '300')
on conflict (key) do nothing;
create table if not exists private.ai_global (
  day date primary key,
  used integer not null default 0
);

-- Bonus requests won as the weekly reward (supabase/reward.sql). Spent only after the day's own allowance is used up.
-- Users can read their own balance; only SQL and the reward function change it.
create table if not exists public.ai_bonus (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance integer not null default 0 check (balance >= 0)
);
alter table public.ai_bonus enable row level security;
drop policy if exists "read own bonus" on public.ai_bonus;
create policy "read own bonus" on public.ai_bonus for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.ai_bonus to authenticated;
alter table public.ai_usage add column if not exists bonus_used integer not null default 0;

-- Takes p_units of today's allowance for the signed-in user, atomically. p_units = 0 just reports.
-- The day's own allowance goes first, then the bonus balance. 'limit' = everything that can be used today (allowance + bonus).
-- Never gives units back to the caller (only itself, when the site-wide cap refuses), so calling it directly can only use up one's own allowance.
create or replace function public.corpus_ai_take(p_units integer default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  d date := (now() at time zone 'Europe/Tallinn')::date;
  lim integer; pl text; cu integer; bu integer; bal integer; room integer; fb integer; gl integer; gcur integer;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if p_units is null or p_units < 0 or p_units > 20 then raise exception 'bad_units' using errcode = '22023'; end if;
  select daily_limit, plan into lim, pl from public.ai_plans where user_id = uid;
  if lim is null then
    select coalesce(nullif(value, '')::integer, 20) into lim from private.settings where key = 'ai_free_daily';
    lim := coalesce(lim, 20); pl := 'free';
  end if;
  insert into public.ai_usage (user_id, day, used) values (uid, d, 0) on conflict (user_id, day) do nothing;
  insert into public.ai_bonus (user_id, balance) values (uid, 0) on conflict (user_id) do nothing;
  select used, bonus_used into cu, bu from public.ai_usage where user_id = uid and day = d for update;
  select balance into bal from public.ai_bonus where user_id = uid for update;
  room := greatest(lim - (cu - bu), 0);          -- what is left of the day's own allowance
  fb := greatest(p_units - room, 0);             -- the part that has to come from the bonus
  if fb > bal then
    return jsonb_build_object('ok', false, 'plan', pl, 'limit', lim + bu + bal, 'used', cu, 'bonus', bal);
  end if;
  if p_units > 0 then
    -- the site-wide cap: if it is used up, nothing is taken and the request is refused
    select coalesce(nullif(value, '')::integer, 300) into gl from private.settings where key = 'ai_global_daily';
    gl := coalesce(gl, 300);
    insert into private.ai_global (day, used) values (d, 0) on conflict (day) do nothing;
    update private.ai_global set used = used + p_units
     where day = d and used + p_units <= gl
    returning used into gcur;
    if gcur is null then
      return jsonb_build_object('ok', false, 'plan', pl, 'limit', lim + bu + bal, 'used', cu, 'bonus', bal, 'global', true);
    end if;
    update public.ai_usage set used = cu + p_units, bonus_used = bu + fb where user_id = uid and day = d;
    if fb > 0 then update public.ai_bonus set balance = bal - fb where user_id = uid; bal := bal - fb; end if;
    cu := cu + p_units; bu := bu + fb;
  end if;
  return jsonb_build_object('ok', true, 'plan', pl, 'limit', lim + bu + bal, 'used', cu, 'bonus', bal);
end $$;
revoke execute on function public.corpus_ai_take(integer) from public, anon;
grant execute on function public.corpus_ai_take(integer) to authenticated;
