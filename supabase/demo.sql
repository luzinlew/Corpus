-- Corpus demo mode: a few AI requests for people who look around without an account (the "Demo" button on the
-- sign-in screen). Paste into Supabase → SQL Editor → Run. Safe to run again.
-- Counted per visitor address (the Edge Function passes a salted hash, never the address itself) per day, plus a cap for the
-- whole demo per day. Only the Edge Function (service role) can call it.
--   per visitor:  update private.settings set value = '5'   where key = 'ai_demo_per_visitor';
--   whole demo:   update private.settings set value = '150' where key = 'ai_demo_global';
create schema if not exists private;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('ai_demo_per_visitor', '5') on conflict (key) do nothing;
insert into private.settings (key, value) values ('ai_demo_global', '150') on conflict (key) do nothing;

create table if not exists private.ai_demo (
  day date not null,
  visitor text not null,
  used integer not null default 0,
  primary key (day, visitor)
);

-- Takes p_units of today's demo allowance for this visitor, atomically. p_units = 0 just reports.
create or replace function public.corpus_demo_take(p_visitor text, p_units integer default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d date := (now() at time zone 'Europe/Tallinn')::date;
  lim integer; gl integer; cu integer; gcur integer;
begin
  if p_visitor is null or length(p_visitor) < 8 or length(p_visitor) > 128 then raise exception 'bad_visitor' using errcode = '22023'; end if;
  if p_units is null or p_units < 0 or p_units > 20 then raise exception 'bad_units' using errcode = '22023'; end if;
  select coalesce(nullif(value, '')::integer, 5) into lim from private.settings where key = 'ai_demo_per_visitor';
  lim := coalesce(lim, 5);
  insert into private.ai_demo (day, visitor, used) values (d, p_visitor, 0) on conflict (day, visitor) do nothing;
  select used into cu from private.ai_demo where day = d and visitor = p_visitor for update;
  if cu + p_units > lim then
    return jsonb_build_object('ok', false, 'plan', 'demo', 'limit', lim, 'used', cu);
  end if;
  if p_units > 0 then
    select coalesce(nullif(value, '')::integer, 150) into gl from private.settings where key = 'ai_demo_global';
    gl := coalesce(gl, 150);
    -- the day's total over all visitors (rows of one day are few: one per visitor)
    if (select coalesce(sum(used), 0) from private.ai_demo where day = d) + p_units > gl then
      return jsonb_build_object('ok', false, 'plan', 'demo', 'limit', lim, 'used', cu, 'global', true);
    end if;
    update private.ai_demo set used = cu + p_units where day = d and visitor = p_visitor;
    cu := cu + p_units;
  end if;
  return jsonb_build_object('ok', true, 'plan', 'demo', 'limit', lim, 'used', cu);
end $$;
revoke execute on function public.corpus_demo_take(text, integer) from public, anon, authenticated;
grant execute on function public.corpus_demo_take(text, integer) to service_role;
