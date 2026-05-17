-- Remove Plans + Subscriptions  (commission-only pivot).
--
-- Pivot decision: 2026-05-08. Platform monetization moves from
-- subscription billing (B4 plans/entitlements + B6 subscriptions)
-- to commission-only — platform takes a configured % of each closed
-- deal's broker commission. Recorded in the new
-- platform_fee_charges table (mig 20260507000059).
--
-- DROPS:
--   - assign_default_plan trigger on organizations
--   - assign_default_plan_fn / org_has_feature / org_feature_limit RPCs
--   - organization_entitlements view
--   - organization_subscriptions table  (CASCADE drops invoices.subscription_id FK)
--   - plan_features, plan_prices, plans tables
--   - plans.manage permission + role_permissions
--   - governance contracts for the four surfaces
--
-- KEEPS (still needed for commission collection + future rent flows):
--   - billing_accounts, payment_methods, invoices, payment_intents,
--     payment_gateway_events  (B6 — gateway infra)
--   - commission_ledger (B1)
--   - all property-management billing (C5 property_charges)
--
-- DESTRUCTIVE: this migration cannot be cleanly rolled back. To restore
-- the plans/subscriptions surface, re-apply mig 49 + the deleted
-- portions of mig 51. There is no UNDROP for tables.
--
-- The invoices.subscription_id column is RETAINED as nullable bigint
-- with no FK constraint after CASCADE. Comment marks it deprecated.

-- =====================================================================
-- 1. Drop trigger + trigger function
-- =====================================================================

DROP TRIGGER IF EXISTS organizations_assign_default_plan ON public.organizations;
DROP FUNCTION IF EXISTS public.assign_default_plan_fn();


-- =====================================================================
-- 2. Drop entitlement RPCs
-- =====================================================================

DROP FUNCTION IF EXISTS public.org_feature_limit(uuid, text);
DROP FUNCTION IF EXISTS public.org_has_feature(uuid, text);


-- =====================================================================
-- 3. Drop entitlements view
-- =====================================================================

DROP VIEW IF EXISTS public.organization_entitlements;


-- =====================================================================
-- 4. Drop organization_subscriptions  (CASCADE drops FK from invoices)
-- =====================================================================
--
-- CASCADE drops the FK constraint on invoices.subscription_id but
-- preserves the column itself. Existing values become orphan uuids.
-- Application code stops writing to it; future cleanup migration can
-- drop the column entirely once all readers are removed.

DROP TABLE IF EXISTS public.organization_subscriptions CASCADE;

COMMENT ON COLUMN public.invoices.subscription_id IS
  'DEPRECATED 2026-05-08: organization_subscriptions table was dropped '
  'in the commission-only pivot. Column retained as nullable for backward '
  'compatibility; never written by new code. Drop entirely in a future '
  'cleanup migration once all reader paths are confirmed removed.';


-- =====================================================================
-- 5. Drop plan tables
-- =====================================================================

DROP TABLE IF EXISTS public.plan_features;
DROP TABLE IF EXISTS public.plan_prices;
DROP TABLE IF EXISTS public.plans;


-- =====================================================================
-- 6. Permissions + governance cleanup
-- =====================================================================

DELETE FROM public.role_permissions WHERE permission = 'plans.manage';
DELETE FROM public.permissions WHERE name = 'plans.manage';

DELETE FROM public.governance_schema_contracts
 WHERE contract_name IN (
   'public.plans',
   'public.plan_features',
   'public.plan_prices',
   'public.organization_subscriptions',
   'public.organization_entitlements'
 );


NOTIFY pgrst, 'reload schema';
