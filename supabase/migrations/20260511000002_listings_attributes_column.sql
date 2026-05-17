-- Ensure public.listings.attributes exists as jsonb.
--
-- Why:
--   The website's LISTINGS_PUBLIC_SELECT (websiteo/server/utils/listingsApi.ts)
--   has been quoting `attributes` for some time, and the AddListingWizard
--   refresh adds a commercial-specifics block + YouTube/SlideShare embeds
--   that need a structured home. Rather than scatter 10+ typed columns
--   for fields whose adoption rate is unknown (escalation %, telco list,
--   aircon model, building class, office floor/setup/type, occupant
--   count, video ids), they live in `attributes` jsonb. Each key is
--   namespaced (commercial.*, media.*) so future typed-column promotion
--   is mechanical.
--
--   The IF NOT EXISTS is deliberate: the baseline schema may already
--   carry this column from before the migrations folder existed (the
--   website's column allowlist suggests so). Skipping the add in that
--   case is harmless; failing the migration when it's already there
--   would be worse.
--
-- ROLLBACK:
--   ALTER TABLE public.listings DROP COLUMN IF EXISTS attributes;
--   NOTIFY pgrst, 'reload schema';
--
-- Additive-only — no data movement, no constraint changes, no edits to
-- existing column types. Safe to apply on a populated database.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.listings.attributes IS
  'Free-form structured payload. Keys are namespaced by feature group: commercial.* (building_class, aircon, escalation, telcos, office_floor, office_type, office_setup, occupant_number, developer), media.* (youtube_id, slideshare_id). Promote to typed columns when adoption justifies an index.';

-- Refresh PostgREST schema cache so the column is queryable in the
-- same deployment without a process restart.
NOTIFY pgrst, 'reload schema';
