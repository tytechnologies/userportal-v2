-- Webhook delivery retry queue.
--
-- Today (20260507000002), the dispatcher is best-effort: one POST,
-- 5s timeout, log the result. Transient failures (5xx, partner
-- network blip, timeout) drop the event with no retry. Auto-disable
-- after 10 consecutive failures protects against permanent breakage,
-- but a 1% partner failure rate still loses 1% of events.
--
-- This migration adds a separate table holding PENDING retries:
--   - Initial dispatch attempts that hit a transient failure enqueue
--     a row here with next_attempt_at = now() + backoff.
--   - A worker (POST /api/admin/webhooks/run-retries, fired by
--     pg_cron every minute) pulls due rows, replays delivery, and
--     either dequeues on success / exhaustion OR reschedules.
--
-- Why a separate table not extra columns on webhook_deliveries:
--   - webhook_deliveries is append-only audit log; mutating its rows
--     would muddy the audit semantics ("did this deliver at attempt 3
--     or attempt 7?").
--   - The queue is small and frequently mutated; deliveries grows
--     unboundedly.
--   - Cleanup pruning policies for the two are different: queue
--     rows die at terminal status, deliveries rows live for the
--     retention window.
--
-- What counts as "retryable":
--   - HTTP 5xx (server errors)
--   - Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
--   - Request timeout (5s AbortController)
-- What counts as "non-retryable" (no enqueue):
--   - HTTP 4xx (partner explicitly rejected — retrying won't help)
--   - Subscription disabled mid-flight (won't accept anyway)
--
-- Failure-counter semantics:
-- consecutive_failures on the subscription increments only when the
-- whole retry CHAIN is exhausted (terminal final failure), NOT per
-- attempt. A delivery with 3 transient failures + 1 success counts as
-- a single success against the counter. A delivery with 6 attempts
-- all failing counts as a single failure. Auto-disable at 10 still
-- means "10 distinct events failed end-to-end", which is the
-- intuitively correct threshold.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.webhook_retry_queue;
--   SELECT cron.unschedule('webhook_retry_queue_drain_minutely')
--     WHERE EXISTS (
--       SELECT 1 FROM cron.job
--        WHERE jobname = 'webhook_retry_queue_drain_minutely'
--     );
--
-- DEPENDS ON: 20260507000002 (webhook_subscriptions, webhook_deliveries)


-- =====================================================================
-- 1. Queue table
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.webhook_retry_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL
                  REFERENCES public.webhook_subscriptions(id) ON DELETE CASCADE,
  event_kind      text NOT NULL,
  payload         jsonb NOT NULL,

  -- 1 on initial enqueue (after the inline first-attempt failure).
  -- Worker increments before each subsequent attempt. Cap defined in
  -- the worker (not enforced here) so changing it doesn't need a
  -- migration.
  attempt_number  integer NOT NULL DEFAULT 1,

  -- Next attempt scheduled for. The worker queries WHERE next_attempt_at
  -- <= now(). Initial enqueue is "now + 60s" (first backoff step).
  next_attempt_at timestamptz NOT NULL DEFAULT (now() + interval '60 seconds'),

  -- Most-recent attempt result, surfaced in /admin Webhooks for
  -- debugging. Updated in place on each retry; the per-attempt audit
  -- row in webhook_deliveries holds the full history.
  last_status     integer,
  last_error      text,

  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot index for the worker's "due rows" query. Partial on
-- next_attempt_at <= now() doesn't cleanly express in an index, so
-- include the timestamp DESC + ordinary B-tree.
CREATE INDEX IF NOT EXISTS webhook_retry_queue_due_idx
  ON public.webhook_retry_queue (next_attempt_at);

CREATE INDEX IF NOT EXISTS webhook_retry_queue_subscription_idx
  ON public.webhook_retry_queue (subscription_id, enqueued_at DESC);

DROP TRIGGER IF EXISTS set_webhook_retry_queue_updated_at
  ON public.webhook_retry_queue;
CREATE TRIGGER set_webhook_retry_queue_updated_at
  BEFORE UPDATE ON public.webhook_retry_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.webhook_retry_queue IS
  'Pending webhook retry work. Rows enter on initial-attempt transient failure, exit on success or attempt-cap exhaustion. The per-attempt audit history lives in webhook_deliveries — this table is mutable work, that one is immutable log.';


-- =====================================================================
-- 2. RLS — admin-only via webhooks.manage
-- =====================================================================

ALTER TABLE public.webhook_retry_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_retry_queue_select_admin ON public.webhook_retry_queue;
CREATE POLICY webhook_retry_queue_select_admin
  ON public.webhook_retry_queue FOR SELECT
  TO authenticated
  USING (public.has_permission('webhooks.manage'));

-- INSERT/UPDATE/DELETE NOT granted to authenticated — service-role
-- only. The worker uses service-role (no JWT in cron context); admin
-- UI just reads.


-- =====================================================================
-- 3. pg_cron job — drain the queue every minute
-- =====================================================================
--
-- The endpoint is /api/admin/webhooks/run-retries, gated by either:
--   - admin JWT (manual triggers)
--   - x-internal-secret header matching INTERNAL_CRON_SECRET
-- The cron path uses the secret. INTERNAL_CRON_SECRET is configured
-- via Vault (the same pattern saved-search digest cron uses).
--
-- We unschedule the existing version first so re-running this
-- migration is idempotent.

DO $$
DECLARE
  v_internal_url text;
  v_internal_secret text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed; webhook retry cron NOT scheduled. Install pg_cron then re-run this migration.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net not installed; webhook retry cron NOT scheduled. Install pg_net then re-run this migration.';
    RETURN;
  END IF;

  -- URL + secret are read from vault.decrypted_secrets at fire time
  -- (NOT inlined into the cron command), so a rotation doesn't need
  -- a migration.
  PERFORM cron.unschedule('webhook_retry_queue_drain_minutely')
    WHERE EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'webhook_retry_queue_drain_minutely'
    );

  PERFORM cron.schedule(
    'webhook_retry_queue_drain_minutely',
    '* * * * *',
    $cmd$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets
                     WHERE name = 'INTERNAL_PORTAL_URL')
                   || '/api/admin/webhooks/run-retries',
        headers := jsonb_build_object(
          'content-type',     'application/json',
          'x-internal-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                                  WHERE name = 'INTERNAL_CRON_SECRET')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 25000
      );
    $cmd$
  );
END $$;


NOTIFY pgrst, 'reload schema';
