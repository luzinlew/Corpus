-- Rolls back supabase/rating.sql: the weekly rating functions and both tables are removed.
-- Paste into Supabase → SQL Editor → Run. Safe to run again. WARNING: the rating results and everyone's choice of how to be shown
-- are lost. The site then shows no rating (the app handles the missing functions); nothing else is touched.
drop function if exists public.corpus_rating_submit(jsonb);
drop function if exists public.corpus_rating_set_profile(text, text);
drop function if exists public.corpus_rating_get(text);
drop function if exists public.corpus_rating_delete_mine();
drop function if exists private.rating_ranked(text, date);
drop function if exists private.rating_name(uuid);
drop function if exists private.rating_today();
drop table if exists public.rating_week;
drop table if exists public.rating_profile;
