-- Corpus web: one-time database setup. Paste into Supabase → SQL Editor → Run.
-- Safe to run again.

-- 1. Every user's decks, cards and progress. Each row is visible only to its owner.
create table if not exists public.docs (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  coll text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner, coll, id)
);
alter table public.docs enable row level security;
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));
grant select, insert, update, delete on public.docs to authenticated;

-- Recursive merge used by partial updates (nested objects merge, everything else replaces).
create or replace function public.corpus_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; r jsonb;
begin
  if a is null or b is null or jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then
    return b;
  end if;
  r := a;
  for k in select jsonb_object_keys(b) loop
    if jsonb_typeof(r -> k) = 'object' and jsonb_typeof(b -> k) = 'object' then
      r := r || jsonb_build_object(k, public.corpus_merge(r -> k, b -> k));
    else
      r := r || jsonb_build_object(k, b -> k);
    end if;
  end loop;
  return r;
end $$;

create or replace function public.corpus_doc_update(p_coll text, p_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.docs
     set data = public.corpus_merge(data, p_patch), updated_at = now()
   where owner = (select auth.uid()) and coll = p_coll and id = p_id;
  if not found then
    raise exception 'doc_missing' using errcode = 'P0002';
  end if;
end $$;
revoke execute on function public.corpus_doc_update(text, text, jsonb) from public, anon;
grant execute on function public.corpus_doc_update(text, text, jsonb) to authenticated;
grant execute on function public.corpus_merge(jsonb, jsonb) to authenticated;

-- 2. Photos. Names are random ids; each user can upload, and delete only their own.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plates', 'plates', true, 26214400, array['image/*'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "corpus plates insert" on storage.objects;
create policy "corpus plates insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'plates');
drop policy if exists "corpus plates read own" on storage.objects;
create policy "corpus plates read own" on storage.objects for select to authenticated
  using (bucket_id = 'plates' and owner_id = (select auth.uid()::text));
drop policy if exists "corpus plates delete own" on storage.objects;
create policy "corpus plates delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'plates' and owner_id = (select auth.uid()::text));

-- 3. Sign-up only with the invite code from the link (?i=...).
--    Change it later:  update private.settings set value = 'new-code' where key = 'invite';
--    Open sign-up to anyone:  update private.settings set value = '' where key = 'invite';
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('invite', 'p8wyzmtw')
on conflict (key) do update set value = excluded.value;

create or replace function private.corpus_check_invite() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  select value into v from private.settings where key = 'invite';
  if coalesce(v, '') <> '' and coalesce(new.raw_user_meta_data ->> 'invite', '') <> v then
    raise exception 'invite_required';
  end if;
  return new;
end $$;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.corpus_check_invite() to supabase_auth_admin;
drop trigger if exists corpus_check_invite on auth.users;
create trigger corpus_check_invite before insert on auth.users
  for each row execute function private.corpus_check_invite();
