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

-- ---------------------------------------------------------------------------------------------------------------------
-- Course allowance ("one course free"). Translating and building courses (the corpus-ai function, task 'translate') is paid
-- from its own allowance first: a number of requests per person for good, not per day. When it is used up (or the site-wide
-- course cap for the day is), the request is taken from the daily allowance above, exactly like any other AI request.
--
-- Change the allowance of everyone (default 300 requests):   update private.settings set value = '500' where key = 'ai_course_free';
-- Site-wide cap of course requests per day (all people together, default 1000):
--                                                            update private.settings set value = '2000' where key = 'ai_course_global_daily';
-- Give one person more (granted requests come on top of the common allowance; the row is made if the person has none yet):
--   insert into public.ai_course (user_id, granted) select id, 500 from auth.users where email = 'friend@example.com'
--   on conflict (user_id) do update set granted = excluded.granted;
-- Look at it:  select u.email, c.used, c.granted from public.ai_course c join auth.users u on u.id = c.user_id order by c.used desc;
-- The site as a whole, per day (Tallinn time):  select day, used from private.ai_course_global order by day desc limit 14;
-- Stop everything at once: set both ai_course_global_daily and ai_global_daily to '0' (the course pool and the daily pool then pay nothing).
-- Stop one person: public.ai_plans.daily_limit = 0 for them ("AI is off"): the course pool does not pay for them either, and
-- corpus_ai_take refuses (a bonus balance, if they have one, would still be spent there).
-- Take it all away again: supabase/ai_course_rollback.sql.
-- A value in private.settings that is not a plain number is ignored and the default is used. This holds only for these two
-- new settings (ai_course_free, ai_course_global_daily); ai_free_daily and ai_global_daily are read as before.
insert into private.settings (key, value) values ('ai_course_free', '300')
on conflict (key) do nothing;
insert into private.settings (key, value) values ('ai_course_global_daily', '1000')
on conflict (key) do nothing;

-- Per person: course requests used so far, and requests granted on top of the common allowance.
-- Users can read their own row; only SQL (you) and corpus_ai_take_course change it.
create table if not exists public.ai_course (
  user_id uuid primary key references auth.users (id) on delete cascade,
  used integer not null default 0 check (used >= 0),
  granted integer not null default 0 check (granted >= 0)
);
alter table public.ai_course enable row level security;
drop policy if exists "read own course allowance" on public.ai_course;
create policy "read own course allowance" on public.ai_course for select to authenticated
  using (user_id = (select auth.uid()));
-- Supabase gives anon and authenticated every right on new tables in public by default: take it all away, then give back only reading.
revoke all on public.ai_course from anon, authenticated;
grant select on public.ai_course to authenticated;

-- Course requests of the whole site per day (Tallinn time), counted against ai_course_global_daily.
create table if not exists private.ai_course_global (
  day date primary key,
  used integer not null default 0
);

-- Takes p_units of the course allowance for the signed-in user, atomically; p_units = 0 just reports.
-- Answer: everything corpus_ai_take answers (plan, limit, used, bonus), plus pool ('course' or 'daily'; null for a report),
-- course_left and course_free. If the course allowance cannot pay (used up, or the site-wide course cap of the day is reached),
-- the units are taken from the daily allowance by corpus_ai_take (pool 'daily'; ok = false when that is used up too).
-- It never gives units back to the caller. A signed-in person who calls it directly (corpus_ai_take_course(20)) can burn their own
-- course allowance and also the site-wide course count of the day; after that the course requests of everybody are paid from the
-- daily pool. That costs no money: nothing is sent to the model.
-- A person whose public.ai_plans.daily_limit is 0 ("AI is off") is not paid from the course pool: the request goes to corpus_ai_take, which refuses it.
create or replace function public.corpus_ai_take_course(p_units integer default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  d date := (now() at time zone 'Europe/Tallinn')::date;
  cu integer; gr integer; base integer; total integer; remain integer; gl integer; gcur integer; dl integer; r jsonb;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if p_units is null or p_units < 0 or p_units > 20 then raise exception 'bad_units' using errcode = '22023'; end if;
  insert into public.ai_course (user_id) values (uid) on conflict (user_id) do nothing;
  select used, granted into cu, gr from public.ai_course where user_id = uid for update;
  select case when btrim(value) ~ '^[0-9]{1,9}$' then btrim(value)::integer end into base from private.settings where key = 'ai_course_free';
  total := coalesce(base, 300) + gr;
  remain := greatest(total - cu, 0);
  if p_units = 0 then
    return public.corpus_ai_take(0) || jsonb_build_object('pool', null, 'course_left', remain, 'course_free', total);
  end if;
  if remain >= p_units then
    -- "AI is off" for this person (ai_plans.daily_limit = 0): the course pool does not pay either, corpus_ai_take below refuses
    select daily_limit into dl from public.ai_plans where user_id = uid;
    if dl is distinct from 0 then
      -- the site-wide course cap of the day: if it is reached, the course allowance is not touched and the daily one pays
      select case when btrim(value) ~ '^[0-9]{1,9}$' then btrim(value)::integer end into gl from private.settings where key = 'ai_course_global_daily';
      gl := coalesce(gl, 1000);
      insert into private.ai_course_global (day, used) values (d, 0) on conflict (day) do nothing;
      update private.ai_course_global set used = used + p_units
       where day = d and used + p_units <= gl
      returning used into gcur;
      if gcur is not null then
        update public.ai_course set used = cu + p_units where user_id = uid;
        return public.corpus_ai_take(0) || jsonb_build_object('ok', true, 'pool', 'course', 'course_left', remain - p_units, 'course_free', total);
      end if;
    end if;
  end if;
  r := public.corpus_ai_take(p_units);
  return r || jsonb_build_object('pool', 'daily', 'course_left', remain, 'course_free', total);
end $$;
revoke execute on function public.corpus_ai_take_course(integer) from public, anon;
grant execute on function public.corpus_ai_take_course(integer) to authenticated;
