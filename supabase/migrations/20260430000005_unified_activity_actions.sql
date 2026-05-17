-- Standardize activities.action to dotted (entity.verb) naming.
--
-- Phase-4 shipped snake-case action names (`contact_created`,
-- `listing_archived`, …). The unified CRM timeline standardizes on
-- `entity.verb` (`contact.created`, `listing.archived`, …) so a single
-- frontend EVENT_CONFIG map can drive labels, colors, and icons across
-- every entity type.
--
-- This migration:
--   1. Backfills historical rows by replacing the FIRST underscore in
--      action with a dot. `listing_remarks_updated` → `listing.remarks_updated`
--      (we keep underscores within the verb to preserve granularity).
--   2. Re-stamps the comment on activities.action with the new convention.
--
-- This is a pure UPDATE; the table shape, RLS, indexes, and the
-- log_activity() RPC do NOT change. New writers in this PR emit the
-- dotted form natively.
--
-- DEPENDS ON: 20260429000006_phase4_rbac_audit.sql
--
-- ROLLBACK (undo to snake-case):
--   UPDATE public.activities
--      SET action = REPLACE(action, '.', '_')
--    WHERE action ~ '^[a-z]+\.';

UPDATE public.activities
SET action = regexp_replace(action, '^([a-z]+)_', '\1.')
WHERE action ~ '^[a-z]+_'
  AND action !~ '^[a-z]+\.';

COMMENT ON COLUMN public.activities.action IS
  'Dotted entity.verb identifier — e.g. contact.created, listing.archived, document.uploaded. Drives EVENT_CONFIG mapping in the frontend timeline.';
