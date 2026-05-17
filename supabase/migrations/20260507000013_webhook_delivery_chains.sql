-- Thread retry attempts together via delivery_chain_id.
--
-- Today every retry writes its own webhook_deliveries row, but there
-- is no way to recognize that "attempt 1: 502, attempt 2: 502, attempt
-- 3: 200" are the SAME logical event. The admin panel renders them as
-- three sequential unrelated rows. This migration threads them.
--
-- WHAT GETS ADDED:
--   webhook_deliveries.delivery_chain_id  uuid NOT NULL
--     Identifies the logical event. Initial dispatch generates a fresh
--     uuid; all retries of that same event log new delivery rows with
--     the same chain id.
--
--   webhook_retry_queue.delivery_chain_id uuid NOT NULL
--     Stores the chain id while the work is queued so the worker can
--     stamp the same id on each retry's audit row.
--
-- BACKFILL POLICY:
-- DEFAULT gen_random_uuid() means historical rows get a unique id per
-- row on apply — i.e., every legacy row becomes a chain-of-1, which is
-- the correct semantic: pre-retry-feature events were single-attempt
-- by definition. No retroactive grouping happens (we can't reconstruct
-- which old rows were retries of each other), but the going-forward
-- chain semantics are clean.
--
-- ROLLBACK:
--   ALTER TABLE public.webhook_retry_queue
--     DROP COLUMN IF EXISTS delivery_chain_id;
--   ALTER TABLE public.webhook_deliveries
--     DROP COLUMN IF EXISTS delivery_chain_id;
--
-- DEPENDS ON:
--   20260507000002 (webhook_deliveries, webhook_subscriptions)
--   20260507000011 (webhook_retry_queue)


-- =====================================================================
-- 1. webhook_deliveries
-- =====================================================================

ALTER TABLE public.webhook_deliveries
  ADD COLUMN IF NOT EXISTS delivery_chain_id uuid NOT NULL DEFAULT gen_random_uuid();

-- Hot index for the per-subscription deliveries query the UI runs —
-- it's now joining/grouping on chain_id within a subscription scope.
-- Partial-by-time isn't useful here; the existing
-- webhook_deliveries_sub_recent_idx already covers the time-ordering.
-- Adding a chain index keeps the GROUP BY in the UI cheap.
CREATE INDEX IF NOT EXISTS webhook_deliveries_chain_idx
  ON public.webhook_deliveries (delivery_chain_id);

COMMENT ON COLUMN public.webhook_deliveries.delivery_chain_id IS
  'Threads retry attempts of the same logical event. First-attempt rows generate a fresh uuid; retries write new rows reusing the parent chain_id. Pre-20260507000013 rows are chains-of-1 (each historical row got a unique id at apply time).';


-- =====================================================================
-- 2. webhook_retry_queue
-- =====================================================================

ALTER TABLE public.webhook_retry_queue
  ADD COLUMN IF NOT EXISTS delivery_chain_id uuid NOT NULL DEFAULT gen_random_uuid();

COMMENT ON COLUMN public.webhook_retry_queue.delivery_chain_id IS
  'Chain id stamped onto each subsequent retry attempt''s webhook_deliveries row, so the audit log threads back to the original first attempt.';


NOTIFY pgrst, 'reload schema';
