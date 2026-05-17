-- Break the infinite recursion between listings RLS and listing_shares RLS.
--
-- 20260501000008 added policies on listings that EXISTS-check
-- listing_shares (so accepted recipients can read), and policies on
-- listing_shares that EXISTS-check listings (so listing owners can see
-- shares on their own listings). When you query either table, RLS on
-- one table triggers a subquery against the other, which triggers RLS,
-- which triggers another subquery — infinite loop, 500 from PostgREST.
--
-- The clean fix is to factor the cross-table predicates into
-- SECURITY DEFINER functions that read with elevated privileges,
-- bypassing RLS inside the function body. RLS on each table then only
-- runs once: it calls the helper, the helper does a plain SELECT,
-- done.
--
-- DEPENDS ON:
--   public.listings, public.listing_shares (both with RLS already
--   enabled), public.has_permission, auth.uid()

-- =====================================================================
-- 1. SECURITY DEFINER helpers
-- =====================================================================

-- "Am I the owner of this listing?" — used by listing_shares policies.
-- SECURITY DEFINER bypasses listings RLS, so the call from inside a
-- listing_shares policy doesn't recurse.
CREATE OR REPLACE FUNCTION public.is_listing_owner(_listing_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.listings
    WHERE id = _listing_id
      AND created_by = auth.uid()
  );
$$;

-- "Do I have an active accepted share on this listing?" — used by
-- listings policies (read + write via share). Returns false for
-- expired or non-accepted rows.
CREATE OR REPLACE FUNCTION public.user_has_accepted_share(
  _listing_id bigint,
  _require_co_broker boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.listing_shares s
    WHERE s.listing_id = _listing_id
      AND s.shared_with_user_id = auth.uid()
      AND s.status = 'accepted'
      AND (s.expires_at IS NULL OR s.expires_at > now())
      AND (NOT _require_co_broker OR s.share_role = 'co_broker')
  );
$$;

-- Authenticated callers need EXECUTE; SECURITY DEFINER + STABLE makes
-- this safe (no side effects, no privilege amplification beyond the
-- two existence checks above).
GRANT EXECUTE ON FUNCTION public.is_listing_owner(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_accepted_share(bigint, boolean) TO authenticated;

-- =====================================================================
-- 2. Replace the recursive policies on listing_shares
-- =====================================================================

DROP POLICY IF EXISTS listing_shares_select ON public.listing_shares;
CREATE POLICY listing_shares_select
  ON public.listing_shares FOR SELECT
  TO authenticated
  USING (
    public.has_permission('listings.read.all')
    OR shared_with_user_id = auth.uid()
    OR public.is_listing_owner(listing_id)
  );

DROP POLICY IF EXISTS listing_shares_insert ON public.listing_shares;
CREATE POLICY listing_shares_insert
  ON public.listing_shares FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('listings.write.all')
    OR public.is_listing_owner(listing_id)
  );

DROP POLICY IF EXISTS listing_shares_update ON public.listing_shares;
CREATE POLICY listing_shares_update
  ON public.listing_shares FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('listings.write.all')
    OR shared_with_user_id = auth.uid()
    OR public.is_listing_owner(listing_id)
  )
  WITH CHECK (
    public.has_permission('listings.write.all')
    OR shared_with_user_id = auth.uid()
    OR public.is_listing_owner(listing_id)
  );

DROP POLICY IF EXISTS listing_shares_delete ON public.listing_shares;
CREATE POLICY listing_shares_delete
  ON public.listing_shares FOR DELETE
  TO authenticated
  USING (
    public.has_permission('listings.write.all')
    OR public.is_listing_owner(listing_id)
  );

-- =====================================================================
-- 3. Replace the recursive policies on listings (the share-extension
--    half added by 000008).
-- =====================================================================

DROP POLICY IF EXISTS listings_select_via_share ON public.listings;
CREATE POLICY listings_select_via_share
  ON public.listings FOR SELECT
  TO authenticated
  USING (
    public.user_has_accepted_share(id, false)
  );

DROP POLICY IF EXISTS listings_update_via_share ON public.listings;
CREATE POLICY listings_update_via_share
  ON public.listings FOR UPDATE
  TO authenticated
  USING (
    public.user_has_accepted_share(id, true)
  )
  WITH CHECK (
    public.user_has_accepted_share(id, true)
  );

NOTIFY pgrst, 'reload schema';
