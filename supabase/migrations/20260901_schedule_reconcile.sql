-- ============================================================
-- Schedule the auto-reconcile edge function via pg_cron + pg_net.
-- Replaces the Node server's `node-cron` job (server.js) so NO
-- always-on process is needed — Supabase Postgres owns the schedule.
--
-- Requires the pg_cron and pg_net extensions (both available on
-- Supabase Free / Pro via Dashboard -> Database -> Extensions).
--
-- !!! SECURITY: this repo is PUBLIC, so the real RECONCILE_KEY is
-- intentionally NOT stored here. The job was applied to the DB
-- with the real key and is already running (verify: select * from
-- cron.job). If you re-apply this file, replace the placeholder
-- with the RECONCILE_KEY from your .env / GitHub secret.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop the old schedule first so re-running this file
-- never creates a duplicate job.
select cron.unschedule('reconcile-pending-orders') where exists (
  select 1 from cron.job where jobname = 'reconcile-pending-orders'
);

select cron.schedule(
  'reconcile-pending-orders',
  '*/2 * * * *',           -- every 2 minutes (same cadence as the Node cron)
  $$
  select net.http_post(
    url := 'https://lraryzkamshicildghdv.supabase.co/functions/v1/reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-reconcile-key', '<REPLACE_WITH_YOUR_RECONCILE_KEY>'
    ),
    body := '{}'
  )
  $$
);

-- Verify the job is scheduled:
-- select jobid, jobname, schedule, active from cron.job order by jobid;
