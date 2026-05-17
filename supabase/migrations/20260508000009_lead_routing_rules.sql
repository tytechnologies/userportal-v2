-- Lead routing rules for inquiries.
--
-- Operators define priority-ordered rules; a BEFORE INSERT trigger on
-- public.inquiries walks them in priority order, first match wins,
-- and OVERRIDES any pre-set assigned_user_id. When no rule matches,
-- whatever the caller set (typically the public endpoint's snapshot
-- of listings.created_by) stays intact — so this is purely additive
-- on top of existing routing semantics.
--
-- Two action shapes:
--   assign_user        — fixed assignee
--   round_robin_pool   — rotate through pool_user_ids on each match
--                        (pool_state.last_index advances mod pool len)
--
-- Criteria jsonb keys (all optional; empty {} matches everything):
--   property_type:  text | text[]    -- 'condo'|'house'|'lot'|'commercial'
--   listing_kind:   text             -- 'sale' | 'rent' (derived from sale_price/rent_price presence)
--   city_id:        bigint | bigint[]
--   barangay_id:    bigint | bigint[]
--   min_price:      numeric          -- against sale_price OR rent_price (whichever set)
--   max_price:      numeric
--   source:         text | text[]    -- 'website'|'mobile'|'referral'|'api'
--   has_listing:    boolean          -- require / require-not a linked listing
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS inquiries_lead_routing_assign ON public.inquiries;
--   DROP FUNCTION IF EXISTS public.lead_routing_assign_fn();
--   DROP TABLE IF EXISTS public.lead_routing_rules;
--   DELETE FROM public.role_permissions WHERE permission = 'lead_routing.manage';
--   DELETE FROM public.permissions WHERE name = 'lead_routing.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.lead_routing_rules';


-- =====================================================================
-- 0. Hard preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='inquiries') THEN
    v_missing := v_missing || 'public.inquiries';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listings') THEN
    v_missing := v_missing || 'public.listings';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='profiles') THEN
    v_missing := v_missing || 'public.profiles';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 20260508000009 requires tables: %.', array_to_string(v_missing, ', ');
  END IF;
END $$;


-- =====================================================================
-- 1. lead_routing_rules
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.lead_routing_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description         text,

  -- Lower number = higher priority. Range gives operators room to
  -- insert between existing rules without renumbering all of them.
  priority            int NOT NULL DEFAULT 100
                          CHECK (priority >= 0 AND priority <= 10000),
  enabled             boolean NOT NULL DEFAULT true,

  criteria            jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Action shape.
  action_kind         text NOT NULL
                          CHECK (action_kind IN ('assign_user', 'round_robin_pool')),
  assign_user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  pool_user_ids       uuid[],
  -- { last_index: int } — bumps mod pool length on each round-robin pick.
  pool_state          jsonb NOT NULL DEFAULT '{"last_index": -1}'::jsonb,

  -- Denormalised observability.
  match_count         int NOT NULL DEFAULT 0 CHECK (match_count >= 0),
  last_matched_at     timestamptz,

  notes               text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Action coherence.
  CHECK (
    (action_kind = 'assign_user' AND assign_user_id IS NOT NULL)
    OR (action_kind = 'round_robin_pool'
        AND pool_user_ids IS NOT NULL
        AND array_length(pool_user_ids, 1) > 0)
  )
);

CREATE INDEX IF NOT EXISTS lead_routing_rules_active_priority_idx
  ON public.lead_routing_rules(priority, id)
  WHERE enabled = true;

DROP TRIGGER IF EXISTS set_lead_routing_rules_updated_at ON public.lead_routing_rules;
CREATE TRIGGER set_lead_routing_rules_updated_at
  BEFORE UPDATE ON public.lead_routing_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.lead_routing_rules IS
  'Priority-ordered routing rules for incoming inquiries. BEFORE INSERT trigger walks them; first match wins and overrides any pre-set assigned_user_id.';


-- =====================================================================
-- 2. Trigger function
-- =====================================================================
--
-- Walks active rules in priority order. For each rule:
--   1. Evaluate every criterion key against the new row + parent
--      listing context. Omitted criteria pass.
--   2. On match: resolve assignee (fixed or round-robin), stamp
--      NEW.assigned_user_id, bump match_count + last_matched_at,
--      and EXIT.
--   3. If no rule matches: NEW.assigned_user_id is left as the
--      caller set it (preserves the existing public-endpoint
--      snapshot of listings.created_by — purely additive).
--
-- Round-robin update is best-effort wrapped in a sub-block so a
-- transient row-update failure never blocks the inquiry insert.

CREATE OR REPLACE FUNCTION public.lead_routing_assign_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_listing       record;
  v_listing_loaded boolean := false;
  v_rule          record;
  v_match         boolean;
  v_pool_index    int;
  v_assigned      uuid;
  v_listing_kind  text;
  v_price         numeric;
BEGIN
  -- Walk rules in priority order. We DO walk even when assigned_user_id
  -- is already set — rules are designed to override.
  FOR v_rule IN
    SELECT id, criteria, action_kind, assign_user_id, pool_user_ids, pool_state, name
    FROM public.lead_routing_rules
    WHERE enabled = true
    ORDER BY priority ASC, id ASC
  LOOP
    v_match := true;

    -- has_listing
    IF v_rule.criteria ? 'has_listing' THEN
      IF (v_rule.criteria->>'has_listing')::boolean = true AND NEW.listing_id IS NULL THEN
        v_match := false;
      ELSIF (v_rule.criteria->>'has_listing')::boolean = false AND NEW.listing_id IS NOT NULL THEN
        v_match := false;
      END IF;
    END IF;

    -- source
    IF v_match AND v_rule.criteria ? 'source' THEN
      IF jsonb_typeof(v_rule.criteria->'source') = 'array' THEN
        IF NOT (v_rule.criteria->'source' ? COALESCE(NEW.source, '')) THEN
          v_match := false;
        END IF;
      ELSE
        IF (v_rule.criteria->>'source') <> COALESCE(NEW.source, '') THEN
          v_match := false;
        END IF;
      END IF;
    END IF;

    -- Listing-derived criteria need listing context. Lazy-load on
    -- first need so rules that don't reference the listing don't pay
    -- for the lookup.
    IF v_match AND (
      v_rule.criteria ? 'property_type'
      OR v_rule.criteria ? 'city_id'
      OR v_rule.criteria ? 'barangay_id'
      OR v_rule.criteria ? 'min_price'
      OR v_rule.criteria ? 'max_price'
      OR v_rule.criteria ? 'listing_kind'
    ) THEN
      IF NEW.listing_id IS NULL THEN
        -- Listing-derived criteria can't match a no-listing inquiry.
        v_match := false;
      ELSE
        IF NOT v_listing_loaded THEN
          SELECT property_type, city_id, barangay_id, sale_price, rent_price
            INTO v_listing
            FROM public.listings
            WHERE id = NEW.listing_id;
          v_listing_loaded := true;
        END IF;

        -- property_type
        IF v_match AND v_rule.criteria ? 'property_type' THEN
          IF jsonb_typeof(v_rule.criteria->'property_type') = 'array' THEN
            IF NOT (v_rule.criteria->'property_type' ? COALESCE(v_listing.property_type, '')) THEN
              v_match := false;
            END IF;
          ELSE
            IF (v_rule.criteria->>'property_type') <> COALESCE(v_listing.property_type, '') THEN
              v_match := false;
            END IF;
          END IF;
        END IF;

        -- city_id
        IF v_match AND v_rule.criteria ? 'city_id' THEN
          IF jsonb_typeof(v_rule.criteria->'city_id') = 'array' THEN
            IF NOT (v_rule.criteria->'city_id' ? v_listing.city_id::text) THEN
              v_match := false;
            END IF;
          ELSE
            IF (v_rule.criteria->>'city_id')::bigint <> v_listing.city_id THEN
              v_match := false;
            END IF;
          END IF;
        END IF;

        -- barangay_id
        IF v_match AND v_rule.criteria ? 'barangay_id' THEN
          IF jsonb_typeof(v_rule.criteria->'barangay_id') = 'array' THEN
            IF NOT (v_rule.criteria->'barangay_id' ? v_listing.barangay_id::text) THEN
              v_match := false;
            END IF;
          ELSE
            IF (v_rule.criteria->>'barangay_id')::bigint <> v_listing.barangay_id THEN
              v_match := false;
            END IF;
          END IF;
        END IF;

        -- listing_kind: derived from which price column is set
        IF v_match AND v_rule.criteria ? 'listing_kind' THEN
          v_listing_kind := CASE
            WHEN v_listing.sale_price IS NOT NULL AND v_listing.rent_price IS NULL THEN 'sale'
            WHEN v_listing.rent_price IS NOT NULL AND v_listing.sale_price IS NULL THEN 'rent'
            WHEN v_listing.sale_price IS NOT NULL AND v_listing.rent_price IS NOT NULL THEN 'sale_or_rent'
            ELSE NULL
          END;
          IF (v_rule.criteria->>'listing_kind') <> COALESCE(v_listing_kind, '') THEN
            v_match := false;
          END IF;
        END IF;

        -- price range — coalesce sale_price / rent_price (whichever set wins)
        IF v_match AND (v_rule.criteria ? 'min_price' OR v_rule.criteria ? 'max_price') THEN
          v_price := COALESCE(v_listing.sale_price, v_listing.rent_price);
          IF v_price IS NULL THEN
            v_match := false;
          ELSE
            IF v_rule.criteria ? 'min_price'
               AND v_price < (v_rule.criteria->>'min_price')::numeric THEN
              v_match := false;
            END IF;
            IF v_match AND v_rule.criteria ? 'max_price'
               AND v_price > (v_rule.criteria->>'max_price')::numeric THEN
              v_match := false;
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;

    IF v_match THEN
      -- Resolve assignee.
      IF v_rule.action_kind = 'assign_user' THEN
        v_assigned := v_rule.assign_user_id;
      ELSE
        -- Round-robin: advance index mod pool length. Pg arrays are
        -- 1-indexed, so we store last_index 0-based then offset on read.
        v_pool_index := COALESCE((v_rule.pool_state->>'last_index')::int, -1);
        v_pool_index := (v_pool_index + 1) % array_length(v_rule.pool_user_ids, 1);
        v_assigned := v_rule.pool_user_ids[v_pool_index + 1];
        BEGIN
          UPDATE public.lead_routing_rules
             SET pool_state = jsonb_set(pool_state, '{last_index}', to_jsonb(v_pool_index))
           WHERE id = v_rule.id;
        EXCEPTION WHEN OTHERS THEN
          -- Best-effort: a transient pool-state write failure shouldn't
          -- block the inquiry insert. Next match will retry from the
          -- same index (worst case: same user gets two in a row).
          NULL;
        END;
      END IF;

      NEW.assigned_user_id := v_assigned;

      -- Bump match counters (best-effort).
      BEGIN
        UPDATE public.lead_routing_rules
           SET match_count = match_count + 1,
               last_matched_at = now()
         WHERE id = v_rule.id;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;

      EXIT; -- first match wins
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inquiries_lead_routing_assign ON public.inquiries;
CREATE TRIGGER inquiries_lead_routing_assign
  BEFORE INSERT ON public.inquiries
  FOR EACH ROW EXECUTE FUNCTION public.lead_routing_assign_fn();


-- =====================================================================
-- 3. evaluate_lead_routing — preview RPC for the rule editor
-- =====================================================================
--
-- Returns the rule id + name that would match given a hypothetical
-- inquiry shape, without writing anything. UI uses this to show
-- operators "this rule would catch this inquiry" while editing.

CREATE OR REPLACE FUNCTION public.evaluate_lead_routing(
  p_listing_id bigint DEFAULT NULL,
  p_source     text   DEFAULT 'website'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing       record;
  v_listing_loaded boolean := false;
  v_rule          record;
  v_match         boolean;
  v_listing_kind  text;
  v_price         numeric;
BEGIN
  IF NOT (
    public.has_permission('lead_routing.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'evaluate_lead_routing: permission denied' USING ERRCODE = '42501';
  END IF;

  FOR v_rule IN
    SELECT id, criteria, action_kind, assign_user_id, pool_user_ids, name, priority
    FROM public.lead_routing_rules
    WHERE enabled = true
    ORDER BY priority ASC, id ASC
  LOOP
    v_match := true;

    IF v_rule.criteria ? 'has_listing' THEN
      IF (v_rule.criteria->>'has_listing')::boolean = true AND p_listing_id IS NULL THEN
        v_match := false;
      ELSIF (v_rule.criteria->>'has_listing')::boolean = false AND p_listing_id IS NOT NULL THEN
        v_match := false;
      END IF;
    END IF;

    IF v_match AND v_rule.criteria ? 'source' THEN
      IF jsonb_typeof(v_rule.criteria->'source') = 'array' THEN
        IF NOT (v_rule.criteria->'source' ? COALESCE(p_source, '')) THEN
          v_match := false;
        END IF;
      ELSE
        IF (v_rule.criteria->>'source') <> COALESCE(p_source, '') THEN
          v_match := false;
        END IF;
      END IF;
    END IF;

    IF v_match AND (
      v_rule.criteria ? 'property_type'
      OR v_rule.criteria ? 'city_id'
      OR v_rule.criteria ? 'barangay_id'
      OR v_rule.criteria ? 'min_price'
      OR v_rule.criteria ? 'max_price'
      OR v_rule.criteria ? 'listing_kind'
    ) THEN
      IF p_listing_id IS NULL THEN
        v_match := false;
      ELSE
        IF NOT v_listing_loaded THEN
          SELECT property_type, city_id, barangay_id, sale_price, rent_price
            INTO v_listing
            FROM public.listings
            WHERE id = p_listing_id;
          v_listing_loaded := true;
        END IF;

        IF v_match AND v_rule.criteria ? 'property_type' THEN
          IF jsonb_typeof(v_rule.criteria->'property_type') = 'array' THEN
            IF NOT (v_rule.criteria->'property_type' ? COALESCE(v_listing.property_type, '')) THEN
              v_match := false;
            END IF;
          ELSE
            IF (v_rule.criteria->>'property_type') <> COALESCE(v_listing.property_type, '') THEN
              v_match := false;
            END IF;
          END IF;
        END IF;

        IF v_match AND v_rule.criteria ? 'city_id' THEN
          IF jsonb_typeof(v_rule.criteria->'city_id') = 'array' THEN
            IF NOT (v_rule.criteria->'city_id' ? v_listing.city_id::text) THEN
              v_match := false;
            END IF;
          ELSE
            IF (v_rule.criteria->>'city_id')::bigint <> v_listing.city_id THEN
              v_match := false;
            END IF;
          END IF;
        END IF;

        IF v_match AND v_rule.criteria ? 'barangay_id' THEN
          IF jsonb_typeof(v_rule.criteria->'barangay_id') = 'array' THEN
            IF NOT (v_rule.criteria->'barangay_id' ? v_listing.barangay_id::text) THEN
              v_match := false;
            END IF;
          ELSE
            IF (v_rule.criteria->>'barangay_id')::bigint <> v_listing.barangay_id THEN
              v_match := false;
            END IF;
          END IF;
        END IF;

        IF v_match AND v_rule.criteria ? 'listing_kind' THEN
          v_listing_kind := CASE
            WHEN v_listing.sale_price IS NOT NULL AND v_listing.rent_price IS NULL THEN 'sale'
            WHEN v_listing.rent_price IS NOT NULL AND v_listing.sale_price IS NULL THEN 'rent'
            WHEN v_listing.sale_price IS NOT NULL AND v_listing.rent_price IS NOT NULL THEN 'sale_or_rent'
            ELSE NULL
          END;
          IF (v_rule.criteria->>'listing_kind') <> COALESCE(v_listing_kind, '') THEN
            v_match := false;
          END IF;
        END IF;

        IF v_match AND (v_rule.criteria ? 'min_price' OR v_rule.criteria ? 'max_price') THEN
          v_price := COALESCE(v_listing.sale_price, v_listing.rent_price);
          IF v_price IS NULL THEN
            v_match := false;
          ELSE
            IF v_rule.criteria ? 'min_price'
               AND v_price < (v_rule.criteria->>'min_price')::numeric THEN
              v_match := false;
            END IF;
            IF v_match AND v_rule.criteria ? 'max_price'
               AND v_price > (v_rule.criteria->>'max_price')::numeric THEN
              v_match := false;
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;

    IF v_match THEN
      RETURN jsonb_build_object(
        'matched', true,
        'rule_id', v_rule.id,
        'rule_name', v_rule.name,
        'priority', v_rule.priority,
        'action_kind', v_rule.action_kind,
        'would_assign_to', CASE
          WHEN v_rule.action_kind = 'assign_user' THEN v_rule.assign_user_id
          ELSE NULL
        END,
        'pool_user_ids', CASE
          WHEN v_rule.action_kind = 'round_robin_pool' THEN to_jsonb(v_rule.pool_user_ids)
          ELSE NULL
        END
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('matched', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.evaluate_lead_routing(bigint, text) TO authenticated;


-- =====================================================================
-- 4. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('lead_routing.manage',
   'Manage automatic inquiry routing rules',
   'crm')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'lead_routing.manage'),
  ('manager', 'lead_routing.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5. RLS
-- =====================================================================

ALTER TABLE public.lead_routing_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_routing_rules_select ON public.lead_routing_rules;
CREATE POLICY lead_routing_rules_select
  ON public.lead_routing_rules FOR SELECT
  TO authenticated
  USING (
    public.has_permission('lead_routing.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS lead_routing_rules_modify ON public.lead_routing_rules;
CREATE POLICY lead_routing_rules_modify
  ON public.lead_routing_rules FOR ALL
  TO authenticated
  USING (
    public.has_permission('lead_routing.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('lead_routing.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 6. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.lead_routing_rules', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Priority-ordered routing rules for incoming inquiries', false),
  ('public.lead_routing_assign_fn', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'BEFORE INSERT trigger function on inquiries — overrides assigned_user_id when a rule matches', false),
  ('public.evaluate_lead_routing', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Preview RPC: returns the rule that would match given an inquiry shape', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
