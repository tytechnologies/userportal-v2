-- Column-existence guard for legacy_creators_* RPCs.
--
-- WHY:
-- Migration 20260429000002 added created_by_legacy / updated_by_legacy /
-- deleted_by_legacy to public.listings. It used ADD COLUMN IF NOT EXISTS
-- so it's idempotent — but if it never ran (e.g., a DB provisioned
-- cleanly with no pre-existing string-typed created_by data), those
-- columns won't be there, and the reconcile RPCs raise 42703 on the
-- first SELECT.
--
-- This migration adds a defensive guard at the top of each RPC: if the
-- legacy columns aren't present, return an empty payload tagged
-- `no_legacy_columns: true` so the UI can show a friendly message
-- instead of a 500.
--
-- Also future-proofs the eventual cleanup: when a follow-up migration
-- DROPs the *_legacy columns after full reconciliation, these RPCs
-- continue to work — they just report "nothing to do."
--
-- ROLLBACK:
--   Re-apply 20260507000005 (CREATE OR REPLACE overwrites).

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
  v_has_legacy boolean;
BEGIN
  IF NOT (
    public.has_permission('legacy.reconcile')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: legacy.reconcile required'
      USING ERRCODE = '42501';
  END IF;

  -- Defensive: bail early if the legacy columns aren't present.
  -- We check created_by_legacy as the canonical proxy — the three
  -- columns ship together in 20260429000002.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'listings'
      AND column_name  = 'created_by_legacy'
  ) INTO v_has_legacy;

  IF NOT v_has_legacy THEN
    RETURN jsonb_build_object(
      'counts',            jsonb_build_object(),
      'suggestions',       '[]'::jsonb,
      'total_suggestions', 0,
      'has_trgm',          false,
      'no_legacy_columns', true
    );
  END IF;

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

  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'
  ) INTO v_has_trgm;

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

  SELECT count(*) INTO v_total FROM (
    SELECT 1 FROM public.listings WHERE created_by_legacy IS NOT NULL
    UNION ALL
    SELECT 1 FROM public.listings WHERE updated_by_legacy IS NOT NULL
    UNION ALL
    SELECT 1 FROM public.listings WHERE deleted_by_legacy IS NOT NULL
  ) all_rows;

  RETURN jsonb_build_object(
    'counts',            v_counts,
    'suggestions',       COALESCE(v_suggestions, '[]'::jsonb),
    'total_suggestions', v_total,
    'has_trgm',          v_has_trgm,
    'no_legacy_columns', false
  );
END;
$$;


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
  v_has_legacy boolean;
BEGIN
  IF NOT (
    public.has_permission('legacy.reconcile')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: legacy.reconcile required'
      USING ERRCODE = '42501';
  END IF;

  IF p_target_column NOT IN ('created_by', 'updated_by', 'deleted_by') THEN
    RAISE EXCEPTION 'invalid target_column: %', p_target_column
      USING ERRCODE = '22023';
  END IF;

  -- If the *_legacy column for the requested target doesn't exist,
  -- there's literally nothing to reconcile. Return a structured
  -- "no-op" rather than raising 42703 so the UI can stay quiet.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'listings'
      AND column_name  = p_target_column || '_legacy'
  ) INTO v_has_legacy;

  IF NOT v_has_legacy THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'no_legacy_column'
    );
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id)
  INTO v_profile_exists;
  IF NOT v_profile_exists THEN
    RAISE EXCEPTION 'profile not found: %', p_profile_id
      USING ERRCODE = 'P0002';
  END IF;

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

  IF v_legacy_value IS NULL THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_reconciled_or_missing'
    );
  END IF;

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


NOTIFY pgrst, 'reload schema';
