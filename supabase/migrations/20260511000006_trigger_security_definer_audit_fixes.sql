-- Trigger SECURITY DEFINER audit — fixes two silent-failure bugs
-- found by sweeping every trigger function across migrations.
--
-- Same bug class as the deal_stage_history + apply_task_templates
-- fixes (20260511000001 / 20260511000005). A trigger function runs
-- as the calling user by default; if it INSERTs/UPDATEs/SELECTs a
-- table whose RLS the caller can't satisfy, the operation either
-- aborts or returns nothing. When the trigger swallows errors with
-- WHEN OTHERS, the symptom is silent feature death — the user's
-- write succeeds, but the auxiliary effect never lands.
--
-- 1) deals_create_platform_fee_projection_fn (20260507000059)
--    Fires AFTER UPDATE OF closed_won, INSERTs into
--    platform_fee_charges. The platform_fee_charges_modify policy
--    requires platform_fees.manage / admin.access. Agents closing a
--    deal don't have those, so the INSERT fails, the function's
--    WHEN OTHERS handler logs a warning, and the deal proceeds
--    without a fee row. Net effect: platform revenue ledger is
--    silently never populated by ordinary deal-close traffic.
--
-- 2) lead_routing_assign_fn (20260508000009)
--    Fires BEFORE INSERT ON inquiries, SELECTs lead_routing_rules,
--    UPDATEs match_count / pool_state on the matched row. The
--    lead_routing_rules policies (both SELECT and modify) require
--    lead_routing.manage / admin.access. Anon-submitted (public
--    website) inquiries can't read the rules at all → the FOR loop
--    has zero iterations → no rule fires. Authenticated agents
--    without the permission hit the same wall. Net effect: the
--    entire lead-routing feature is dark for the primary use case.
--
-- Fix in both cases: flip the function to SECURITY DEFINER so it
-- runs as the function owner (postgres, exempt from RLS by default).
-- The function body is unchanged — the SELECT against
-- automation_task_templates / lead_routing_rules already gates which
-- rules fire, and admins remain the only ones who can create or
-- enable a rule (those tables' RLS still applies to the admin UI).
--
-- ROLLBACK: re-CREATE OR REPLACE without SECURITY DEFINER (re-opens
-- both bugs). Don't.

-- =====================================================================
-- 1. deals_create_platform_fee_projection_fn
-- =====================================================================

CREATE OR REPLACE FUNCTION public.deals_create_platform_fee_projection_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule              record;
  v_pct               numeric;
  v_basis_kind        text;
  v_basis_ref_minor   bigint;
  v_amount_minor      bigint;
  v_commission_total  numeric;
BEGIN
  IF NOT (NEW.closed_won = true
          AND (OLD.closed_won IS NULL OR OLD.closed_won = false)) THEN
    RETURN NEW;
  END IF;

  IF NEW.buyer_agent_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.platform_fee_charges
     WHERE deal_id = NEW.id
       AND user_id = NEW.buyer_agent_user_id
       AND status <> 'void'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT default_pct, basis_kind, by_org
    INTO v_rule
  FROM public.platform_commission_rules
  WHERE active = true AND id = 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_pct        := v_rule.default_pct;
  v_basis_kind := v_rule.basis_kind;

  IF v_basis_kind = 'percent_of_commission' THEN
    SELECT coalesce(sum(net_amount), 0)
      INTO v_commission_total
    FROM public.deal_commissions
    WHERE deal_id = NEW.id
      AND status NOT IN ('clawback');

    IF v_commission_total <= 0 THEN
      RETURN NEW;
    END IF;

    v_basis_ref_minor := (v_commission_total * 100)::bigint;
    v_amount_minor    := round(v_basis_ref_minor::numeric * v_pct / 100.0)::bigint;

  ELSIF v_basis_kind = 'percent_of_deal_value' THEN
    IF NEW.deal_value IS NULL OR NEW.deal_value <= 0 THEN
      RETURN NEW;
    END IF;
    v_basis_ref_minor := (NEW.deal_value * 100)::bigint;
    v_amount_minor    := round(v_basis_ref_minor::numeric * v_pct / 100.0)::bigint;

  ELSE
    v_basis_ref_minor := NULL;
    v_amount_minor    := round(v_pct)::bigint;
  END IF;

  IF v_amount_minor <= 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.platform_fee_charges
    (deal_id, user_id, basis_kind, basis_value, basis_reference_minor,
     amount_minor, currency, status, notes)
  VALUES
    (NEW.id, NEW.buyer_agent_user_id, v_basis_kind, v_pct, v_basis_ref_minor,
     v_amount_minor, coalesce(NEW.currency, 'PHP'), 'projected',
     'Auto-generated on deal closed_won by trigger.');

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'deals_create_platform_fee_projection: % (%)', SQLERRM, SQLSTATE;
    RETURN NEW;
END;
$$;


-- =====================================================================
-- 2. lead_routing_assign_fn
-- =====================================================================

CREATE OR REPLACE FUNCTION public.lead_routing_assign_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule              record;
  v_match             boolean;
  v_listing           record;
  v_listing_loaded    boolean := false;
  v_listing_kind      text;
  v_price             numeric;
  v_assigned          uuid;
  v_pool_index        int;
BEGIN
  FOR v_rule IN
    SELECT id, criteria, action_kind, assign_user_id, pool_user_ids, pool_state
      FROM public.lead_routing_rules
     WHERE enabled = true
     ORDER BY priority ASC, created_at ASC
  LOOP
    v_match := true;

    IF v_rule.criteria ? 'has_listing' THEN
      IF (v_rule.criteria->>'has_listing')::boolean = true AND NEW.listing_id IS NULL THEN
        v_match := false;
      ELSIF (v_rule.criteria->>'has_listing')::boolean = false AND NEW.listing_id IS NOT NULL THEN
        v_match := false;
      END IF;
    END IF;

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

    IF v_match AND (
      v_rule.criteria ? 'property_type'
      OR v_rule.criteria ? 'city_id'
      OR v_rule.criteria ? 'barangay_id'
      OR v_rule.criteria ? 'min_price'
      OR v_rule.criteria ? 'max_price'
      OR v_rule.criteria ? 'listing_kind'
    ) THEN
      IF NEW.listing_id IS NULL THEN
        v_match := false;
      ELSE
        IF NOT v_listing_loaded THEN
          SELECT property_type, city_id, barangay_id, sale_price, rent_price
            INTO v_listing
            FROM public.listings
            WHERE id = NEW.listing_id;
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
      IF v_rule.action_kind = 'assign_user' THEN
        v_assigned := v_rule.assign_user_id;
      ELSE
        v_pool_index := COALESCE((v_rule.pool_state->>'last_index')::int, -1);
        v_pool_index := (v_pool_index + 1) % array_length(v_rule.pool_user_ids, 1);
        v_assigned := v_rule.pool_user_ids[v_pool_index + 1];
        BEGIN
          UPDATE public.lead_routing_rules
             SET pool_state = jsonb_set(pool_state, '{last_index}', to_jsonb(v_pool_index))
           WHERE id = v_rule.id;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END IF;

      NEW.assigned_user_id := v_assigned;

      BEGIN
        UPDATE public.lead_routing_rules
           SET match_count = match_count + 1,
               last_matched_at = now()
         WHERE id = v_rule.id;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;

      EXIT;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
