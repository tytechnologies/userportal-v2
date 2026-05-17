-- Track price changes on listings.
--
-- Powers "Price reduced" / "Just listed" badges on the public marketplace.
-- The column is set by an AFTER trigger when sale_price or rent_price
-- changes on UPDATE (NOT on INSERT — first-set price isn't a "change",
-- it's the initial value).
--
-- Pairs with the existing listings.created_at: a listing card's badge
-- logic is:
--   created_at  >= now() - 7d  →  "Just listed"
--   else if price_changed_at >= now() - 7d  →  "Price reduced"
--   (or "Price changed" if neither went down — the badge text is a UX
--    decision; the column just records the timestamp.)
--
-- Backfill: existing rows get NULL — no historical price changes
-- reconstructable. New changes from this point forward populate.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS listings_track_price_change ON public.listings;
--   DROP FUNCTION IF EXISTS public.listings_track_price_change_fn();
--   ALTER TABLE public.listings DROP COLUMN IF EXISTS price_changed_at;
--
-- DEPENDS ON:
--   The base listings table.

-- =====================================================================
-- 1. Column
-- =====================================================================

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS price_changed_at timestamptz;

COMMENT ON COLUMN public.listings.price_changed_at IS
  'Timestamp of most recent sale_price / rent_price change. NULL for rows whose price has never changed since this column was added. Set by listings_track_price_change AFTER UPDATE trigger.';


-- =====================================================================
-- 2. Trigger function
-- =====================================================================

CREATE OR REPLACE FUNCTION public.listings_track_price_change_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only stamp when price genuinely changed. NULLs treated as
  -- "no value" — going from NULL → number is a change; number →
  -- same number isn't.
  IF NEW.sale_price IS DISTINCT FROM OLD.sale_price
     OR NEW.rent_price IS DISTINCT FROM OLD.rent_price THEN
    NEW.price_changed_at := now();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listings_track_price_change ON public.listings;
CREATE TRIGGER listings_track_price_change
  BEFORE UPDATE ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.listings_track_price_change_fn();


-- =====================================================================
-- 3. Index for the public-marketplace "recently changed" query
-- =====================================================================
--
-- Partial — only live rows participate; archived/deleted shouldn't
-- carry the badge regardless of when their price changed.

CREATE INDEX IF NOT EXISTS listings_price_changed_recent_idx
  ON public.listings(price_changed_at DESC)
  WHERE is_online = true
    AND deleted_at IS NULL
    AND price_changed_at IS NOT NULL;


-- =====================================================================
-- 4. Refresh PostgREST schema cache
-- =====================================================================

NOTIFY pgrst, 'reload schema';
