-- Corpus web: passing a deck or a folder to another person by a short code / QR code.
-- Paste into Supabase → SQL Editor → Run. Safe to run again.
--
-- The author's device stores a snapshot of the deck (names, frames, text cards, photo ids — no
-- progress) in public.shares under a random 10-letter code. Anyone signed in who has the code
-- (a link https://corpusapp.ee/?s=<code>, usually scanned as a QR) gets a copy: the photos are read from
-- the public bucket and uploaded again into the receiver's own Corpus. One share per source (deck or
-- folder): opening "Share by QR" again refreshes the snapshot and keeps the code; "Revoke" deletes it.

create table if not exists public.shares (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  src text not null,                       -- 'deck:<id>' or 'folder:<id>' in the owner's Corpus
  code text not null unique,
  kind text not null,                      -- 'deck' | 'folder'
  name text not null default '',
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  opens integer not null default 0,
  primary key (owner, src)
);
alter table public.shares enable row level security;
drop policy if exists "own shares" on public.shares;
create policy "own shares" on public.shares for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));
grant select, insert, update, delete on public.shares to authenticated;

-- a code that is easy to read out and to type: no 0/o, 1/l/i
create or replace function public.corpus_share_code() returns text
language plpgsql volatile set search_path = '' as $$
declare a constant text := '23456789abcdefghjkmnpqrstuvwxyz'; h bytea; r text := ''; i integer;
begin
  h := decode(md5(gen_random_uuid()::text || clock_timestamp()::text), 'hex');
  for i in 0..9 loop
    r := r || substr(a, 1 + (get_byte(h, i) % 31), 1);
  end loop;
  return r;
end $$;
revoke execute on function public.corpus_share_code() from public, anon;
grant execute on function public.corpus_share_code() to authenticated;

-- publish or refresh my share of one deck / folder; the code stays the same for the same source
create or replace function public.corpus_share_put(p_src text, p_kind text, p_name text, p_data jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_code text; v_created timestamptz; v_try integer := 0;
begin
  if p_src is null or p_src = '' or p_kind not in ('deck', 'folder') then
    raise exception 'share_bad_request' using errcode = '22023';
  end if;
  if pg_column_size(p_data) > 6 * 1024 * 1024 then
    raise exception 'share_too_large' using errcode = '54000';
  end if;
  select code, created_at into v_code, v_created from public.shares where owner = (select auth.uid()) and src = p_src;
  if v_code is null then
    loop   -- row-level security hides other people's codes, so a (very unlikely) clash shows up as a unique violation
      v_code := public.corpus_share_code();
      begin
        insert into public.shares (owner, src, code, kind, name, data)
          values ((select auth.uid()), p_src, v_code, p_kind, left(coalesce(p_name, ''), 200), p_data)
          returning created_at into v_created;
        exit;
      exception when unique_violation then
        v_try := v_try + 1;
        if v_try > 5 then raise; end if;
      end;
    end loop;
  else
    update public.shares set kind = p_kind, name = left(coalesce(p_name, ''), 200), data = p_data, updated_at = now()
     where owner = (select auth.uid()) and src = p_src;
  end if;
  return jsonb_build_object('code', v_code, 'createdAt', v_created);
end $$;
revoke execute on function public.corpus_share_put(text, text, text, jsonb) from public, anon;
grant execute on function public.corpus_share_put(text, text, text, jsonb) to authenticated;

-- what somebody shared under this code (any signed-in person who has the code). Counts the opening.
-- The author is shown as a masked e-mail (le***@example.com): codes travel through group chats.
create or replace function public.corpus_share_open(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record;
begin
  if (select auth.uid()) is null then
    raise exception 'share_sign_in' using errcode = '42501';
  end if;
  select sh.owner, sh.kind, sh.name, sh.data, sh.created_at, sh.updated_at, u.email
    into s
    from public.shares sh join auth.users u on u.id = sh.owner
   where sh.code = lower(trim(coalesce(p_code, '')));
  if not found then
    raise exception 'share_not_found' using errcode = 'P0002';
  end if;
  update public.shares set opens = opens + 1 where code = lower(trim(p_code));
  return jsonb_build_object('kind', s.kind, 'name', s.name, 'data', s.data, 'createdAt', s.created_at, 'updatedAt', s.updated_at,
                            'from', left(s.email, 2) || '***@' || split_part(s.email, '@', 2), 'mine', s.owner = (select auth.uid()));
end $$;
revoke execute on function public.corpus_share_open(text) from public, anon;
grant execute on function public.corpus_share_open(text) to authenticated;
