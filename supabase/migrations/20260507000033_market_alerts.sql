-- Market Alerts + Watch Engine.
--
-- Adds polymorphic watchlists, dispatch ledger for dedup, and a
-- 30-min cron that evaluates watches against current market state
-- and inserts notifications via notify().
--
-- v1 alert kinds (deterministic against current state — no price
-- history dependency):
--   new_listing_in_watch    — new listing in watched scope
--   verified_listing        — verification approved in watched scope
--   hot_area                — watched barangay's hot_score >= 0.5
--   fast_moving_inventory   — watched scope's median DOM < 30d
--   trusted_broker_listed   — watched broker posted new listing
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.evaluate_market_watches();
--   DROP TABLE IF EXISTS public.market_alert_dispatches;
--   DROP TABLE IF EXISTS public.market_watches;


-- =====================================================================
-- 1. market_watches — user × polymorphic target × alert_types
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.market_watches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Polymorphic target. Same pattern as reviews (target_type +
  -- target_id text). The text-typed target_id absorbs schema drift
  -- (cities.id is bigint, profiles.id is uuid, etc.) without
  -- per-target FK constraints.
  target_type   text NOT NULL CHECK (target_type IN (
                       'building', 'city', 'barangay',
                       'broker', 'developer', 'organization'
                     )),
  target_id     text NOT NULL,
  -- Per-watch alert subscriptions. Default: all v1 kinds. Users can
  -- narrow this on creation or via PATCH.
  alert_types   text[] NOT NULL DEFAULT ARRAY[
                  'new_listing_in_watch',
                  'verified_listing',
                  'hot_area',
                  'fast_moving_inventory',
                  'trusted_broker_listed'
                ]::text[],
  -- Optional human-readable label so the watchlist UI can show
  -- "BGC luxury" without re-resolving the target name.
  label         text,
  -- Stamped by the evaluator on every successful run that touched
  -- this watch (regardless of whether alerts fired).
  last_evaluated_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS market_watches_user_idx
  ON public.market_watches(user_id);
CREATE INDEX IF NOT EXISTS market_watches_target_idx
  ON public.market_watches(target_type, target_id);

DROP TRIGGER IF EXISTS set_market_watches_updated_at ON public.market_watches;
CREATE TRIGGER set_market_watches_updated_at
  BEFORE UPDATE ON public.market_watches
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.market_watches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS market_watches_select_own ON public.market_watches;
CREATE POLICY market_watches_select_own ON public.market_watches FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.has_permission('admin.access'));

DROP POLICY IF EXISTS market_watches_insert_own ON public.market_watches;
CREATE POLICY market_watches_insert_own ON public.market_watches FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS market_watches_update_own ON public.market_watches;
CREATE POLICY market_watches_update_own ON public.market_watches FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS market_watches_delete_own ON public.market_watches;
CREATE POLICY market_watches_delete_own ON public.market_watches FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR public.has_permission('admin.access'));


-- =====================================================================
-- 2. market_alert_dispatches — append-only dedup ledger
-- =====================================================================
--
-- One row per delivered alert. The evaluator's WHERE clause excludes
-- any (user, kind, subject) tuple dispatched within the cooldown
-- window, preventing duplicate notifications. Append-only;
-- pruned by daily cron after 90 days.

CREATE TABLE IF NOT EXISTS public.market_alert_dispatches (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  watch_id        uuid REFERENCES public.market_watches(id) ON DELETE SET NULL,
  alert_kind      text NOT NULL,
  -- Subject is the specific entity that triggered the alert (the
  -- particular listing, the particular barangay). Two-tuple keeps
  -- dedup tight — different listings in the same building can each
  -- alert once, but the same listing won't alert twice.
  subject_type    text NOT NULL,
  subject_id      text NOT NULL,
  dispatched_at   timestamptz NOT NULL DEFAULT now(),
  -- Optional debug payload — what triggered.
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS market_alert_dispatches_dedup_idx
  ON public.market_alert_dispatches(user_id, alert_kind, subject_type, subject_id, dispatched_at DESC);
CREATE INDEX IF NOT EXISTS market_alert_dispatches_recent_idx
  ON public.market_alert_dispatches(dispatched_at DESC);

ALTER TABLE public.market_alert_dispatches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_alert_dispatches_select_own ON public.market_alert_dispatches;
CREATE POLICY market_alert_dispatches_select_own ON public.market_alert_dispatches FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.has_permission('admin.access'));
-- INSERT/DELETE: SECURITY DEFINER evaluator only.


-- =====================================================================
-- 3. evaluate_market_watches() — the worker RPC
-- =====================================================================
--
-- SECURITY DEFINER so it can read across all watches + write
-- notifications without the calling user's RLS getting in the way.
-- Idempotent — repeated invocations are safe because the dispatch
-- ledger gates dedup.

CREATE OR REPLACE FUNCTION public.evaluate_market_watches()
RETURNS TABLE (
  alert_kind   text,
  user_id      uuid,
  subject_id   text,
  notification_id bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rec record;
  v_notif_id bigint;
  v_title text;
  v_body  text;
  v_href  text;
  v_meta  jsonb;
BEGIN
  -- Caller gate: scheduled cron runs as postgres / supabase_admin /
  -- service_role. Block other invocations.
  IF NOT (session_user IN ('postgres', 'supabase_admin', 'service_role')
          OR public.has_permission('admin.access')) THEN
    RAISE EXCEPTION 'permission denied: evaluate_market_watches is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  -- ---------------------------------------------------------------
  -- 1) new_listing_in_watch
  -- ---------------------------------------------------------------
  -- For each watch with this alert_type, find listings created in
  -- the last 30 minutes that match the target. 24h cooldown per
  -- (user, building/city/barangay/broker).
  FOR rec IN
    WITH live_watches AS (
      SELECT * FROM public.market_watches w
       WHERE 'new_listing_in_watch' = ANY(w.alert_types)
    ),
    candidates AS (
      -- building target
      SELECT
        w.id AS watch_id, w.user_id, w.target_type, w.target_id,
        l.id::text AS listing_id, l.title AS listing_title,
        l.building_id::text AS scope_subject
      FROM live_watches w
      JOIN public.listings l ON l.building_id::text = w.target_id
      WHERE w.target_type = 'building'
        AND l.is_online = true AND l.deleted_at IS NULL
        AND l.created_at > now() - interval '30 minutes'

      UNION ALL

      -- city target
      SELECT
        w.id, w.user_id, w.target_type, w.target_id,
        l.id::text, l.title, l.city_id::text
      FROM live_watches w
      JOIN public.listings l ON l.city_id::text = w.target_id
      WHERE w.target_type = 'city'
        AND l.is_online = true AND l.deleted_at IS NULL
        AND l.created_at > now() - interval '30 minutes'

      UNION ALL

      -- barangay target
      SELECT
        w.id, w.user_id, w.target_type, w.target_id,
        l.id::text, l.title, l.barangay_id::text
      FROM live_watches w
      JOIN public.listings l ON l.barangay_id::text = w.target_id
      WHERE w.target_type = 'barangay'
        AND l.is_online = true AND l.deleted_at IS NULL
        AND l.created_at > now() - interval '30 minutes'

      UNION ALL

      -- broker target
      SELECT
        w.id, w.user_id, w.target_type, w.target_id,
        l.id::text, l.title, l.created_by::text
      FROM live_watches w
      JOIN public.listings l ON l.created_by::text = w.target_id
      WHERE w.target_type = 'broker'
        AND l.is_online = true AND l.deleted_at IS NULL
        AND l.created_at > now() - interval '30 minutes'
    ),
    deduped AS (
      SELECT c.*
      FROM candidates c
      WHERE NOT EXISTS (
        -- 24h cooldown per (user, kind, scope_subject) — at most
        -- one new-listing alert per watched scope per day.
        SELECT 1 FROM public.market_alert_dispatches d
         WHERE d.user_id = c.user_id
           AND d.alert_kind = 'new_listing_in_watch'
           AND d.subject_type = c.target_type
           AND d.subject_id = c.scope_subject
           AND d.dispatched_at > now() - interval '24 hours'
      )
      -- One row per (user, scope) — the cooldown is at scope level,
      -- not per listing, so we pick a representative listing.
      AND c.listing_id = (
        SELECT min(c2.listing_id) FROM candidates c2
         WHERE c2.user_id = c.user_id
           AND c2.target_type = c.target_type
           AND c2.scope_subject = c.scope_subject
      )
    )
    SELECT * FROM deduped
  LOOP
    v_title := 'New listing in your watch';
    v_body  := coalesce(rec.listing_title, 'A listing matching your ' || rec.target_type || ' watch was posted.');
    v_href  := '/listings/' || rec.listing_id;
    v_meta  := jsonb_build_object(
      'watch_id',     rec.watch_id,
      'target_type',  rec.target_type,
      'target_id',    rec.target_id,
      'listing_id',   rec.listing_id,
      'reason',       'new_listing_in_watch'
    );

    INSERT INTO public.notifications (recipient_user_id, kind, title, body, href, metadata, created_at)
    VALUES (rec.user_id, 'market.new_listing_in_watch', v_title, v_body, v_href, v_meta, now())
    RETURNING id INTO v_notif_id;

    INSERT INTO public.market_alert_dispatches
      (user_id, watch_id, alert_kind, subject_type, subject_id, details)
    VALUES (rec.user_id, rec.watch_id, 'new_listing_in_watch',
            rec.target_type, rec.scope_subject,
            jsonb_build_object('listing_id', rec.listing_id));

    alert_kind := 'new_listing_in_watch';
    user_id := rec.user_id;
    subject_id := rec.scope_subject;
    notification_id := v_notif_id;
    RETURN NEXT;
  END LOOP;

  -- ---------------------------------------------------------------
  -- 2) verified_listing
  -- ---------------------------------------------------------------
  FOR rec IN
    WITH live_watches AS (
      SELECT * FROM public.market_watches w
       WHERE 'verified_listing' = ANY(w.alert_types)
    ),
    recent_verifications AS (
      SELECT lv.listing_id, lv.updated_at, l.title, l.building_id, l.city_id, l.barangay_id, l.created_by
      FROM public.listing_verifications lv
      JOIN public.listings l ON l.id = lv.listing_id
      WHERE lv.status = 'verified'
        AND lv.updated_at > now() - interval '1 hour'  -- 30-min cron + 30-min slack
        AND l.is_online = true AND l.deleted_at IS NULL
    ),
    candidates AS (
      SELECT w.id AS watch_id, w.user_id, w.target_type, w.target_id,
             rv.listing_id::text AS listing_id, rv.title AS listing_title
      FROM live_watches w
      JOIN recent_verifications rv ON
        (w.target_type = 'building'  AND rv.building_id::text  = w.target_id)
        OR (w.target_type = 'city'      AND rv.city_id::text      = w.target_id)
        OR (w.target_type = 'barangay'  AND rv.barangay_id::text  = w.target_id)
        OR (w.target_type = 'broker'    AND rv.created_by::text   = w.target_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.market_alert_dispatches d
         WHERE d.user_id = w.user_id
           AND d.alert_kind = 'verified_listing'
           AND d.subject_id = rv.listing_id::text
           AND d.dispatched_at > now() - interval '7 days'
      )
    )
    SELECT * FROM candidates
  LOOP
    v_title := 'Verified listing in your watch';
    v_body  := coalesce(rec.listing_title, 'A verified listing matched your watch.');
    v_href  := '/listings/' || rec.listing_id;
    v_meta  := jsonb_build_object(
      'watch_id', rec.watch_id, 'target_type', rec.target_type,
      'listing_id', rec.listing_id, 'reason', 'verified_listing'
    );

    INSERT INTO public.notifications (recipient_user_id, kind, title, body, href, metadata, created_at)
    VALUES (rec.user_id, 'market.verified_listing', v_title, v_body, v_href, v_meta, now())
    RETURNING id INTO v_notif_id;

    INSERT INTO public.market_alert_dispatches
      (user_id, watch_id, alert_kind, subject_type, subject_id, details)
    VALUES (rec.user_id, rec.watch_id, 'verified_listing', 'listing', rec.listing_id,
            jsonb_build_object('listing_id', rec.listing_id));

    alert_kind := 'verified_listing';
    user_id := rec.user_id;
    subject_id := rec.listing_id;
    notification_id := v_notif_id;
    RETURN NEXT;
  END LOOP;

  -- ---------------------------------------------------------------
  -- 3) hot_area  (watched barangay with hot_score >= 0.5)
  -- ---------------------------------------------------------------
  FOR rec IN
    WITH watched_barangays AS (
      SELECT DISTINCT
        w.id AS watch_id, w.user_id, w.target_id::bigint AS barangay_id
      FROM public.market_watches w
      WHERE w.target_type = 'barangay'
        AND 'hot_area' = ANY(w.alert_types)
    ),
    -- Pull the latest hot_areas snapshot (no city filter — we only
    -- need a row per watched barangay).
    hot_now AS (
      SELECT h.barangay_id, h.hot_score, h.components, h.city_id
      FROM public.market_hot_areas(NULL, 1000) h
      WHERE h.hot_score >= 0.5
    )
    SELECT
      wb.watch_id, wb.user_id, wb.barangay_id::text AS barangay_id_text,
      hn.hot_score, hn.components, hn.city_id
    FROM watched_barangays wb
    JOIN hot_now hn ON hn.barangay_id = wb.barangay_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.market_alert_dispatches d
       WHERE d.user_id = wb.user_id
         AND d.alert_kind = 'hot_area'
         AND d.subject_id = wb.barangay_id::text
         AND d.dispatched_at > now() - interval '7 days'
    )
  LOOP
    v_title := '🔥 Watched area is heating up';
    v_body  := 'Hot score: ' || rec.hot_score::text || '. Top signals in components.';
    v_href  := '/market?city_id=' || coalesce(rec.city_id::text, '');
    v_meta  := jsonb_build_object(
      'watch_id',    rec.watch_id,
      'barangay_id', rec.barangay_id_text,
      'hot_score',   rec.hot_score,
      'components',  rec.components,
      'reason',      'hot_area'
    );

    INSERT INTO public.notifications (recipient_user_id, kind, title, body, href, metadata, created_at)
    VALUES (rec.user_id, 'market.hot_area', v_title, v_body, v_href, v_meta, now())
    RETURNING id INTO v_notif_id;

    INSERT INTO public.market_alert_dispatches
      (user_id, watch_id, alert_kind, subject_type, subject_id, details)
    VALUES (rec.user_id, rec.watch_id, 'hot_area', 'barangay', rec.barangay_id_text,
            jsonb_build_object('hot_score', rec.hot_score, 'components', rec.components));

    alert_kind := 'hot_area';
    user_id := rec.user_id;
    subject_id := rec.barangay_id_text;
    notification_id := v_notif_id;
    RETURN NEXT;
  END LOOP;

  -- ---------------------------------------------------------------
  -- 4) fast_moving_inventory  (watched scope's median DOM < 30d)
  -- ---------------------------------------------------------------
  -- Reuses public.market_velocity (per-segment view from mig 28).
  -- 14d cooldown — DOM doesn't move that fast.
  FOR rec IN
    SELECT
      w.id AS watch_id, w.user_id, w.target_type, w.target_id,
      mv.median_dom_days, mv.absorption_rate_30d
    FROM public.market_watches w
    JOIN public.market_velocity mv ON
      (w.target_type = 'city' AND mv.city_id::text = w.target_id)
    WHERE 'fast_moving_inventory' = ANY(w.alert_types)
      AND mv.median_dom_days < 30
      AND mv.deals_closed_30d > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.market_alert_dispatches d
         WHERE d.user_id = w.user_id
           AND d.alert_kind = 'fast_moving_inventory'
           AND d.subject_id = w.target_id
           AND d.dispatched_at > now() - interval '14 days'
      )
  LOOP
    v_title := '📈 Fast-moving inventory in your watch';
    v_body  := 'Median DOM: ' || rec.median_dom_days::text || ' days. Absorption: '
               || round(coalesce(rec.absorption_rate_30d, 0) * 100, 1)::text || '%';
    v_href  := '/market';
    v_meta  := jsonb_build_object(
      'watch_id', rec.watch_id, 'target_type', rec.target_type,
      'median_dom_days', rec.median_dom_days,
      'absorption_rate_30d', rec.absorption_rate_30d,
      'reason', 'fast_moving_inventory'
    );

    INSERT INTO public.notifications (recipient_user_id, kind, title, body, href, metadata, created_at)
    VALUES (rec.user_id, 'market.fast_moving_inventory', v_title, v_body, v_href, v_meta, now())
    RETURNING id INTO v_notif_id;

    INSERT INTO public.market_alert_dispatches
      (user_id, watch_id, alert_kind, subject_type, subject_id, details)
    VALUES (rec.user_id, rec.watch_id, 'fast_moving_inventory',
            rec.target_type, rec.target_id,
            jsonb_build_object('median_dom_days', rec.median_dom_days));

    alert_kind := 'fast_moving_inventory';
    user_id := rec.user_id;
    subject_id := rec.target_id;
    notification_id := v_notif_id;
    RETURN NEXT;
  END LOOP;

  -- ---------------------------------------------------------------
  -- 5) trusted_broker_listed  — covered by new_listing_in_watch when
  -- target_type='broker'. The kind is the same alert; we leave the
  -- canonical alert as new_listing_in_watch for brokers and skip
  -- a separate trusted_broker_listed dispatch to avoid duplicates.
  -- ---------------------------------------------------------------

  -- Stamp last_evaluated_at on every watch we touched this run.
  UPDATE public.market_watches
     SET last_evaluated_at = now()
   WHERE last_evaluated_at IS NULL
      OR last_evaluated_at < now() - interval '30 minutes';
END;
$$;
GRANT EXECUTE ON FUNCTION public.evaluate_market_watches() TO authenticated;


-- =====================================================================
-- 4. Cron — evaluate every 30 minutes; prune dispatch log nightly
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('evaluate_market_watches_30min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'evaluate_market_watches_30min');
    PERFORM cron.schedule(
      'evaluate_market_watches_30min',
      '*/30 * * * *',
      'SELECT count(*) FROM public.evaluate_market_watches();'
    );

    PERFORM cron.unschedule('market_alert_dispatches_prune_daily')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'market_alert_dispatches_prune_daily');
    PERFORM cron.schedule(
      'market_alert_dispatches_prune_daily',
      '40 3 * * *',
      $cmd$
        DELETE FROM public.market_alert_dispatches
         WHERE dispatched_at < now() - interval '90 days';
      $cmd$
    );
  END IF;
END $$;


-- =====================================================================
-- 5. Governance + permissions
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.market_watches',            'table',    'userportal', ARRAY['userportal'],
   'Per-user polymorphic watchlist (building/city/barangay/broker/developer/organization).', false),
  ('public.market_alert_dispatches',   'table',    'userportal', ARRAY['userportal'],
   'Append-only ledger of delivered alerts. Powers cooldowns + dedup.', false),
  ('public.evaluate_market_watches',   'function', 'userportal', ARRAY['userportal'],
   'Cron-driven worker that scans market_watches and emits notifications.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
