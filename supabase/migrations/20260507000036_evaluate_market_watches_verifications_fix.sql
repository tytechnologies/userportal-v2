-- evaluate_market_watches() — verified_listing branch column-name fix.
--
-- Mig 33 referenced `lv.updated_at` and `lv.status = 'verified'` in
-- the verified_listing branch, but listing_verifications (mig 18)
-- has neither: the table has `submitted_at`, `reviewed_at`, and a
-- CHECK constraint allowing only `pending` / `approved` / `rejected`
-- statuses. The cron has been failing every 30 min with:
--   ERROR: column lv.updated_at does not exist
--
-- This migration re-issues the function with:
--   - lv.status = 'verified'      → lv.status = 'approved'
--   - lv.updated_at > ...         → lv.reviewed_at > ...
-- Other branches unchanged. CREATE OR REPLACE FUNCTION — no DDL on
-- tables, no migration of data.
--
-- ROLLBACK: re-apply mig 33's function body (which is itself broken,
-- so don't).

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
  IF NOT (session_user IN ('postgres', 'supabase_admin', 'service_role')
          OR public.has_permission('admin.access')) THEN
    RAISE EXCEPTION 'permission denied: evaluate_market_watches is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  -- ---------------------------------------------------------------
  -- 1) new_listing_in_watch
  -- ---------------------------------------------------------------
  FOR rec IN
    WITH live_watches AS (
      SELECT * FROM public.market_watches w
       WHERE 'new_listing_in_watch' = ANY(w.alert_types)
    ),
    candidates AS (
      SELECT w.id AS watch_id, w.user_id, w.target_type, w.target_id,
             l.id::text AS listing_id, l.title AS listing_title,
             l.building_id::text AS scope_subject
        FROM live_watches w
        JOIN public.listings l ON l.building_id::text = w.target_id
       WHERE w.target_type = 'building'
         AND l.is_online = true AND l.deleted_at IS NULL
         AND l.created_at > now() - interval '30 minutes'
      UNION ALL
      SELECT w.id, w.user_id, w.target_type, w.target_id,
             l.id::text, l.title, l.city_id::text
        FROM live_watches w
        JOIN public.listings l ON l.city_id::text = w.target_id
       WHERE w.target_type = 'city'
         AND l.is_online = true AND l.deleted_at IS NULL
         AND l.created_at > now() - interval '30 minutes'
      UNION ALL
      SELECT w.id, w.user_id, w.target_type, w.target_id,
             l.id::text, l.title, l.barangay_id::text
        FROM live_watches w
        JOIN public.listings l ON l.barangay_id::text = w.target_id
       WHERE w.target_type = 'barangay'
         AND l.is_online = true AND l.deleted_at IS NULL
         AND l.created_at > now() - interval '30 minutes'
      UNION ALL
      SELECT w.id, w.user_id, w.target_type, w.target_id,
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
         SELECT 1 FROM public.market_alert_dispatches d
          WHERE d.user_id = c.user_id
            AND d.alert_kind = 'new_listing_in_watch'
            AND d.subject_type = c.target_type
            AND d.subject_id = c.scope_subject
            AND d.dispatched_at > now() - interval '24 hours'
       )
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
  -- 2) verified_listing — FIXED: status='approved', col=reviewed_at
  -- ---------------------------------------------------------------
  -- listing_verifications schema: (id, listing_id, submitted_by,
  -- status CHECK (pending|approved|rejected), reviewed_by,
  -- reviewed_at, submitted_at, ...). Mig 33 referenced lv.updated_at
  -- (doesn't exist) and lv.status='verified' (not in the CHECK
  -- constraint). Both fixed here.
  FOR rec IN
    WITH live_watches AS (
      SELECT * FROM public.market_watches w
       WHERE 'verified_listing' = ANY(w.alert_types)
    ),
    recent_verifications AS (
      SELECT lv.listing_id, lv.reviewed_at, l.title,
             l.building_id, l.city_id, l.barangay_id, l.created_by
      FROM public.listing_verifications lv
      JOIN public.listings l ON l.id = lv.listing_id
      WHERE lv.status = 'approved'
        AND lv.reviewed_at IS NOT NULL
        AND lv.reviewed_at > now() - interval '1 hour'
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
  -- 3) hot_area
  -- ---------------------------------------------------------------
  FOR rec IN
    WITH watched_barangays AS (
      SELECT DISTINCT
        w.id AS watch_id, w.user_id, w.target_id::bigint AS barangay_id
      FROM public.market_watches w
      WHERE w.target_type = 'barangay'
        AND 'hot_area' = ANY(w.alert_types)
    ),
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
  -- 4) fast_moving_inventory
  -- ---------------------------------------------------------------
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

  UPDATE public.market_watches
     SET last_evaluated_at = now()
   WHERE last_evaluated_at IS NULL
      OR last_evaluated_at < now() - interval '30 minutes';
END;
$$;
GRANT EXECUTE ON FUNCTION public.evaluate_market_watches() TO authenticated;


NOTIFY pgrst, 'reload schema';
