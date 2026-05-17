-- Contacts: created_by + updated_by audit columns.
--
-- 2026-05-14 smoke report finding: "P2 — Audit fields not populated:
-- created_by / updated_by are null on a freshly created contact even
-- though the request was authenticated."
--
-- Root cause: the columns either don't exist on this table or exist
-- without a DEFAULT that pulls from auth.uid(). Mirrors the pattern
-- already in use for `owner_user_id` on the same table — DB DEFAULT
-- = auth.uid() so the client never needs to send it.
--
-- This migration:
--   1. ADDs the columns IF NOT EXISTS (additive — works on envs that
--      already have them).
--   2. Sets DEFAULT auth.uid() for created_by (stamps once at INSERT).
--   3. Installs a BEFORE UPDATE trigger that stamps updated_by =
--      auth.uid() on every UPDATE (DEFAULT alone wouldn't fire on UPDATE).
--   4. Re-stamps existing NULL created_by rows from owner_user_id
--      (best-effort backfill — for rows that pre-date this migration).
--
-- The FK to public.profiles(id) ON DELETE SET NULL matches the
-- pattern used by other audit columns in this repo (e.g. notifications,
-- listings.updated_by).
--
-- Strictly additive. No reference table touched.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS set_contacts_updated_by ON public.contacts;
--   DROP FUNCTION IF EXISTS public.contacts_stamp_updated_by();
--   ALTER TABLE public.contacts
--     DROP COLUMN IF EXISTS updated_by,
--     DROP COLUMN IF EXISTS created_by;


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='contacts') THEN
    RAISE EXCEPTION 'Migration 20260514000007 requires public.contacts'
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. Add columns (idempotent)
-- =====================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.contacts.created_by IS
  'auth.uid() stamp at INSERT. Server-stamped via DEFAULT — clients NEVER pass this. See migration 20260514000007.';
COMMENT ON COLUMN public.contacts.updated_by IS
  'auth.uid() stamp at every UPDATE via the contacts_stamp_updated_by trigger. Server-stamped — clients NEVER pass this.';


-- =====================================================================
-- 2. Default for created_by (INSERT-time)
-- =====================================================================

ALTER TABLE public.contacts
  ALTER COLUMN created_by SET DEFAULT auth.uid();


-- =====================================================================
-- 3. Trigger for updated_by (UPDATE-time)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.contacts_stamp_updated_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS set_contacts_updated_by ON public.contacts;
CREATE TRIGGER set_contacts_updated_by
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_stamp_updated_by();


-- =====================================================================
-- 4. Backfill — created_by from owner_user_id for pre-existing rows
-- =====================================================================
-- One-shot for rows that pre-date this migration. owner_user_id is the
-- best stand-in (almost always who created the row in practice). Skips
-- rows where owner_user_id is null (impossible to attribute).

UPDATE public.contacts
   SET created_by = owner_user_id
 WHERE created_by IS NULL
   AND owner_user_id IS NOT NULL;


-- =====================================================================
-- 5. Refresh PostgREST schema cache
-- =====================================================================

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
-- Note: in the Supabase SQL editor, `auth.uid()` returns NULL because
-- the editor runs as `postgres`, not an authenticated end-user JWT.
-- The DB DEFAULT works for app traffic but fires NULL in the editor,
-- which then violates the NOT NULL constraint on owner_user_id.
-- For SQL-editor smoke, supply the required UUIDs explicitly.
--
-- 1) Columns exist with the right defaults.
-- SELECT column_name, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='contacts'
--    AND column_name IN ('created_by','updated_by');
-- Expect: created_by default = 'auth.uid()'; updated_by null (trigger
-- handles it on UPDATE).
--
-- 2) Trigger registered.
-- SELECT tgname FROM pg_trigger WHERE tgrelid='public.contacts'::regclass
--   AND tgname='set_contacts_updated_by';
--
-- 3) SQL-editor round-trip — supply owner_user_id + created_by from a
--    real profile row so the NOT NULL constraint is satisfied.
-- WITH any_profile AS (
--   SELECT id FROM public.profiles LIMIT 1
-- )
-- INSERT INTO public.contacts (full_name, owner_user_id, created_by)
-- SELECT 'audit-smoke', id, id FROM any_profile
-- RETURNING id, owner_user_id, created_by, updated_by;
--
-- UPDATE public.contacts SET notes = 'touch' WHERE full_name='audit-smoke'
--   RETURNING id, created_by, updated_by;
-- (updated_by stays NULL here too — trigger uses auth.uid() which is
--  NULL in SQL editor. Verifying the trigger fires requires real app
--  traffic OR a SET ROLE / impersonation block.)
--
-- DELETE FROM public.contacts WHERE full_name='audit-smoke';
--
-- 4) End-to-end (from the app, with a real session): create a contact
--    via POST /api/contacts, then verify both columns are populated:
-- SELECT id, owner_user_id, created_by, updated_by FROM public.contacts
--  WHERE id = (SELECT MAX(id) FROM public.contacts);
