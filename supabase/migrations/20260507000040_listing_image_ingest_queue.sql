-- Listing Image Ingest Queue.
--
-- After process_listing_import_batch (mig 39) creates a listing
-- with is_online=false and stamps the row's outcome to
-- 'created_pending_review', a trigger enqueues each captured image
-- URL into listing_image_ingest_queue. A cron-driven internal
-- endpoint drains the queue: fetches each URL, uploads to S3,
-- inserts a listing_images row.
--
-- The QUEUE itself ships in this migration. The cron schedule that
-- pings the internal endpoint also ships. The actual download +
-- S3 upload + listing_images insert is in the Nitro endpoint
-- (server/api/internal/listings/process-image-queue.post.ts).
--
-- Privacy / security:
--   - admin-only RLS
--   - source URLs validated app-side before download
--   - queue prunes daily after 30 days
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS listing_import_rows_enqueue_images
--     ON public.listing_import_rows;
--   DROP FUNCTION IF EXISTS public.fn_enqueue_listing_images_on_create();
--   DROP TABLE IF EXISTS public.listing_image_ingest_queue;


-- =====================================================================
-- 1. listing_image_ingest_queue — pending downloads
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listing_image_ingest_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      bigint NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  source_url      text NOT NULL,
  -- Image position hint (preserves the order from the CSV row).
  position_hint   int,
  -- The import row that originated this URL — for audit + observability.
  origin_row_id   uuid REFERENCES public.listing_import_rows(id) ON DELETE SET NULL,

  -- Lifecycle. Worker flips: pending → processing → done|failed_temporary|failed_permanent.
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'processing',
                       'done', 'failed_temporary', 'failed_permanent', 'skipped'
                     )),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),

  -- Worker stamps these after processing.
  resolved_file_name text,
  resolved_extension text,
  bytes_downloaded   int,
  content_type       text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,

  -- Same source URL twice for the same listing → no-op. Keeps the
  -- queue idempotent against re-imports.
  UNIQUE (listing_id, source_url)
);

-- Hot path: worker pulling next batch by status + next_attempt_at.
CREATE INDEX IF NOT EXISTS listing_image_queue_pending_idx
  ON public.listing_image_ingest_queue(next_attempt_at, status)
  WHERE status IN ('pending', 'failed_temporary');

CREATE INDEX IF NOT EXISTS listing_image_queue_listing_idx
  ON public.listing_image_ingest_queue(listing_id);

ALTER TABLE public.listing_image_ingest_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_image_queue_admin ON public.listing_image_ingest_queue;
CREATE POLICY listing_image_queue_admin ON public.listing_image_ingest_queue FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));
-- Service role bypasses RLS; worker uses it.


-- =====================================================================
-- 2. Trigger — enqueue images when an import row resolves to a listing
-- =====================================================================
--
-- Fires AFTER UPDATE on listing_import_rows when outcome flips to
-- 'created_pending_review' AND a listing was created. Inserts one
-- queue row per URL in NEW.image_urls. Idempotent via the (listing_id,
-- source_url) UNIQUE constraint — re-import of the same listing/URL
-- pair is a no-op.

CREATE OR REPLACE FUNCTION public.fn_enqueue_listing_images_on_create()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  url text;
  pos int := 0;
BEGIN
  IF NEW.outcome <> 'created_pending_review' THEN RETURN NEW; END IF;
  IF NEW.resolved_listing_id IS NULL              THEN RETURN NEW; END IF;
  IF NEW.image_urls IS NULL OR array_length(NEW.image_urls, 1) IS NULL THEN
    RETURN NEW;
  END IF;
  -- Don't re-enqueue if the row update is a no-op transition
  -- (outcome already was 'created_pending_review').
  IF OLD.outcome = NEW.outcome THEN RETURN NEW; END IF;

  FOREACH url IN ARRAY NEW.image_urls LOOP
    pos := pos + 1;
    -- Cheap URL sanity filter at enqueue time.
    IF url IS NULL OR length(url) < 8 OR url NOT LIKE 'http%' THEN
      CONTINUE;
    END IF;
    INSERT INTO public.listing_image_ingest_queue
      (listing_id, source_url, position_hint, origin_row_id)
    VALUES
      (NEW.resolved_listing_id, url, pos, NEW.id)
    ON CONFLICT (listing_id, source_url) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listing_import_rows_enqueue_images
  ON public.listing_import_rows;
CREATE TRIGGER listing_import_rows_enqueue_images
  AFTER UPDATE OF outcome ON public.listing_import_rows
  FOR EACH ROW EXECUTE FUNCTION public.fn_enqueue_listing_images_on_create();


-- =====================================================================
-- 3. Cron — every 2 minutes drain the queue via internal endpoint
-- =====================================================================
--
-- Reuses the established INTERNAL_PORTAL_URL + INTERNAL_CRON_SECRET
-- pattern (vault-stored). The Nitro endpoint validates the secret
-- header before draining.
--
-- The cron only fires the HTTP request; the actual fetch + S3
-- upload + listing_images insert happens in the endpoint, which
-- runs as service-role (bypasses RLS).

DO $$
DECLARE
  v_url    text;
  v_secret text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed; image queue cron NOT scheduled.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net not installed; image queue cron NOT scheduled.';
    RETURN;
  END IF;

  -- Best-effort vault read; fall back to no-op if unset (the
  -- endpoint cron will never fire until the operator sets these).
  BEGIN
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'INTERNAL_PORTAL_URL'   LIMIT 1;
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_CRON_SECRET'  LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_url := NULL; v_secret := NULL;
  END;

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'INTERNAL_PORTAL_URL or INTERNAL_CRON_SECRET not in vault; image queue cron NOT scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('listing_image_queue_drain_2min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'listing_image_queue_drain_2min');

  PERFORM cron.schedule(
    'listing_image_queue_drain_2min',
    '*/2 * * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-internal-secret', %L
        ),
        body := '{}'::jsonb
      );
    $cmd$, rtrim(v_url, '/') || '/api/internal/listings/process-image-queue', v_secret)
  );

  -- Daily prune at 04:50 UTC — drop done/failed_permanent rows >30d
  -- to keep the table bounded.
  PERFORM cron.unschedule('listing_image_queue_prune_daily')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'listing_image_queue_prune_daily');
  PERFORM cron.schedule(
    'listing_image_queue_prune_daily',
    '50 4 * * *',
    $cmd$
      DELETE FROM public.listing_image_ingest_queue
       WHERE status IN ('done', 'failed_permanent', 'skipped')
         AND processed_at < now() - interval '30 days';
    $cmd$
  );
END $$;


-- =====================================================================
-- 4. Governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.listing_image_ingest_queue', 'table', 'userportal', ARRAY['userportal'],
   'Queue of image URLs to fetch + upload to S3 + attach to listings. Drained by /api/internal/listings/process-image-queue every 2 min.', false),
  ('public.fn_enqueue_listing_images_on_create', 'function', 'userportal', ARRAY['userportal'],
   'Trigger function — fires after listing_import_rows.outcome flips to created_pending_review, enqueues each image URL.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
