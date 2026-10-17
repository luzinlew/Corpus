-- Rolls back the "anon" mode of supabase/rating.sql (everybody is in the rating as "Студент" by default) to the previous model
-- (real / alias / hidden; real shows "Студент" until the person was asked). Paste into Supabase → SQL Editor → Run. Safe to run again.
-- Order of actions:
--   1. (Optional) if you also go back to the activity-based reward, run supabase/reward_rollback.sql. The rating-based reward function
--      works with the old model too, so this step is not needed for the rating itself.
--   2. Run THIS file (data and check constraint).
--   3. Recreate the functions of the previous version: take the file from git (git show 8859174:supabase/rating.sql) and run it in the
--      SQL Editor. Do this right after step 2: until then the current functions still try to write 'anon' (they will fail on the
--      new check), so the rating would be unavailable for a short while.
-- Effect: people shown as "Студент" by default (anon) go back to real + not asked (still shown as "Студент"); those who chose to be shown
-- by their email name, a nickname or hidden keep their choice. People who actively chose "anon" also become real + not asked, i.e.
-- they are asked again and shown as "Студент" until they answer.

update public.rating_profile set mode = 'real', asked = false where mode = 'anon';
alter table public.rating_profile drop constraint if exists rating_profile_mode_check;
alter table public.rating_profile add constraint rating_profile_mode_check check (mode in ('real', 'alias', 'hidden'));
alter table public.rating_profile alter column mode set default 'real';
