-- Reconciliation utility for the *_legacy quarantine columns on
-- public.listings. Three columns hold pre-FK string values that
-- couldn't be retyped to uuid:
--   created_by_legacy
--   updated_by_legacy
--   deleted_by_legacy
--
-- This migration adds two SECURITY DEFINER RPCs the admin UI calls:
--
--   legacy_creators_summary()
--     → top-level counts per column + a paginated list of unreconciled
--       rows with the highest-confidence profile match (by
--       lower(full_name) equality, then a fuzzy similarity score for
--       cases like "Laine B." vs "Laine Bordaje").
--
--   legacy_creators_apply(listing_id, target_column, profile_id)
--     → atomically writes profile_id into the canonical FK column
--       (created_by | updated_by | deleted_by) and NULLs the matching
--       *_legacy column. Audited via log_activity().
--
-- Why two RPCs and not direct table writes?
--   - The reconcile UI needs admin-managed access to a reduced view
--     (no listings.contacts notes / remarks / etc.). RPC keeps the
--     surface explicit.
--   - Writing the FK + NULLing _legacy must be one transaction. RPC
--     gives us that without trusting the client to do both UPDATEs.
--   - SECURITY DEFINER + has_permission gate inside the function lets
--     us reject non-admin callers consistently (RLS on listings is
--     more permissive — agents can edit their own rows — and we don't
--     want to expand that surface for this one-off cleanup).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.legacy_creators_apply(bigint, text, uuid);
--   DROP FUNCTION IF EXISTS public.legacy_creators_summary(int, int);
--   DELETE FROM public.permissions WHERE name = 'legacy.reconcile';

-- =====================================================================
-- 1. Permission catalog entry
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('legacy.reconcile',
   'Apply matches between *_legacy quarantine columns and profiles',
   'admin')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'legacy.reconcile')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 2. legacy_creators_summary — counts + paginated suggestions
-- =====================================================================
--
-- Returns:
--   total_unreconciled: per-column non-null counts (jsonb)
--   suggestions:        array of { listing_id, legacy_value,
--                                  target_column, candidates[] }
--   total_suggestions:  unbounded count for pagination
--
-- Match strategy:
--   1. Exact case-insensitive full_name match (highest confidence).
--   2. Fall back to similarity > 0.5 via pg_trgm if available.
--      (We don't enable pg_trgm here — if the extension is absent,
--      the function silently skips fuzzy matches.)
--
-- Pagination is cursor-light: caller passes p_limit + p_offset. The
-- result set is small (hundreds, not millions) so OFFSET is fine.

CREATE OR REPLACE FUNCTION public.legacy_creators_summary(
  p_limit  int DEFAULT 25,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counts jsonb;
  v_suggestions jsonb;
  v_total int;
  v_has_trgm boolean;
BEGIN
  IF NOT public.has_permission('legacy.reconcile') THEN
    RAISE EXCEPTION 'permission denied: legacy.reconcile required'
      USING ERRCODE = '42501';
  END IF;

  -- Per-column unreconciled counts.
  SELECT jsonb_build_object(
    'created_by_legacy', count(*) FILTER (WHERE created_by_legacy IS NOT NULL),
    'updated_by_legacy', count(*) FILTER (WHERE updated_by_legacy IS NOT NULL),
    'deleted_by_legacy', count(*) FILTER (WHERE deleted_by_legacy IS NOT NULL)
  )
  INTO v_counts
  FROM public.listings
  WHERE created_by_legacy IS NOT NULL
     OR updated_by_legacy IS NOT NULL
     OR deleted_by_legacy IS NOT NULL;

  -- Detect pg_trgm; without it, similarity() doesn't exist and the
  -- function would error on first call. We just skip fuzzy in that
  -- case — exact match still works.
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'
  ) INTO v_has_trgm;

  -- Unpivot the three columns into one stream of (listing, value,
  -- target_column) rows so the same matching logic applies to all
  -- three. Then attach candidate matches.
  WITH unreconciled AS (
    SELECT id AS listing_id, created_by_legacy AS legacy_value, 'created_by'::text AS target_column
      FROM public.listings WHERE created_by_legacy IS NOT NULL
    UNION ALL
    SELECT id, updated_by_legacy, 'updated_by'
      FROM public.listings WHERE updated_by_legacy IS NOT NULL
    UNION ALL
    SELECT id, deleted_by_legacy, 'deleted_by'
      FROM public.listings WHERE deleted_by_legacy IS NOT NULL
  ),
  paged AS (
    SELECT * FROM unreconciled
    ORDER BY listing_id, target_column
    LIMIT GREATEST(p_limit, 0)
    OFFSET GREATEST(p_offset, 0)
  ),
  candidates AS (
    -- Exact case-insensitive match. Always available.
    SELECT
      p.listing_id,
      p.legacy_value,
      p.target_column,
      pr.id AS profile_id,
      pr.full_name AS profile_name,
      1.0::float AS score,
      'exact'::text AS match_kind
    FROM paged p
    JOIN public.profiles pr
      ON lower(pr.full_name) = lower(trim(p.legacy_value))
    WHERE pr.full_name IS NOT NULL

    UNION ALL

    -- Fuzzy fallback when pg_trgm exists. Threshold 0.5 — empirically
    -- a sweet spot for "Laine B." vs "Laine Bordaje" / "Tyler B"
    -- vs "Tyler Brinx".
    SELECT
      p.listing_id,
      p.legacy_value,
      p.target_column,
      pr.id,
      pr.full_name,
      similarity(lower(pr.full_name), lower(p.legacy_value)) AS score,
      'fuzzy'
    FROM paged p
    CROSS JOIN public.profiles pr
    WHERE v_has_trgm
      AND pr.full_name IS NOT NULL
      AND lower(pr.full_name) <> lower(trim(p.legacy_value))
      AND similarity(lower(pr.full_name), lower(p.legacy_value)) > 0.5
  ),
  ranked AS (
    SELECT
      c.*,
      row_number() OVER (
        PARTITION BY c.listing_id, c.target_column
        ORDER BY (CASE WHEN c.match_kind = 'exact' THEN 0 ELSE 1 END),
                 c.score DESC
      ) AS rn
    FROM candidates c
  ),
  top_candidates AS (
    -- Keep at most 5 candidates per row. UI surfaces the top match
    -- with a confidence chip; the rest are revealed if the admin
    -- expands the row.
    SELECT * FROM ranked WHERE rn <= 5
  )
  SELECT jsonb_agg(row_payload ORDER BY listing_id, target_column)
  INTO v_suggestions
  FROM (
    SELECT
      p.listing_id,
      p.target_column,
      jsonb_build_object(
        'listing_id', p.listing_id,
        'target_column', p.target_column,
        'legacy_value', p.legacy_value,
        'candidates',
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'profile_id', tc.profile_id,
                  'full_name',  tc.profile_name,
                  'score',      tc.score,
                  'match_kind', tc.match_kind
                )
                ORDER BY tc.rn
              )
              FROM top_candidates tc
              WHERE tc.listing_id = p.listing_id
                AND tc.target_column = p.target_column
            ),
            '[]'::jsonb
          )
      ) AS row_payload
    FROM paged p
  ) sub;

  -- Total count (for pagination).
  SELECT count(*) INTO v_total FROM (
    SELECT 1 FROM public.listings WHERE created_by_legacy IS NOT NULL
    UNION ALL
    SELECT 1 FROM public.listings WHERE updated_by_legacy IS NOT NULL
    UNION ALL
    SELECT 1 FROM public.listings WHERE deleted_by_legacy IS NOT NULL
  ) all_rows;

  RETURN jsonb_build_object(
    'counts', v_counts,
    'suggestions', COALESCE(v_suggestions, '[]'::jsonb),
    'total_suggestions', v_total,
    'has_trgm', v_has_trgm
  );
END;
$$;

REVOKE ALL ON FUNCTION public.legacy_creators_summary(int, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.legacy_creators_summary(int, int) TO authenticated;

COMMENT ON FUNCTION public.legacy_creators_summary(int, int) IS
  'Admin-only RPC. Lists unreconciled *_legacy columns on listings with suggested profile matches. Permission: legacy.reconcile.';


-- =====================================================================
-- 3. legacy_creators_apply — atomic FK write + _legacy clear
-- =====================================================================
--
-- target_column is a constrained string ('created_by' | 'updated_by' |
-- 'deleted_by') — we whitelist via CASE rather than dynamic SQL to
-- prevent any sql-injection avenue from a misbehaving caller.

CREATE OR REPLACE FUNCTION public.legacy_creators_apply(
  p_listing_id    bigint,
  p_target_column text,
  p_profile_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_legacy_value  text;
  v_profile_exists boolean;
  v_actor uuid := auth.uid();
BEGIN
  IF NOT public.has_permission('legacy.reconcile') THEN
    RAISE EXCEPTION 'permission denied: legacy.reconcile required'
      USING ERRCODE = '42501';
  END IF;

  IF p_target_column NOT IN ('created_by', 'updated_by', 'deleted_by') THEN
    RAISE EXCEPTION 'invalid target_column: %', p_target_column
      USING ERRCODE = '22023';
  END IF;

  -- Profile must exist (FK guarantee + a friendlier error message).
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id)
  INTO v_profile_exists;
  IF NOT v_profile_exists THEN
    RAISE EXCEPTION 'profile not found: %', p_profile_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Apply. The CASE picks the right column pair — cleaner than a
  -- format() + EXECUTE dance and avoids any dynamic-SQL surface.
  IF p_target_column = 'created_by' THEN
    UPDATE public.listings
       SET created_by = p_profile_id,
           created_by_legacy = NULL
     WHERE id = p_listing_id
       AND created_by_legacy IS NOT NULL
    RETURNING created_by_legacy INTO v_legacy_value;
  ELSIF p_target_column = 'updated_by' THEN
    UPDATE public.listings
       SET updated_by = p_profile_id,
           updated_by_legacy = NULL
     WHERE id = p_listing_id
       AND updated_by_legacy IS NOT NULL
    RETURNING updated_by_legacy INTO v_legacy_value;
  ELSE
    UPDATE public.listings
       SET deleted_by = p_profile_id,
           deleted_by_legacy = NULL
     WHERE id = p_listing_id
       AND deleted_by_legacy IS NOT NULL
    RETURNING deleted_by_legacy INTO v_legacy_value;
  END IF;

  -- v_legacy_value is NULL when no row matched OR the legacy column
  -- was already NULL. Either way, the apply is a no-op — return so
  -- the caller can show a "row already reconciled" toast.
  IF v_legacy_value IS NULL THEN
    -- The UPDATE matched zero rows. RETURNING is NULL even when the
    -- value WAS NULL because of the WHERE _legacy IS NOT NULL guard.
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_reconciled_or_missing'
    );
  END IF;

  -- Audit. Stamps actor from auth.uid() automatically via log_activity.
  PERFORM public.log_activity(
    p_action    := 'listing.legacy_reconciled',
    p_entity    := 'listing',
    p_entity_id := NULL,
    p_metadata  := jsonb_build_object(
      'listing_id',    p_listing_id,
      'target_column', p_target_column,
      'legacy_value',  v_legacy_value,
      'matched_to',    p_profile_id
    )
  );

  RETURN jsonb_build_object(
    'applied', true,
    'listing_id', p_listing_id,
    'target_column', p_target_column,
    'profile_id', p_profile_id,
    'previous_legacy_value', v_legacy_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.legacy_creators_apply(bigint, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.legacy_creators_apply(bigint, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.legacy_creators_apply(bigint, text, uuid) IS
  'Admin-only RPC. Atomically writes profile_id into the target FK column and NULLs the matching *_legacy column on listings. Audits via log_activity. Permission: legacy.reconcile.';


NOTIFY pgrst, 'reload schema';
