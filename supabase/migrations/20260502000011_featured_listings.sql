-- Capture the existing baseline `featured_listings` table in this repo.
--
-- Background: app/pages/featured-listings.vue and app/pages/dashboard.vue
-- read + mutate `public.featured_listings`, but no migration in this
-- folder ever created it. Schema lived only in the live DB. That meant:
--   - Greenfield deploys silently 500'd on /featured-listings.
--   - The audit couldn't reason about RLS, FKs, or constraints because
--     the source-of-truth was outside this repo.
--
-- This migration is additive + defensive: if the table already exists
-- in the live DB (most environments), CREATE TABLE IF NOT EXISTS is a
-- no-op and the ALTER chasers patch any missing columns / FKs / RLS
-- without disturbing existing rows.
--
-- The page mutates rows by listing_id (insert / update position / delete
-- where listing_id = X), so listing_id is the natural key. We add a
-- unique index on it so insert-twice surfaces as a 23505 instead of
-- silently creating duplicate "featured" entries for the same listing.
--
-- DEPENDS ON: 20260429000006 (has_permission), 20260501000007 (anon
-- listings read — featured listings are publicly browsable).

-- =====================================================================
-- 1. Table shape
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.featured_listings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id  bigint NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Defensive heal: if the baseline table existed without one of these
-- columns, ADD COLUMN IF NOT EXISTS catches up.
ALTER TABLE public.featured_listings
  ADD COLUMN IF NOT EXISTS listing_id bigint,
  ADD COLUMN IF NOT EXISTS position   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_featured_listings_listing_id
  ON public.featured_listings(listing_id);
CREATE INDEX IF NOT EXISTS idx_featured_listings_position
  ON public.featured_listings(position);

DROP TRIGGER IF EXISTS set_featured_listings_updated_at ON public.featured_listings;
CREATE TRIGGER set_featured_listings_updated_at
  BEFORE UPDATE ON public.featured_listings
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- FK to listings — guarded so re-running on a DB where the FK already
-- exists is a no-op. ON DELETE CASCADE because a featured row pointing
-- at a deleted listing is meaningless and the page already trips on it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'featured_listings_listing_id_fkey'
      AND conrelid = 'public.featured_listings'::regclass
  ) THEN
    ALTER TABLE public.featured_listings
      ADD CONSTRAINT featured_listings_listing_id_fkey
      FOREIGN KEY (listing_id) REFERENCES public.listings(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON TABLE public.featured_listings IS
  'Editor-curated home-page deck for the public website. listing_id is unique; position drives display order. Public anon-readable; writes gated to managers+ via the new permission below.';

-- =====================================================================
-- 2. Permission catalog
-- =====================================================================
--
-- The legacy `permissionsStore` checked a string permission named
-- `edit_featured_listings`. The new RBAC dotted form is
-- `featured_listings.write` (read is anon-public, so no read perm).

INSERT INTO public.permissions (name, description, category) VALUES
  ('featured_listings.write', 'Manage the public home-page featured-listings deck', 'listings')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'featured_listings.write'),
  ('manager', 'featured_listings.write')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 3. RLS
-- =====================================================================
--
-- Read: anon + authenticated, unconditional. The deck is a public
-- marketing surface; if it's in the table, it's meant to be seen.
-- Write: gated on featured_listings.write — managers + admins only.

ALTER TABLE public.featured_listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS featured_listings_select_anon ON public.featured_listings;
CREATE POLICY featured_listings_select_anon
  ON public.featured_listings FOR SELECT
  TO anon
  USING (true);

DROP POLICY IF EXISTS featured_listings_select_authenticated ON public.featured_listings;
CREATE POLICY featured_listings_select_authenticated
  ON public.featured_listings FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS featured_listings_write ON public.featured_listings;
CREATE POLICY featured_listings_write
  ON public.featured_listings FOR ALL
  TO authenticated
  USING (public.has_permission('featured_listings.write'))
  WITH CHECK (public.has_permission('featured_listings.write'));

GRANT SELECT ON public.featured_listings TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
