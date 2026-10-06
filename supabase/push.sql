-- Corpus: push notifications (daily review reminder + reminders before tests).
-- Paste into Supabase → SQL Editor → Run. Safe to run again.
-- Before this, deploy the Edge Function "corpus-push" (supabase/functions/corpus-push/index.ts)
-- with "Verify JWT" switched OFF: the scheduler below calls it without a user token, the function
-- checks its own key instead, and signed-in requests are checked inside the function.

create schema if not exists private;
create table if not exists private.settings (key text primary key, value text not null);

-- The key the scheduler sends to the function (random, made once).
insert into private.settings (key, value)
values ('push_cron_key', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- VAPID keys of the site: made by the function on its first run and kept here.
-- Only the function (service role) can call this.
create or replace function public.corpus_push_cfg(p_pub text default null, p_priv text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_pub, '') <> '' and coalesce(p_priv, '') <> '' then
    insert into private.settings (key, value) values ('vapid_public', p_pub) on conflict (key) do nothing;
    insert into private.settings (key, value) values ('vapid_private', p_priv) on conflict (key) do nothing;
  end if;
  return jsonb_build_object(
    'pub',  (select value from private.settings where key = 'vapid_public'),
    'priv', (select value from private.settings where key = 'vapid_private'),
    'cron', (select value from private.settings where key = 'push_cron_key'));
end $$;
revoke execute on function public.corpus_push_cfg(text, text) from public, anon, authenticated;
grant execute on function public.corpus_push_cfg(text, text) to service_role;

-- Every 15 minutes the function checks who should get a reminder now (in their own time zone).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'corpus-push';
select cron.schedule('corpus-push', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://iymempapqvbwcaclwnvk.supabase.co/functions/v1/corpus-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-corpus-cron', (select value from private.settings where key = 'push_cron_key')),
    body := '{"run":true}'::jsonb,
    timeout_milliseconds := 60000)
$job$);

-- Check:
--   select jobname, schedule, active from cron.job where jobname = 'corpus-push';
--   select status_code, left(content, 200), created from net._http_response order by created desc limit 5;
--   select u.email, count(*) devices from public.docs d join auth.users u on u.id = d.owner where d.coll = 'push' group by 1;
