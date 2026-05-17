-- Add a public-facing slug to profiles + extend public_profiles to expose it.
--
-- Powers /agent/<slug> public agent profile pages on the marketplace
-- website. URL pattern matches industry convention (Zillow, Trulia,
-- Trustpilot all use slugged agent profiles for SEO).
--
-- Compatibility:
--   - public_profiles is replaced via CREATE OR REPLACE VIEW with the
--     same column list PLUS slug. Existing consumers that select
--     `full_name, avatar_url` (e.g. server/api/public/agent-card.get.ts)
--     keep working byte-for-byte.
--   - profiles' existing column set is unchanged. The new `slug` column
--     is nullable so the migration applies even if backfill is partial.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS profiles_set_slug ON public.profiles;
--   DROP FUNCTION IF EXISTS public.profiles_derive_slug();
--   DROP INDEX IF EXISTS public.profiles_slug_unique_idx;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS slug;
--   CREATE OR REPLACE VIEW public.public_profiles AS
--     SELECT id, full_name, avatar_url, role FROM public.profiles;
--
-- DEPENDS ON:
--   20260429000001_create_profiles_table.sql
--   20260501000012_profiles_anon_pii_lockdown.sql

-- =====================================================================
-- 1. Add the column
-- =====================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS slug text;

COMMENT ON COLUMN public.profiles.slug IS
  'URL-safe identifier for /agent/<slug> public profile pages. Derived from full_name on insert via the profiles_set_slug trigger; persistent across renames. Nullable as a transitional state — partial unique index allows NULLs.';

-- =====================================================================
-- 2. Slug derivation function (shared between backfill + trigger)
-- =====================================================================
--
-- Pretty slug from full_name (lowercased, non-alphanumerics → hyphens,
-- collapsed runs, trimmed). Falls back to email local-part, then to
-- 'agent-<id-prefix>' if both are missing. Always returns a non-empty
-- value.
--
-- NOT responsible for uniqueness — caller (trigger or backfill) handles
-- collision suffixes.

CREATE OR REPLACE FUNCTION public.profiles_base_slug(
  p_full_name text,
  p_email     text,
  p_id        uuid
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_source text;
  v_slug   text;
BEGIN
  v_source := nullif(trim(coalesce(p_full_name, '')), '');
  IF v_source IS NULL THEN
    v_source := nullif(split_part(coalesce(p_email, ''), '@', 1), '');
  END IF;

  IF v_source IS NULL THEN
    -- Last-resort fallback: use the first 8 hex chars of the uuid.
    -- Always non-empty, always slug-safe.
    RETURN 'agent-' || substr(replace(p_id::text, '-', ''), 1, 8);
  END IF;

  v_slug := lower(v_source);
  v_slug := regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g');
  v_slug := regexp_replace(v_slug, '(^-+|-+$)', '', 'g');

  IF v_slug = '' OR v_slug IS NULL THEN
    RETURN 'agent-' || substr(replace(p_id::text, '-', ''), 1, 8);
  END IF;

  RETURN v_slug;
END
$$;

-- =====================================================================
-- 3. Backfill existing rows
-- =====================================================================
--
-- First row per base_slug keeps the pretty slug; the rest get an
-- id-prefix suffix for disambiguation. Deterministic — sorting by id
-- means re-running the migration produces the same assignment.

WITH base AS (
  SELECT
    id,
    public.profiles_base_slug(full_name, email, id) AS base_slug
  FROM public.profiles
  WHERE slug IS NULL
),
ranked AS (
  SELECT
    id,
    base_slug,
    row_number() OVER (PARTITION BY base_slug ORDER BY id) AS rn
  FROM base
)
UPDATE public.profiles p
SET    slug = CASE
         WHEN r.rn = 1 THEN r.base_slug
         ELSE r.base_slug || '-' || substr(replace(p.id::text, '-', ''), 1, 6)
       END
FROM   ranked r
WHERE  p.id = r.id
  AND  p.slug IS NULL;

-- =====================================================================
-- 4. Partial unique index
-- =====================================================================
--
-- Partial so any future trigger race or unbackfilled row (slug IS NULL)
-- doesn't block all writes. Once a slug is set, it's strictly unique.

CREATE UNIQUE INDEX IF NOT EXISTS profiles_slug_unique_idx
  ON public.profiles(slug)
  WHERE slug IS NOT NULL;

-- =====================================================================
-- 5. Auto-populate trigger
-- =====================================================================
--
-- Fires on INSERT (new row, slug not provided) and on UPDATE only when
-- slug is being set NULL deliberately (full_name change WITHOUT slug
-- replacement). Once slug has a value, it's persistent — renames don't
-- silently change the public URL (would break SEO + inbound links).

CREATE OR REPLACE FUNCTION public.profiles_derive_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_base text;
  v_try  text;
  v_n    int := 0;
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
    -- Caller provided a slug explicitly; respect it. Unique index
    -- catches any collision.
    RETURN NEW;
  END IF;

  v_base := public.profiles_base_slug(NEW.full_name, NEW.email, NEW.id);

  -- First attempt: the pretty slug.
  v_try := v_base;

  -- Probe-and-suffix loop. Each iteration appends a longer id-prefix
  -- until uniqueness is achieved. Bounded by the uuid string length —
  -- in practice the first or second probe always wins.
  WHILE v_n < 4 LOOP
    PERFORM 1
    FROM public.profiles
    WHERE slug = v_try
      AND id <> NEW.id
    LIMIT 1;

    IF NOT FOUND THEN
      NEW.slug := v_try;
      RETURN NEW;
    END IF;

    v_n := v_n + 1;
    v_try := v_base || '-' || substr(replace(NEW.id::text, '-', ''), 1, 4 + v_n * 2);
  END LOOP;

  -- Belt-and-braces: if 4 probes all collided, fall through to the
  -- full id-suffix form. Practically unreachable.
  NEW.slug := v_base || '-' || replace(NEW.id::text, '-', '');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS profiles_set_slug ON public.profiles;
CREATE TRIGGER profiles_set_slug
  BEFORE INSERT OR UPDATE OF slug, full_name ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_derive_slug();

-- =====================================================================
-- 6. Re-create public_profiles to expose slug
-- =====================================================================
--
-- Same column set + slug. Anon callers that already SELECT
-- full_name, avatar_url, etc. keep working — slug is just available
-- to anyone that asks for it.

CREATE OR REPLACE VIEW public.public_profiles AS
SELECT
  id,
  full_name,
  avatar_url,
  role,
  slug
FROM public.profiles;

COMMENT ON VIEW public.public_profiles IS
  'Anon-safe projection of profiles. Exposes only id / full_name / avatar_url / role / slug. Use this from the public website instead of reading profiles directly.';

GRANT SELECT ON public.public_profiles TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
