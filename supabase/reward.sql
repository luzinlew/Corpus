-- Corpus: weekly reward. The most active AND accurate person of the last full week (Mon–Sun, Tallinn time)
-- gets +20 AI requests (added to public.ai_bonus, spent after the day's own allowance, never expires).
-- Needs supabase/ai.sql and supabase/stats.sql run first. Paste into Supabase → SQL Editor → Run. Safe to run again.
--
-- Who counts: at least 3 active days, at least 30 answers and at least 70% of them not "Again". The winner is the one
-- with the most such good answers (ties: higher accuracy, then more active days). Change the rules in corpus_week_award below.
-- Size of the reward:  update private.settings set value = '30' where key = 'ai_week_reward';

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
  today date := (now() at time zone 'Europe/Tallinn')::date;
  ws date := date_trunc('week', (now() at time zone 'Europe/Tallinn'))::date - 7;   -- last Monday-to-Sunday week
  we date := date_trunc('week', (now() at time zone 'Europe/Tallinn'))::date - 1;
  u integer; w record; ab public.ai_bonus; fresh boolean := false; aw private.ai_awards;
begin
  if uid is null then return jsonb_build_object('week', null); end if;
  select * into aw from private.ai_awards where week_start = ws;
  if not found then
    select coalesce(nullif(value, '')::integer, 20) into u from private.settings where key = 'ai_week_reward';
    u := coalesce(u, 20);
    select p.owner, p.n, p.ok, p.days into w from (
      select r.owner, sum(r.n)::integer as n, sum(r.ok)::integer as ok,
             (select count(*) from public.activity a where a.user_id = r.owner and a.day between ws and we)::integer as days
        from (
          select d.owner, e.key::date as day,
                 case when jsonb_typeof(e.value -> 'n') = 'number' then (e.value ->> 'n')::numeric else 0 end as n,
                 case when jsonb_typeof(e.value -> 'ok') = 'number' then (e.value ->> 'ok')::numeric else 0 end as ok
            from public.docs d
            cross join lateral jsonb_each(case when jsonb_typeof(d.data -> 'days') = 'object' then d.data -> 'days' else '{}'::jsonb end) e
           where d.coll = 'stats' and e.key ~ '^\d{4}-\d{2}-\d{2}$'
             and e.key between to_char(ws, 'YYYY-MM-DD') and to_char(we, 'YYYY-MM-DD')
        ) r group by r.owner
    ) p
    where p.days >= 3 and p.n >= 30 and p.ok >= 0.7 * p.n
    order by p.ok desc, p.ok::numeric / p.n desc, p.days desc, p.owner
    limit 1;
    insert into private.ai_awards (week_start, user_id, units, answers, good, days)
    values (ws, w.owner, case when w.owner is null then 0 else u end, coalesce(w.n, 0), coalesce(w.ok, 0), coalesce(w.days, 0))
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
    'winner', (select left(email, 2) || '***@' || split_part(email, '@', 2) from auth.users where id = aw.user_id),
    'balance', coalesce(ab.balance, 0));
end $$;
revoke execute on function public.corpus_week_award() from public, anon;
grant execute on function public.corpus_week_award() to authenticated;
