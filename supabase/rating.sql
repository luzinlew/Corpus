-- Corpus: weekly student rating. Paste into Supabase → SQL Editor → Run. Safe to run again.
--
-- What it adds: one shared leaderboard for all students. The week runs Monday to Sunday by Tallinn time and starts from zero every
-- Monday. Everybody takes part at once, anonymously (shown as "Студент"); a person can open their email name, choose a nickname or hide
-- (the site asks once, on first visit). Modes: anon (default) / real / alias / hidden.
--   * the app sends its per-day counts, {"YYYY-MM-DD": {"n": answers, "ok": correct}}, for the current week only;
--   * a day counts at most 400 answers (if more are sent, the correct ones are scaled down in proportion); for the "correct this
--     week" table at most 150 correct answers a day (the cap);
--   * three tables: correct this week (points) / prepared (share of correct) / fewer mistakes (share of wrong); the two shares need
--     at least 100 answers in the week on at least 2 different days; they are ranked by the exact share, rounded only for display;
--   * a submit with no valid day writes nothing, and a submit never lowers the week's answers (an out-of-date device cannot reset it);
--   * hidden people are not in any table; the table never shows an email or a user id, only a display name;
--   * after delete_mine the person stays hidden until they choose again;
--   * rows older than 8 weeks are deleted on every submit.
-- Nothing is readable from the tables directly (RLS on, no policies, no grants): everything goes through the functions below.
-- The old version of the site does not call them, so it keeps working as before.
--
-- Display name: anon -> "Студент" always; alias -> the nickname; real -> (only if the person has answered "how to show me", asked)
-- taken from the email's local part, split on . _ - + and digits, letters only:  lev.luzin@x.ee -> "Lev L.", luzinlew@gmail.com -> "Luzinlew".
-- When there are no letters the name is "Студент". Nobody shows up under an email name unless they chose "real".
-- Existing rows with mode real and asked=false (shown as "Студент" so far) are migrated to anon; safe to run again.
--
-- Check before running (read-only). Letters like õ ä ö ü ж must count as letters, otherwise their names and nicknames are refused:
--   show lc_ctype; select upper('õ'), 'ж' ~ '[[:alpha:]]';     -- expected: 'Õ' and true
--
-- To remove everything this file adds: supabase/rating_rollback.sql (the rating results are lost).

create schema if not exists private;

-- Same table as in ai.sql (the reward size lives there); created here too so that this file does not depend on ai.sql.
create table if not exists private.settings (key text primary key, value text not null);

create table if not exists public.rating_profile (
  user_id    uuid primary key references auth.users on delete cascade,
  mode       text not null default 'anon',
  alias      text,
  asked      boolean not null default false,
  updated_at timestamptz default now()
);
-- Modes: allow 'anon', default 'anon' (works for a table created by the older version too).
alter table public.rating_profile drop constraint if exists rating_profile_mode_check;
alter table public.rating_profile add constraint rating_profile_mode_check check (mode in ('anon', 'real', 'alias', 'hidden'));
alter table public.rating_profile alter column mode set default 'anon';
update public.rating_profile set mode = 'anon' where mode = 'real' and asked = false;

create table if not exists public.rating_week (
  user_id     uuid references auth.users on delete cascade,
  week_start  date,
  answers     int,
  correct     int,
  active_days int,
  points      int,
  updated_at  timestamptz default now(),
  primary key (user_id, week_start)
);
create index if not exists rating_week_week_idx on public.rating_week (week_start);

alter table public.rating_profile enable row level security;
alter table public.rating_week enable row level security;
revoke all on public.rating_profile from public, anon, authenticated;
revoke all on public.rating_week from public, anon, authenticated;

-- Today by Tallinn time (one place, so the week boundary is the same everywhere; tests replace it).
create or replace function private.rating_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Europe/Tallinn')::date
$$;
revoke execute on function private.rating_today() from public, anon, authenticated;

-- Display name. Never returns the email itself.
create or replace function private.rating_name(p_uid uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare m text; a text; asked boolean; em text; toks text[]; t1 text; t2 text;
begin
  select p.mode, p.alias, p.asked into m, a, asked from public.rating_profile p where p.user_id = p_uid;
  if m = 'alias' and a is not null and a <> '' then return a; end if;
  if m is distinct from 'real' or not coalesce(asked, false) then return 'Студент'; end if;
  select u.email into em from auth.users u where u.id = p_uid;
  select array_agg(s.t order by s.ord) into toks
    from (select regexp_replace(x, '[^[:alpha:]]', '', 'g') as t, ord
            from regexp_split_to_table(split_part(coalesce(em, ''), '@', 1), '[-._+0-9]+') with ordinality r(x, ord)) s
   where s.t <> '';
  if toks is null then return 'Студент'; end if;
  t1 := left(toks[1], 20);
  t2 := toks[2];
  return upper(left(t1, 1)) || lower(substr(t1, 2)) || case when t2 is null then '' else ' ' || upper(left(t2, 1)) || '.' end;
end $$;
revoke execute on function private.rating_name(uuid) from public, anon, authenticated;

-- The ranked table of one week for one metric; only people who are in it (not hidden, enough answers on enough days).
-- Sorted by the exact value (k), val is rounded for display only.
create or replace function private.rating_ranked(p_metric text, p_week date)
returns table (rn bigint, user_id uuid, val numeric, answers int, points int)
language sql stable security definer set search_path = '' as $$
  select row_number() over (order by c.k, c.answers desc, c.user_id), c.user_id, c.val, c.answers, c.points
    from (select w.user_id, w.answers, w.points,
                 case p_metric
                   when 'points'   then -w.points::numeric
                   when 'accuracy' then -(w.correct::numeric / w.answers)
                   else                 (w.answers - w.correct)::numeric / w.answers
                 end as k,
                 case p_metric
                   when 'points'   then w.points::numeric
                   when 'accuracy' then round(w.correct * 100.0 / w.answers, 1)
                   else                 round((w.answers - w.correct) * 100.0 / w.answers, 1)
                 end as val
            from public.rating_week w left join public.rating_profile p on p.user_id = w.user_id
           where w.week_start = p_week and coalesce(p.mode, 'anon') <> 'hidden'
             and case when p_metric = 'points' then w.points > 0 else w.answers >= 100 and w.active_days >= 2 end) c
$$;
revoke execute on function private.rating_ranked(text, date) from public, anon, authenticated;

-- 1. Send my counts for the current week (replaces my row, never lowers the answers; does nothing if no day is valid).
create or replace function public.corpus_rating_submit(p_days jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); today date := private.rating_today(); ws date := date_trunc('week', today::timestamp)::date;
        k text; v jsonb; d date; n0 numeric; o0 numeric; n numeric; o numeric;
        ta int := 0; tc int := 0; td int := 0; tp int := 0; valid int := 0;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_days is null or jsonb_typeof(p_days) <> 'object' then return; end if;
  if pg_column_size(p_days) > 16384 then return; end if;                              -- not what the app sends
  if (select count(*) from jsonb_object_keys(p_days)) > 31 then return; end if;
  for k, v in select e.key, e.value from jsonb_each(p_days) e loop
    begin
      if k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(jsonb_typeof(v), '') <> 'object'
         or coalesce(jsonb_typeof(v -> 'n'), '') <> 'number' or coalesce(jsonb_typeof(v -> 'ok'), '') <> 'number' then
        continue;
      end if;
      d := k::date;
      if d < ws or d > today then continue; end if;
      n0 := greatest(floor((v ->> 'n')::numeric), 0);
      o0 := greatest(floor((v ->> 'ok')::numeric), 0);
      n := least(n0, 400);
      o := least(case when n0 > 400 then floor(o0 * 400 / n0) else o0 end, n);          -- more than 400: keep the share of correct
      ta := ta + n::int; tc := tc + o::int; tp := tp + least(o, 150)::int;
      if n > 0 then td := td + 1; end if;
      valid := valid + 1;
    exception when others then
      null;                                                                          -- a malformed day is skipped
    end;
  end loop;
  if valid = 0 then return; end if;
  insert into public.rating_profile (user_id) values (uid) on conflict (user_id) do nothing;
  insert into public.rating_week (user_id, week_start, answers, correct, active_days, points, updated_at)
    values (uid, ws, ta, tc, td, tp, now())
  on conflict (user_id, week_start) do update
    set answers = excluded.answers, correct = excluded.correct, active_days = excluded.active_days,
        points = excluded.points, updated_at = excluded.updated_at
    where excluded.answers >= public.rating_week.answers;                            -- an out-of-date device cannot lower the week
  delete from public.rating_week where week_start < today - 56;
end $$;
revoke execute on function public.corpus_rating_submit(jsonb) from public, anon;
grant execute on function public.corpus_rating_submit(jsonb) to authenticated;

-- 2. How I am shown: anon / real / alias / hidden. Also marks that the person has been asked.
create or replace function public.corpus_rating_set_profile(p_mode text, p_alias text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); a text;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('anon', 'real', 'alias', 'hidden') then raise exception 'bad_mode' using errcode = '22023'; end if;
  if p_mode = 'alias' then
    a := btrim(p_alias);
    if a is null or char_length(a) not between 2 and 20 or a !~ '^[[:alnum:] ._-]+$' or a !~ '[[:alnum:]]' then
      raise exception 'bad_alias' using errcode = '22023';
    end if;
  end if;
  insert into public.rating_profile (user_id, mode, alias, asked, updated_at) values (uid, p_mode, a, true, now())
  on conflict (user_id) do update set mode = excluded.mode, alias = excluded.alias, asked = true, updated_at = now();
  return jsonb_build_object('mode', p_mode, 'alias', a, 'name', private.rating_name(uid));
end $$;
revoke execute on function public.corpus_rating_set_profile(text, text) from public, anon;
grant execute on function public.corpus_rating_set_profile(text, text) to authenticated;

-- 3. A table: top 10, and me with three people above and below. The table is ranked once per call.
create or replace function public.corpus_rating_get(p_metric text default 'points') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); today date := private.rating_today(); ws date := date_trunc('week', today::timestamp)::date;
        v_mode text; v_asked boolean; v_ans int; v_pts int;
        v_rn bigint; v_val numeric; v_tot bigint; v_top jsonb; v_around jsonb;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_metric is null or p_metric not in ('points', 'accuracy', 'errors') then raise exception 'bad_metric' using errcode = '22023'; end if;
  select p.mode, p.asked into v_mode, v_asked from public.rating_profile p where p.user_id = uid;
  v_mode := coalesce(v_mode, 'anon'); v_asked := coalesce(v_asked, false);
  select w.answers, w.points into v_ans, v_pts from public.rating_week w where w.user_id = uid and w.week_start = ws;
  v_ans := coalesce(v_ans, 0); v_pts := coalesce(v_pts, 0);
  with r as materialized (select * from private.rating_ranked(p_metric, ws)),
       me as (select r.rn, r.val from r where r.user_id = uid)
  select (select count(*) from r), (select me.rn from me), (select me.val from me),
         coalesce((select jsonb_agg(jsonb_build_object('rank', t.rn, 'name', private.rating_name(t.user_id), 'value', t.val, 'me', t.user_id = uid) order by t.rn)
                     from r t where t.rn <= 10), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('rank', t.rn, 'name', private.rating_name(t.user_id), 'value', t.val, 'me', t.user_id = uid) order by t.rn)
                     from r t where t.rn between (select me.rn from me) - 3 and (select me.rn from me) + 3), '[]'::jsonb)
    into v_tot, v_rn, v_val, v_top, v_around;
  return jsonb_build_object('week_start', ws, 'metric', p_metric, 'min_answers', 100, 'min_days', 2, 'total', v_tot,
    'me', jsonb_build_object('rank', v_rn, 'value', v_val, 'answers', v_ans, 'points', v_pts, 'eligible', v_rn is not null,
                             'mode', v_mode, 'asked', v_asked, 'name', private.rating_name(uid)),
    'reward_units', coalesce((select s.value::integer from private.settings s where s.key = 'ai_week_reward' and s.value ~ '^[0-9]{1,6}$'), 20),
    'top', v_top, 'around', v_around);
end $$;
revoke execute on function public.corpus_rating_get(text) from public, anon;
grant execute on function public.corpus_rating_get(text) to authenticated;

-- 4. Forget my results. The person stays hidden (and asked) until they choose again, so the next submit does not publish them.
create or replace function public.corpus_rating_delete_mine() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  delete from public.rating_week where user_id = uid;
  insert into public.rating_profile (user_id, mode, alias, asked, updated_at) values (uid, 'hidden', null, true, now())
  on conflict (user_id) do update set mode = 'hidden', alias = null, asked = true, updated_at = now();
end $$;
revoke execute on function public.corpus_rating_delete_mine() from public, anon;
grant execute on function public.corpus_rating_delete_mine() to authenticated;
