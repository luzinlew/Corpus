-- Corpus: limits per account — how much one person can store. Paste into Supabase → SQL Editor → Run. Safe to run again.
--
-- Why: when sign-up is open, one person could create accounts and fill the project's database (500 MB on the free plan) and
-- photo storage (1 GB). These limits are checked by the database itself, so they hold whatever a client sends.
--
-- The limits live in private.settings. Change one and it applies to the next write, no redeploy:
--   update private.settings set value = '500' where key = 'quota_photos_mb';
--   quota_doc_kb        one document, KB (a pack of cards is at most ~100 KB)       1024
--   quota_docs_count    documents per account                                          20000
--   quota_docs_mb       all documents of an account together, MB                       50
--   quota_photos_mb     all photos of an account together, MB                          300
--   quota_photos_count  photos per account                                             6000
-- A value that is not a plain number is ignored and the default is used. Use a huge number to switch a limit off.
--
-- What it does and does not do:
--   * Nothing that is already stored is changed or deleted.
--   * An account that is over a limit can still read, delete, and save changes that do not make a document bigger
--     (so reviewing cards keeps working); it just cannot add documents, photos or grow documents until it frees space.
--   * Photos are counted when a new one is uploaded: the check sees the photos already stored, so uploads running in parallel can
--     overshoot by a few photos (each is at most the bucket's 25 MB).
--   * Writes without a signed-in person (the Edge Functions' service key, this SQL Editor) are not limited.
--   * These are limits per account. They do not cap the whole project: many accounts still add up (see the README).
--
-- Look before you set the numbers (read-only) — who uses the most now:
--   select u.email, count(*) docs, round(sum(pg_column_size(d.data)) / 1048576.0, 2) mb, max(pg_column_size(d.data)) biggest_doc_bytes
--     from public.docs d join auth.users u on u.id = d.owner group by 1 order by 3 desc limit 10;
--   select u.email, count(*) photos, round(sum((o.metadata ->> 'size')::bigint) / 1048576.0, 1) mb
--     from storage.objects o join auth.users u on u.id::text = o.owner_id where o.bucket_id = 'plates' group by 1 order by 3 desc limit 10;
--
-- To remove everything this file adds:
--   drop trigger if exists corpus_docs_size on public.docs;
--   drop trigger if exists corpus_docs_total_ins on public.docs;
--   drop trigger if exists corpus_docs_total_upd on public.docs;
--   drop policy if exists "corpus plates insert" on storage.objects;
--   create policy "corpus plates insert" on storage.objects for insert to authenticated with check (bucket_id = 'plates');
-- (the functions can stay; they do nothing without the triggers and the policy)

create schema if not exists private;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values
  ('quota_doc_kb', '1024'), ('quota_docs_count', '20000'), ('quota_docs_mb', '50'),
  ('quota_photos_mb', '300'), ('quota_photos_count', '6000')
on conflict (key) do nothing;

-- A limit from the settings; anything but a plain number falls back to the default (a typo must never block every write).
create or replace function private.corpus_quota(p_key text, p_default bigint) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when btrim(value) ~ '^[0-9]{1,15}$' then btrim(value)::bigint end
                     from private.settings where key = p_key), p_default)
$$;

-- 1. One document. Cheap, checked row by row. A document that is already bigger than the limit can still be saved if it does not grow.
create or replace function private.corpus_docs_size() returns trigger
language plpgsql security definer set search_path = '' as $$
declare sz bigint := pg_column_size(new.data);
begin
  if auth.uid() is null then return new; end if;
  if sz > private.corpus_quota('quota_doc_kb', 1024) * 1024 and (tg_op = 'INSERT' or sz > pg_column_size(old.data)) then
    raise exception 'doc_too_large' using errcode = '54000';
  end if;
  return new;
end $$;

-- 2. All documents of an account. Checked once per statement (a batch of 100 documents is one check), only for accounts the statement
-- added documents to or made bigger.
create or replace function private.corpus_docs_check(p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare n bigint; b bigint;
begin
  select count(*), coalesce(sum(pg_column_size(data)), 0) into n, b from public.docs where owner = p_owner;
  if n > private.corpus_quota('quota_docs_count', 20000) or b > private.corpus_quota('quota_docs_mb', 50) * 1048576 then
    raise exception 'user_quota_exceeded' using errcode = '53400';
  end if;
end $$;

create or replace function private.corpus_docs_total_ins() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o uuid;
begin
  if auth.uid() is null then return null; end if;
  for o in select distinct owner from newrows loop perform private.corpus_docs_check(o); end loop;
  return null;
end $$;

create or replace function private.corpus_docs_total_upd() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o uuid;
begin
  if auth.uid() is null then return null; end if;
  for o in
    select n.owner from newrows n join oldrows p on p.owner = n.owner and p.coll = n.coll and p.id = n.id
     group by n.owner having sum(pg_column_size(n.data)) > sum(pg_column_size(p.data))
  loop perform private.corpus_docs_check(o); end loop;
  return null;
end $$;

drop trigger if exists corpus_docs_size on public.docs;
create trigger corpus_docs_size before insert or update on public.docs
  for each row execute function private.corpus_docs_size();
drop trigger if exists corpus_docs_total_ins on public.docs;
create trigger corpus_docs_total_ins after insert on public.docs
  referencing new table as newrows for each statement execute function private.corpus_docs_total_ins();
drop trigger if exists corpus_docs_total_upd on public.docs;
create trigger corpus_docs_total_upd after update on public.docs
  referencing old table as oldrows new table as newrows for each statement execute function private.corpus_docs_total_upd();

-- 3. Photos. The upload policy asks whether the signed-in person still has room.
create or replace function public.corpus_photo_room() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid(); n bigint; b bigint;
begin
  if uid is null then return false; end if;
  select count(*), coalesce(sum(case when (metadata ->> 'size') ~ '^[0-9]{1,15}$' then (metadata ->> 'size')::bigint else 0 end), 0)
    into n, b from storage.objects where bucket_id = 'plates' and owner_id = uid::text;
  return n < private.corpus_quota('quota_photos_count', 6000) and b < private.corpus_quota('quota_photos_mb', 300) * 1048576;
end $$;
revoke execute on function public.corpus_photo_room() from public, anon;
grant execute on function public.corpus_photo_room() to authenticated;

drop policy if exists "corpus plates insert" on storage.objects;
create policy "corpus plates insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'plates' and public.corpus_photo_room());
