-- Listing shares (co-brokering primitive).
--
-- A row in listing_shares grants a non-owner agent access to a listing
-- with a defined role:
--   - 'co_broker' → can edit the listing, take inquiries, generate docs
--   - 'viewer'    → can read but not write
--
-- The model is intentionally NOT "the listing has multiple owners".
-- The owner remains listings.created_by; sharing is layered on top.
-- That keeps the listings RLS sane and lets us revoke sharing without
-- ownership chaos.
--
-- Listings RLS is extended at the policy level: the existing
-- listings_select_role_scoped + listings_update_role_scoped policies
-- get an additional EXISTS branch checking listing_shares so a shared
-- agent can read/edit the parent row.
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql (current_user_role helpers)

CREATE TABLE IF NOT EXISTS public.listing_shares (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    bigint NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  -- Who is being granted access.
  shared_with_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Who did the granting (audit + revocation authority).
  shared_by_user_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  share_role    text NOT NULL CHECK (share_role IN ('co_broker', 'viewer')) DEFAULT 'co_broker',
  -- 'pending' = awaiting accept; 'accepted' = active; 'revoked' = killed.
  status        text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')) DEFAULT 'pending',
  message       text,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One share per (listing, recipient). Re-shares update the existing row.
  UNIQUE (listing_id, shared_with_user_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_shares_listing
  ON public.listing_shares(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_shares_recipient
  ON public.listing_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_listing_shares_status
  ON public.listing_shares(status);

DROP TRIGGER IF EXISTS set_listing_shares_updated_at ON public.listing_shares;
CREATE TRIGGER set_listing_shares_updated_at
  BEFORE UPDATE ON public.listing_shares
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.listing_shares IS
  'Co-brokering: row grants a non-owner agent access to a listing. Listings RLS extended to honor accepted shares.';

-- =====================================================================
-- Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('listings.share',  'Share a listing with another agent (co-broker)', 'listings'),
  ('listings.accept_share', 'Accept a shared listing invite',          'listings')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'listings.share'),
  ('admin',   'listings.accept_share'),
  ('manager', 'listings.share'),
  ('manager', 'listings.accept_share'),
  ('agent',   'listings.share'),
  ('agent',   'listings.accept_share')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- RLS on listing_shares itself
-- =====================================================================

ALTER TABLE public.listing_shares ENABLE ROW LEVEL SECURITY;

-- READ: the owner of the parent listing OR the recipient OR an admin.
DROP POLICY IF EXISTS listing_shares_select ON public.listing_shares;
CREATE POLICY listing_shares_select
  ON public.listing_shares FOR SELECT
  TO authenticated
  USING (
    public.has_permission('listings.read.all')
    OR shared_with_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.listings l
      WHERE l.id = listing_shares.listing_id
        AND l.created_by = auth.uid()
    )
  );

-- INSERT: only listing owners or admins can share. Recipient gets to
-- accept/decline via UPDATE (status flip) below.
DROP POLICY IF EXISTS listing_shares_insert ON public.listing_shares;
CREATE POLICY listing_shares_insert
  ON public.listing_shares FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('listings.write.all')
    OR EXISTS (
      SELECT 1 FROM public.listings l
      WHERE l.id = listing_shares.listing_id
        AND l.created_by = auth.uid()
    )
  );

-- UPDATE: owner can revoke; recipient can accept/decline (= status
-- transitions). Restrict via WITH CHECK so a recipient can't repurpose
-- their own row to grant themselves co_broker on someone else's
-- listing.
DROP POLICY IF EXISTS listing_shares_update ON public.listing_shares;
CREATE POLICY listing_shares_update
  ON public.listing_shares FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('listings.write.all')
    OR shared_with_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.listings l
      WHERE l.id = listing_shares.listing_id
        AND l.created_by = auth.uid()
    )
  )
  WITH CHECK (
    public.has_permission('listings.write.all')
    OR shared_with_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.listings l
      WHERE l.id = listing_shares.listing_id
        AND l.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS listing_shares_delete ON public.listing_shares;
CREATE POLICY listing_shares_delete
  ON public.listing_shares FOR DELETE
  TO authenticated
  USING (
    public.has_permission('listings.write.all')
    OR EXISTS (
      SELECT 1 FROM public.listings l
      WHERE l.id = listing_shares.listing_id
        AND l.created_by = auth.uid()
    )
  );

-- =====================================================================
-- Extend listings RLS to honor shares
-- =====================================================================
--
-- We add a NEW policy `listings_select_via_share` so an accepted
-- recipient can SELECT the listing. Postgres ORs permissive policies,
-- so this composes cleanly with the existing role-scoped policy.
--
-- For UPDATE we extend similarly, gated on share_role = 'co_broker'.

DROP POLICY IF EXISTS listings_select_via_share ON public.listings;
CREATE POLICY listings_select_via_share
  ON public.listings FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.listing_shares s
      WHERE s.listing_id = listings.id
        AND s.shared_with_user_id = auth.uid()
        AND s.status = 'accepted'
        AND (s.expires_at IS NULL OR s.expires_at > now())
    )
  );

DROP POLICY IF EXISTS listings_update_via_share ON public.listings;
CREATE POLICY listings_update_via_share
  ON public.listings FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.listing_shares s
      WHERE s.listing_id = listings.id
        AND s.shared_with_user_id = auth.uid()
        AND s.share_role = 'co_broker'
        AND s.status = 'accepted'
        AND (s.expires_at IS NULL OR s.expires_at > now())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.listing_shares s
      WHERE s.listing_id = listings.id
        AND s.shared_with_user_id = auth.uid()
        AND s.share_role = 'co_broker'
        AND s.status = 'accepted'
        AND (s.expires_at IS NULL OR s.expires_at > now())
    )
  );

NOTIFY pgrst, 'reload schema';
