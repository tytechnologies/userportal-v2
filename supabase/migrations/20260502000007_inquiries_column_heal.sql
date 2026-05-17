-- Defensive column heal for `public.inquiries`.
--
-- 20260502000006 used CREATE TABLE IF NOT EXISTS, which is a no-op when
-- a table by that name already exists. If the live DB had a stub
-- `inquiries` table from earlier work, the new columns (status,
-- assigned_user_id, message, etc.) never landed. The portal API then
-- 500s with `column inquiries.status does not exist`.
--
-- Fix: ALTER TABLE ADD COLUMN IF NOT EXISTS chasers for every column,
-- mirroring 000009's defensive shape. Constraints (CHECK, FK) are
-- DO-block guarded so re-running is safe.
--
-- DEPENDS ON:
--   20260502000006 (the original inquiries migration; this layers
--   on top whether or not 000006 fully applied)

-- =====================================================================
-- 1. Columns
-- =====================================================================

ALTER TABLE public.inquiries
  ADD COLUMN IF NOT EXISTS listing_id       bigint,
  ADD COLUMN IF NOT EXISTS assigned_user_id uuid,
  ADD COLUMN IF NOT EXISTS sender_name      text,
  ADD COLUMN IF NOT EXISTS sender_email     text,
  ADD COLUMN IF NOT EXISTS sender_phone     text,
  ADD COLUMN IF NOT EXISTS sender_user_id   uuid,
  ADD COLUMN IF NOT EXISTS message          text,
  ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'website',
  ADD COLUMN IF NOT EXISTS status           text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS replied_at       timestamptz,
  ADD COLUMN IF NOT EXISTS created_at       timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- =====================================================================
-- 2. CHECK constraints — guarded so re-runs are no-ops
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_status_check' AND conrelid = 'public.inquiries'::regclass) THEN
    ALTER TABLE public.inquiries
      ADD CONSTRAINT inquiries_status_check
      CHECK (status IN ('new', 'in_progress', 'replied', 'closed', 'spam'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_sender_contact_required' AND conrelid = 'public.inquiries'::regclass) THEN
    -- Only add if data is consistent (no rows with both email + phone null).
    IF NOT EXISTS (SELECT 1 FROM public.inquiries WHERE sender_email IS NULL AND sender_phone IS NULL) THEN
      ALTER TABLE public.inquiries
        ADD CONSTRAINT inquiries_sender_contact_required
        CHECK (sender_email IS NOT NULL OR sender_phone IS NOT NULL);
    ELSE
      RAISE NOTICE 'inquiries has rows with both email + phone NULL; skipping inquiries_sender_contact_required CHECK. Backfill those rows or relax the constraint manually.';
    END IF;
  END IF;
END $$;

-- =====================================================================
-- 3. FK constraints — guarded
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_listing_id_fkey' AND conrelid = 'public.inquiries'::regclass) THEN
    ALTER TABLE public.inquiries
      ADD CONSTRAINT inquiries_listing_id_fkey
      FOREIGN KEY (listing_id) REFERENCES public.listings(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_assigned_user_id_fkey' AND conrelid = 'public.inquiries'::regclass) THEN
    ALTER TABLE public.inquiries
      ADD CONSTRAINT inquiries_assigned_user_id_fkey
      FOREIGN KEY (assigned_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_sender_user_id_fkey' AND conrelid = 'public.inquiries'::regclass) THEN
    ALTER TABLE public.inquiries
      ADD CONSTRAINT inquiries_sender_user_id_fkey
      FOREIGN KEY (sender_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =====================================================================
-- 4. Make required columns NOT NULL (after their data is in place)
-- =====================================================================
--
-- The original migration declared these NOT NULL inline; if the table
-- pre-existed without them and we just ADDed them, they're nullable.
-- Tighten only if no rows violate.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.inquiries WHERE listing_id IS NULL) THEN
    ALTER TABLE public.inquiries ALTER COLUMN listing_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inquiries WHERE sender_name IS NULL) THEN
    ALTER TABLE public.inquiries ALTER COLUMN sender_name SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inquiries WHERE message IS NULL) THEN
    ALTER TABLE public.inquiries ALTER COLUMN message SET NOT NULL;
  END IF;
END $$;

-- =====================================================================
-- 5. Indexes — re-run-safe via IF NOT EXISTS
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_inquiries_listing_id    ON public.inquiries(listing_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_assigned      ON public.inquiries(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_status        ON public.inquiries(status);
CREATE INDEX IF NOT EXISTS idx_inquiries_created_at    ON public.inquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_assigned_new
  ON public.inquiries(assigned_user_id)
  WHERE status = 'new';

NOTIFY pgrst, 'reload schema';
