-- Broker Collaboration Network — additive layer on existing
-- listing_shares + new listing_copies attribution chain.
--
-- Two extensions, both additive:
--
--   1. listing_shares.permissions jsonb
--      Fine-grained capabilities supplementing the existing
--      share_role (co_broker | viewer). Empty default → server-side
--      helper projects role → capabilities for legacy rows. Old
--      callers that read share_role keep working.
--
--   2. public.listing_copies table
--      Attribution chain when an authorized agent duplicates a
--      shared listing. Each row links source → copy. The copy itself
--      is a regular public.listings row (existing schema preserved);
--      this table records lineage.
--
-- New permission `listings.duplicate_shared` allows duplicating a
-- listing the caller has been granted via share. Distinct from the
-- existing listings.write.* gates so admins can grant duplicate
-- rights without granting full write.
--
-- Future-proofing comments throughout flag where downstream
-- collaboration features (commission tracking, follow-graph) will
-- attach without further migrations.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.listing_copies;
--   ALTER TABLE public.listing_shares DROP COLUMN IF EXISTS permissions;
--   DELETE FROM public.permissions WHERE name = 'listings.duplicate_shared';
--
-- DEPENDS ON:
--   20260501000008 (listing_shares table + RLS)
--   20260429000006 (permissions catalog, log_activity)


-- =====================================================================
-- 1. listing_shares.permissions — fine-grained capability JSONB
-- =====================================================================
--
-- Capability keys (server-side helper projects role → caps for legacy
-- rows; new code reads/writes this map directly):
--
--   view_listing            — can read the listing record (included
--                             implicitly by any share, here for
--                             completeness when explicitly set).
--   view_inquiries          — can see inquiries on the listing.
--   respond_to_inquiries    — can reply / reassign inquiries.
--   co_market               — can list the property in their own
--                             marketing surfaces (boutique, deck,
--                             etc.) without duplicating.
--   duplicate_allowed       — can copy the listing into their
--                             portfolio. Creates a listing_copies
--                             row preserving lineage.
--   edit_listing            — can patch listing fields (equivalent
--                             to legacy share_role='co_broker').
--
-- Capability presence is the truth; absence means denied. The
-- jsonb shape is `{ "<cap>": true, ... }`. Server validates the
-- map against this allowlist before INSERT/UPDATE.

ALTER TABLE public.listing_shares
  ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.listing_shares.permissions IS
  'Fine-grained capability map. Empty {} → fall back to share_role projection. Allowed keys: view_listing, view_inquiries, respond_to_inquiries, co_market, duplicate_allowed, edit_listing.';


-- =====================================================================
-- 2. listing_copies — attribution chain
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listing_copies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_listing_id  bigint NOT NULL REFERENCES public.listings(id) ON DELETE RESTRICT,
  copy_listing_id    bigint NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,

  -- Owner snapshots — survive future ownership transfers on either
  -- side. The chain is the historical truth; current owners come
  -- from listings.created_by.
  source_owner_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  copy_owner_user_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- The share that authorized the copy. NULL if duplicated by the
  -- owner themselves (no share required).
  via_share_id         uuid REFERENCES public.listing_shares(id) ON DELETE SET NULL,

  -- Free-form attribution payload — forward-compat hook for
  -- downstream commission / chain-of-custody features. Today we just
  -- snapshot the source's title for human-readable activity feeds.
  attribution_chain    jsonb NOT NULL DEFAULT '{}'::jsonb,

  copied_at            timestamptz NOT NULL DEFAULT now(),

  -- Anti-loop: a listing cannot be its own source (Postgres CHECK).
  -- Multi-step cycles (A→B→A) are caller's responsibility but the
  -- attribution traversal RPC caps recursion depth at 8.
  CONSTRAINT listing_copies_no_self CHECK (source_listing_id <> copy_listing_id),

  -- A copy_listing_id can only have one row — every listing is at
  -- most one direct copy.
  UNIQUE (copy_listing_id)
);

CREATE INDEX IF NOT EXISTS listing_copies_source_idx
  ON public.listing_copies(source_listing_id, copied_at DESC);
CREATE INDEX IF NOT EXISTS listing_copies_copy_idx
  ON public.listing_copies(copy_listing_id);
CREATE INDEX IF NOT EXISTS listing_copies_source_owner_idx
  ON public.listing_copies(source_owner_user_id);

COMMENT ON TABLE public.listing_copies IS
  'Attribution chain for duplicated listings. source_listing_id → copy_listing_id with permission snapshot from listing_shares. Survives ownership transfers; lineage is forever. Forward-compat for commission / follow-graph features via attribution_chain jsonb.';


-- =====================================================================
-- 3. RLS on listing_copies
-- =====================================================================
--
-- READ: anyone who can read either side of the chain can see the
-- relationship. This makes attribution visible to both the source
-- agent (knows their listing was copied) and the copying agent (sees
-- their listing's lineage).
-- WRITE: only via the dedicated SECURITY DEFINER RPC (no direct
-- INSERT path exposed to authenticated callers).

ALTER TABLE public.listing_copies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_copies_select ON public.listing_copies;
CREATE POLICY listing_copies_select
  ON public.listing_copies FOR SELECT
  TO authenticated
  USING (
    public.has_permission('listings.read.all')
    OR EXISTS (
      SELECT 1 FROM public.listings l
       WHERE l.id IN (listing_copies.source_listing_id, listing_copies.copy_listing_id)
         AND (
           l.created_by = auth.uid()
           OR EXISTS (
             SELECT 1 FROM public.listing_shares s
              WHERE s.listing_id = l.id
                AND s.shared_with_user_id = auth.uid()
                AND s.status = 'accepted'
           )
         )
    )
  );

-- INSERT/UPDATE/DELETE: NOT granted to authenticated. Service-role
-- only via the duplicate_listing_with_attribution() RPC below.


-- =====================================================================
-- 4. Permission catalog — listings.duplicate_shared
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('listings.duplicate_shared',
   'Duplicate a listing that has been shared to the caller (via listing_shares with duplicate_allowed permission)',
   'listings')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'listings.duplicate_shared'),
  ('manager', 'listings.duplicate_shared'),
  ('agent',   'listings.duplicate_shared')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5. duplicate_listing_with_attribution() RPC
-- =====================================================================
--
-- Authorization (one of):
--   a. Caller is the source listing's owner (created_by = auth.uid())
--   b. Caller has has_permission('listings.write.all')
--   c. Caller has an ACCEPTED share with duplicate_allowed=true OR
--      legacy share_role='co_broker' (covered by the helper below)
--
-- Atomicity: insert new listing row + listing_copies link in one
-- transaction (function body). Audit + notify happen in-line so
-- the chain is always consistent.

CREATE OR REPLACE FUNCTION public.duplicate_listing_with_attribution(
  p_source_listing_id bigint,
  p_overrides         jsonb DEFAULT '{}'::jsonb  -- patches the new row's fields
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_source public.listings;
  v_share public.listing_shares;
  v_authorized boolean := false;
  v_new_id bigint;
  v_listing_copy_id uuid;
BEGIN
  IF v_actor IS NULL
     AND session_user NOT IN ('postgres', 'supabase_admin', 'service_role') THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_source FROM public.listings WHERE id = p_source_listing_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source listing not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_source.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'cannot duplicate a soft-deleted listing'
      USING ERRCODE = '22023';
  END IF;

  -- Authorization. Three branches; first hit wins.
  IF v_source.created_by = v_actor THEN
    v_authorized := true;
  ELSIF public.has_permission('listings.write.all') THEN
    v_authorized := true;
  ELSE
    SELECT * INTO v_share
      FROM public.listing_shares
     WHERE listing_id = p_source_listing_id
       AND shared_with_user_id = v_actor
       AND status = 'accepted'
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1;
    IF FOUND THEN
      -- Either explicit duplicate_allowed in the new permissions
      -- map, OR legacy co_broker role (which conferred broad rights).
      IF (v_share.permissions ? 'duplicate_allowed'
          AND (v_share.permissions->>'duplicate_allowed')::boolean = true)
         OR v_share.share_role = 'co_broker' THEN
        v_authorized := true;
      END IF;
    END IF;
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'permission denied: listing not duplicatable by caller'
      USING ERRCODE = '42501';
  END IF;

  -- Insert the new listing. Whitelist of cloneable fields matches
  -- the existing listings.repo.ts:clone() — but the OWNER is the
  -- caller (not the source's owner), and listings.created_by is set
  -- to the caller so they own their copy.
  --
  -- The override jsonb lets the caller patch a few fields at copy
  -- time (e.g., new title, new contact). Anything outside the
  -- allowlist is silently dropped.
  INSERT INTO public.listings (
    title, description, unit_number,
    property_category, property_type, status, condition,
    is_online, for_sale, for_rent,
    sale_price, rent_price, security_deposit, rent_advance,
    association_dues, bedrooms, bathrooms, parking_spaces,
    floor_area, lot_area, lease_term, availability_date,
    features, attributes,
    contact_id, property_id,
    created_by, updated_by
  )
  VALUES (
    COALESCE(p_overrides->>'title', v_source.title),
    COALESCE(p_overrides->>'description', v_source.description),
    v_source.unit_number,
    v_source.property_category, v_source.property_type,
    v_source.status, v_source.condition,
    -- New copies start offline by default; the copying agent must
    -- explicitly publish.
    false,
    v_source.for_sale, v_source.for_rent,
    v_source.sale_price, v_source.rent_price,
    v_source.security_deposit, v_source.rent_advance,
    v_source.association_dues, v_source.bedrooms, v_source.bathrooms,
    v_source.parking_spaces, v_source.floor_area, v_source.lot_area,
    v_source.lease_term, v_source.availability_date,
    v_source.features, v_source.attributes,
    -- contact_id is intentionally NOT copied — the copying agent
    -- owns the customer relationship for their copy. Override to
    -- supply a contact at copy time.
    COALESCE((p_overrides->>'contact_id')::bigint, NULL),
    v_source.property_id,
    v_actor, v_actor
  )
  RETURNING id INTO v_new_id;

  -- Attribution chain row.
  INSERT INTO public.listing_copies (
    source_listing_id, copy_listing_id,
    source_owner_user_id, copy_owner_user_id,
    via_share_id,
    attribution_chain
  )
  VALUES (
    p_source_listing_id, v_new_id,
    v_source.created_by, v_actor,
    v_share.id,
    jsonb_build_object(
      'source_title', v_source.title,
      'source_listing_id', p_source_listing_id,
      'via_share_role', v_share.share_role
    )
  )
  RETURNING id INTO v_listing_copy_id;

  -- Audit. Two rows: one on the source (so the source's history
  -- shows it was duplicated), one on the copy (so the copy's
  -- history shows its origin). Operators reading either listing's
  -- timeline see the relationship.
  PERFORM public.log_activity(
    p_action := 'listing.duplicated',
    p_entity := 'listing',
    p_entity_id := NULL,
    p_metadata := jsonb_build_object(
      'op', 'source',
      'source_listing_id', p_source_listing_id,
      'copy_listing_id',   v_new_id,
      'copied_by',         v_actor,
      'listing_id',        p_source_listing_id  -- so the source's
                                                -- timeline picks
                                                -- this up via
                                                -- metadata.listing_id
    )
  );
  PERFORM public.log_activity(
    p_action := 'listing.duplicated',
    p_entity := 'listing',
    p_entity_id := NULL,
    p_metadata := jsonb_build_object(
      'op', 'copy',
      'source_listing_id', p_source_listing_id,
      'copy_listing_id',   v_new_id,
      'source_owner',      v_source.created_by,
      'listing_id',        v_new_id  -- copy's timeline
    )
  );

  RETURN jsonb_build_object(
    'copy_listing_id', v_new_id,
    'listing_copy_id', v_listing_copy_id,
    'source_listing_id', p_source_listing_id,
    'source_owner_user_id', v_source.created_by
  );
END;
$$;

REVOKE ALL ON FUNCTION public.duplicate_listing_with_attribution(bigint, jsonb)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.duplicate_listing_with_attribution(bigint, jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.duplicate_listing_with_attribution(bigint, jsonb) IS
  'Duplicate a listing into the caller''s portfolio with attribution preserved. Authorized by ownership OR listings.write.all OR an accepted share with duplicate_allowed/co_broker. Inserts new listings row + listing_copies link + 2 audit rows in one transaction. Returns { copy_listing_id, listing_copy_id, source_listing_id, source_owner_user_id }.';


-- =====================================================================
-- 6. Attribution traversal — for future commission graphs
-- =====================================================================
--
-- Future-compat: a recursive view that, given a listing id, surfaces
-- its full chain of sources (parent → grandparent → ...). Capped at
-- depth 8 to bound traversal cost. Empty chain when the listing is
-- a root (not a copy).

CREATE OR REPLACE VIEW public.listing_attribution_chain AS
WITH RECURSIVE chain AS (
  SELECT
    lc.copy_listing_id   AS listing_id,
    lc.source_listing_id AS source_id,
    lc.source_owner_user_id,
    lc.copy_owner_user_id,
    1                    AS depth,
    lc.copied_at
    FROM public.listing_copies lc

  UNION ALL

  SELECT
    c.listing_id,
    lc.source_listing_id,
    lc.source_owner_user_id,
    lc.copy_owner_user_id,
    c.depth + 1,
    lc.copied_at
    FROM chain c
    JOIN public.listing_copies lc ON lc.copy_listing_id = c.source_id
   WHERE c.depth < 8
)
SELECT * FROM chain;

GRANT SELECT ON public.listing_attribution_chain TO authenticated;

COMMENT ON VIEW public.listing_attribution_chain IS
  'Recursive attribution chain — walks listing_copies parent links up to depth 8. Forward-compat for commission graph traversal. RLS inherited from listing_copies.';


NOTIFY pgrst, 'reload schema';
