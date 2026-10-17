-- Corpus: weekly reward. The person in 1st place of the "correct this week" table (the rating, supabase/rating.sql) for the last full
-- week (Mon–Sun, Tallinn time) gets +20 AI requests (added to public.ai_bonus, spent after the day's own allowance, never expires).
-- Needs supabase/ai.sql and supabase/rating.sql run first (rating.sql before this file). Paste into Supabase → SQL Editor → Run. Safe to run again.
--
-- Who counts: a row of public.rating_week for last Monday (so the daily caps of the rating apply), a person who is NOT hidden
-- (anon, real and alias take part; hidden never wins), with at least 3 active days, at least 30 answers and at least 70% of them
-- correct. The winner has the most points (ties: more answers, then the lower user id). If nobody fits, nobody gets the reward.
-- The winner's name in the answer is the rating name ("Студент" for anon), never an email.
-- Size of the reward:  update private.settings set value = '30' where key = 'ai_week_reward';
-- Back to the previous version (activity-based): supabase/reward_rollback.sql

insert into private.settings (key, value) values ('ai_week_reward', '20') on conflict (key) do nothing;

create table if not exists private.ai_awards (
  week_start date primary key,
  user_id uuid references auth.users (id) on delete set null,   -- null: nobody qualified that week
  units integer not null default 0,
  answers integer not null default 0,
  good integer not null default 0,
  days integer not null default 0,
  created_at timestamptz not null default now()
);

-- Called by the site when it opens. Closes last week once (the first call after the week ends does the work),
-- and tells whether the signed-in person won it.
create or replace function public.corpus_week_award() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  ws date := date_trunc('week', private.rating_today()::timestamp)::date - 7;   -- Monday of last Monday-to-Sunday week
  u integer; w record; ab public.ai_bonus; fresh boolean := false; aw private.ai_awards;
begin
  if uid is null then return jsonb_build_object('week', null); end if;
  select * into aw from private.ai_awards where week_start = ws;
  if not found then
    select coalesce(nullif(value, '')::integer, 20) into u from private.settings where key = 'ai_week_reward';
    u := coalesce(u, 20);
    select r.user_id, r.answers, r.correct, r.active_days into w
      from public.rating_week r left join public.rating_profile p on p.user_id = r.user_id
     where r.week_start = ws and coalesce(p.mode, 'anon') <> 'hidden'
       and r.active_days >= 3 and r.answers >= 30 and r.correct >= 0.7 * r.answers
     order by r.points desc, r.answers desc, r.user_id
     limit 1;
    insert into private.ai_awards (week_start, user_id, units, answers, good, days)
    values (ws, w.user_id, case when w.user_id is null then 0 else u end, coalesce(w.answers, 0), coalesce(w.correct, 0), coalesce(w.active_days, 0))
    on conflict (week_start) do nothing
    returning * into aw;
    if aw.week_start is not null then
      fresh := true;
      if aw.user_id is not null then
        insert into public.ai_bonus (user_id, balance) values (aw.user_id, aw.units)
        on conflict (user_id) do update set balance = public.ai_bonus.balance + excluded.balance;
      end if;
    else
      select * into aw from private.ai_awards where week_start = ws;
    end if;
  end if;
  select * into ab from public.ai_bonus where user_id = uid;
  return jsonb_build_object(
    'week', ws, 'me', aw.user_id is not null and aw.user_id = uid, 'fresh', fresh, 'units', aw.units,
    'winner', case when aw.user_id is null then null else private.rating_name(aw.user_id) end,
    'balance', coalesce(ab.balance, 0));
end $$;
revoke execute on function public.corpus_week_award() from public, anon;
grant execute on function public.corpus_week_award() to authenticated;
