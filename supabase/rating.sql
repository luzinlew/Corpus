-- Corpus: weekly student rating. Paste into Supabase → SQL Editor → Run. Safe to run again.
--
-- What it adds: one shared leaderboard for all students. The week runs Monday to Sunday by Tallinn time and starts from zero every
-- Monday. Everybody takes part by default and can switch to a nickname or hide (the site asks once, on first visit).
--   * the app sends its per-day counts, {"YYYY-MM-DD": {"n": answers, "ok": correct}}, for the current week only;
--   * a day counts at most 400 answers; for the "correct this week" table at most 150 correct answers a day (the cap);
--   * three tables: correct this week (points) / prepared (share of correct) / fewer mistakes (share of wrong); the two shares need
--     at least 100 answers in the week;
--   * hidden people are not in any table; the table never shows an email or a user id, only a display name;
--   * rows older than 8 weeks are deleted on every submit.
-- Nothing is readable from the tables directly (RLS on, no policies, no grants): everything goes through the functions below.
-- The old version of the site does not call them, so it keeps working as before.
--
-- Display name: the nickname if chosen; otherwise taken from the email's local part, split on . _ - + and digits:
--   lev.luzin@x.ee -> "Lev L.", luzinlew@gmail.com -> "Luzinlew"; no letters -> "Студент".
--
-- To remove everything this file adds: supabase/rating_rollback.sql (the rating results are lost).

create schema if not exists private;

create table if not exists public.rating_profile (
  user_id    uuid primary key references auth.users on delete cascade,
  mode       text not null default 'real' check (mode in ('real', 'alias', 'hidden')),
  alias      text,
  asked      boolean not null default false,
  updated_at timestamptz default now()
);
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
declare m text; a text; em text; toks text[]; t1 text; t2 text;
begin
  select p.mode, p.alias into m, a from public.rating_profile p where p.user_id = p_uid;
  if m = 'alias' and a is not null and a <> '' then return a; end if;
  select u.email into em from auth.users u where u.id = p_uid;
  select array_agg(s.x order by s.ord) into toks
    from regexp_split_to_table(split_part(coalesce(em, ''), '@', 1), '[-._+0-9]+') with ordinality s(x, ord)
   where s.x ~ '[[:alpha:]]';
  if toks is null then return 'Студент'; end if;
  t1 := left(toks[1], 20);
  t2 := toks[2];
  return upper(left(t1, 1)) || lower(substr(t1, 2)) || case when t2 is null then '' else ' ' || upper(left(t2, 1)) || '.' end;
end $$;
revoke execute on function private.rating_name(uuid) from public, anon, authenticated;

-- The ranked table of one week for one metric; only people who are in it (not hidden, enough answers).
create or replace function private.rating_ranked(p_metric text, p_week date)
returns table (rn bigint, user_id uuid, val numeric, answers int, points int)
language sql stable security definer set search_path = '' as $$
  select row_number() over (order by case when p_metric = 'errors' then c.val else -c.val end, c.answers desc, c.user_id),
         c.user_id, c.val, c.answers, c.points
    from (select w.user_id, w.answers, w.points,
                 case p_metric
                   when 'points'   then w.points::numeric
                   when 'accuracy' then round(w.correct * 100.0 / w.answers, 1)
                   else                 round((w.answers - w.correct) * 100.0 / w.answers, 1)
                 end as val
            from public.rating_week w left join public.rating_profile p on p.user_id = w.user_id
           where w.week_start = p_week and coalesce(p.mode, 'real') <> 'hidden'
             and case when p_metric = 'points' then w.points > 0 else w.answers >= 100 end) c
$$;
revoke execute on function private.rating_ranked(text, date) from public, anon, authenticated;

-- 1. Send my counts for the current week (replaces my row, does not add to it).
create or replace function public.corpus_rating_submit(p_days jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); today date := private.rating_today(); ws date := date_trunc('week', private.rating_today())::date;
        k text; v jsonb; d date; n numeric; o numeric; ta int := 0; tc int := 0; td int := 0; tp int := 0;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_days is null or jsonb_typeof(p_days) <> 'object' then return; end if;
  if (select count(*) from jsonb_object_keys(p_days)) > 366 then return; end if;     -- not what the app sends
  for k, v in select e.key, e.value from jsonb_each(p_days) e loop
    begin
      if k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(jsonb_typeof(v), '') <> 'object'
         or coalesce(jsonb_typeof(v -> 'n'), '') <> 'number' or coalesce(jsonb_typeof(v -> 'ok'), '') <> 'number' then
        continue;
      end if;
      d := k::date;
      if d < ws or d > today then continue; end if;
      n := least(greatest(floor((v ->> 'n')::numeric), 0), 400);
      o := least(greatest(floor((v ->> 'ok')::numeric), 0), n);
      ta := ta + n::int; tc := tc + o::int; tp := tp + least(o, 150)::int;
      if n > 0 then td := td + 1; end if;
    exception when others then
      null;                                                                          -- a malformed day is skipped
    end;
  end loop;
  insert into public.rating_profile (user_id) values (uid) on conflict (user_id) do nothing;
  insert into public.rating_week (user_id, week_start, answers, correct, active_days, points, updated_at)
    values (uid, ws, ta, tc, td, tp, now())
  on conflict (user_id, week_start) do update
    set answers = excluded.answers, correct = excluded.correct, active_days = excluded.active_days,
        points = excluded.points, updated_at = excluded.updated_at;
  delete from public.rating_week where week_start < today - 56;
end $$;
revoke execute on function public.corpus_rating_submit(jsonb) from public, anon;
grant execute on function public.corpus_rating_submit(jsonb) to authenticated;

-- 2. How I am shown: real / alias / hidden. Also marks that the person has been asked.
create or replace function public.corpus_rating_set_profile(p_mode text, p_alias text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); a text;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('real', 'alias', 'hidden') then raise exception 'bad_mode' using errcode = '22023'; end if;
  if p_mode = 'alias' then
    a := btrim(p_alias);
    if a is null or char_length(a) not between 2 and 20 or a !~ '^[[:alnum:] ._-]+$' then
      raise exception 'bad_alias' using errcode = '22023';
    end if;
  end if;
  insert into public.rating_profile (user_id, mode, alias, asked, updated_at) values (uid, p_mode, a, true, now())
  on conflict (user_id) do update set mode = excluded.mode, alias = excluded.alias, asked = true, updated_at = now();
  return jsonb_build_object('mode', p_mode, 'alias', a, 'name', private.rating_name(uid));
end $$;
revoke execute on function public.corpus_rating_set_profile(text, text) from public, anon;
grant execute on function public.corpus_rating_set_profile(text, text) to authenticated;

-- 3. A table: top 10, and me with three people above and below.
create or replace function public.corpus_rating_get(p_metric text default 'points') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ws date; v_mode text; v_asked boolean; v_ans int; v_pts int;
        v_rn bigint; v_val numeric; v_tot bigint; v_top jsonb; v_around jsonb := '[]'::jsonb;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_metric is null or p_metric not in ('points', 'accuracy', 'errors') then raise exception 'bad_metric' using errcode = '22023'; end if;
  ws := date_trunc('week', private.rating_today())::date;
  select p.mode, p.asked into v_mode, v_asked from public.rating_profile p where p.user_id = uid;
  v_mode := coalesce(v_mode, 'real'); v_asked := coalesce(v_asked, false);
  select w.answers, w.points into v_ans, v_pts from public.rating_week w where w.user_id = uid and w.week_start = ws;
  v_ans := coalesce(v_ans, 0); v_pts := coalesce(v_pts, 0);
  select count(*), max(r.rn) filter (where r.user_id = uid), max(r.val) filter (where r.user_id = uid)
    into v_tot, v_rn, v_val from private.rating_ranked(p_metric, ws) r;
  select coalesce(jsonb_agg(jsonb_build_object('rank', t.rn, 'name', private.rating_name(t.user_id), 'value', t.val, 'me', t.user_id = uid) order by t.rn), '[]'::jsonb)
    into v_top from private.rating_ranked(p_metric, ws) t where t.rn <= 10;
  if v_rn is not null then
    select coalesce(jsonb_agg(jsonb_build_object('rank', t.rn, 'name', private.rating_name(t.user_id), 'value', t.val, 'me', t.user_id = uid) order by t.rn), '[]'::jsonb)
      into v_around from private.rating_ranked(p_metric, ws) t where t.rn between v_rn - 3 and v_rn + 3;
  end if;
  return jsonb_build_object('week_start', ws, 'metric', p_metric, 'min_answers', 100, 'total', v_tot,
    'me', jsonb_build_object('rank', v_rn, 'value', v_val, 'answers', v_ans, 'points', v_pts, 'eligible', v_rn is not null,
                             'mode', v_mode, 'asked', v_asked, 'name', private.rating_name(uid)),
    'top', v_top, 'around', v_around);
end $$;
revoke execute on function public.corpus_rating_get(text) from public, anon;
grant execute on function public.corpus_rating_get(text) to authenticated;

-- 4. Delete everything the rating knows about me.
create or replace function public.corpus_rating_delete_mine() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  delete from public.rating_week where user_id = uid;
  delete from public.rating_profile where user_id = uid;
end $$;
revoke execute on function public.corpus_rating_delete_mine() from public, anon;
grant execute on function public.corpus_rating_delete_mine() to authenticated;
