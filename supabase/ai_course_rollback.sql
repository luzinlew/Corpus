-- Rolls back the course allowance of supabase/ai.sql (section "Course allowance"): the daily allowance, plans and bonus stay as they were.
-- Paste into Supabase → SQL Editor → Run. Safe to run again. The site then pays course requests from the daily allowance
-- (the corpus-ai function falls back to corpus_ai_take when corpus_ai_take_course is gone). The usage numbers of ai_course are lost.
drop function if exists public.corpus_ai_take_course(integer);
drop table if exists public.ai_course;
drop table if exists private.ai_course_global;
delete from private.settings where key in ('ai_course_free', 'ai_course_global_daily');
