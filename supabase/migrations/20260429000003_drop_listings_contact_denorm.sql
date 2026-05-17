-- Audit D4 fix: listings has 7 denormalized contact-data columns that drift
-- from the canonical contacts row whenever a contact is edited. Drop them
-- in favor of joining via listings.contact_id → contacts.
--
-- ⚠ DO NOT APPLY UNTIL the server stops writing these columns. The clone
-- payload in server/repositories/listings.repo.ts and the create-listing
-- form in app/components/pages/listings/NewForm.vue still reference them.
-- Sequence:
--   1. PR: rewrite repo + form to omit these columns. Deploy.
--   2. Verify no consumer reads listings.contact_* directly (grep).
--   3. Apply this migration.
--
-- ROLLBACK:
--   ALTER TABLE public.listings
--     ADD COLUMN contact_name           text,
--     ADD COLUMN contact_designation    text,
--     ADD COLUMN contact_email          text,
--     ADD COLUMN contact_home_phone     text,
--     ADD COLUMN contact_mobile_number  text,
--     ADD COLUMN contact_link           text,
--     ADD COLUMN contact_notes          text;
--   -- Then run a backfill JOIN to repopulate from contacts.

-- Final safety check: refuse to drop if anyone is still writing data here.
-- (Not foolproof, but catches the obvious case where this migration is
-- applied prematurely.)
DO $$
DECLARE
  recent_writes int;
BEGIN
  SELECT count(*) INTO recent_writes
  FROM public.listings
  WHERE updated_at > now() - interval '1 day'
    AND (
         (contact_name IS NOT NULL AND contact_name <> '')
      OR (contact_email IS NOT NULL AND contact_email <> '')
    );

  IF recent_writes > 0 THEN
    RAISE EXCEPTION
      'Found % listings updated in the last 24h with non-empty contact_* columns. Confirm the server-side change has shipped before applying this migration.',
      recent_writes;
  END IF;
END $$;

ALTER TABLE public.listings
  DROP COLUMN IF EXISTS contact_name,
  DROP COLUMN IF EXISTS contact_designation,
  DROP COLUMN IF EXISTS contact_email,
  DROP COLUMN IF EXISTS contact_home_phone,
  DROP COLUMN IF EXISTS contact_mobile_number,
  DROP COLUMN IF EXISTS contact_link,
  DROP COLUMN IF EXISTS contact_notes;

COMMENT ON COLUMN public.listings.contact_id IS
  'FK to contacts.id. The canonical source for contact_name/email/phone/etc; join when needed.';
