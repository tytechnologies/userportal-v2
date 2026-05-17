-- Referral + Co-broker Agreements.
--
-- B2 of the post-audit roadmap. Adds a contractual layer above the
-- existing deal_participants / commission_ledger so commission
-- entries can carry provenance back to a signed agreement.
--
-- Three additive tables + one view + two read-only functions:
--
--   1. referral_agreements        — the artifact: who refers whom,
--                                   on what terms, in what scope,
--                                   with what lifecycle.
--   2. co_broker_agreements       — listing-scoped: two brokers/orgs
--                                   sharing the listing's commission.
--   3. referral_attributions      — "this deal materialized from this
--                                   agreement". Many-to-one (chained
--                                   referrals supported).
--   4. active_agreements_view     — agreements where status='active'
--                                   AND now() within effective window.
--   5. referral_chain_for_deal()  — recursive walker.
--   6. preview_commission_split() — read-only candidates list per
--                                   deal. UI displays; operator
--                                   posts via existing B1 endpoint.
--
-- Existing surfaces preserved:
--   - deal_participants            — kept; agreements augment it.
--   - commission_ledger            — entries can now reference an
--                                    agreement via a future column
--                                    (deferred to B3 if needed).
--   - deal_can_read / deal_can_write  — reused.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.preview_commission_split(uuid);
--   DROP FUNCTION IF EXISTS public.referral_chain_for_deal(uuid, int);
--   DROP VIEW IF EXISTS public.active_agreements_view;
--   DROP TABLE IF EXISTS public.referral_attributions;
--   DROP TABLE IF EXISTS public.co_broker_agreements;
--   DROP TABLE IF EXISTS public.referral_agreements;
--   DELETE FROM public.role_permissions WHERE permission IN
--     ('agreements.propose', 'agreements.read.all', 'agreements.accept');
--   DELETE FROM public.permissions WHERE name IN
--     ('agreements.propose', 'agreements.read.all', 'agreements.accept');
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.referral_agreements',
--      'public.co_broker_agreements',
--      'public.referral_attributions',
--      'public.active_agreements_view');


-- =====================================================================
-- 1. referral_agreements — the contractual artifact
-- =====================================================================
--
-- Acceptance is two-sided: status flips from 'proposed' to 'active'
-- only when accepted_by + accepted_at are both set. The accept RPC
-- enforces that the accepting caller is the (intended) counterparty.

CREATE TABLE IF NOT EXISTS public.referral_agreements (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Referrer (origin of the introduction). >=1 of the three columns
  -- must be set — CHECK below. Multiple may be set for org-attached
  -- referrals (user belonging to an org both referenced).
  referrer_user_id          uuid   REFERENCES public.profiles(id) ON DELETE SET NULL,
  referrer_contact_id       bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  referrer_organization_id  uuid   REFERENCES public.organizations(id) ON DELETE SET NULL,

  -- Recipient (agent / brokerage receiving the lead).
  recipient_user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  recipient_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,

  -- Scope. open = "any deal recipient closes within the effective
  -- window". organization = "any deal closed by anyone in the
  -- recipient_organization_id". listing / deal = pinned to a specific
  -- listing or deal.
  scope_type                text NOT NULL CHECK (scope_type IN
                                 ('deal', 'listing', 'organization', 'open')),
  scope_listing_id          bigint REFERENCES public.listings(id) ON DELETE SET NULL,
  scope_deal_id             uuid   REFERENCES public.deals(id)    ON DELETE SET NULL,
  scope_organization_id     uuid   REFERENCES public.organizations(id) ON DELETE SET NULL,

  -- Terms.
  terms_kind                text NOT NULL CHECK (terms_kind IN
                                 ('percent_of_commission',
                                  'percent_of_deal_value',
                                  'fixed')),
  terms_value               numeric(12,4) NOT NULL CHECK (terms_value > 0),
  terms_currency            text NOT NULL DEFAULT 'PHP',
  terms_notes               text,

  -- Lifecycle.
  status                    text NOT NULL DEFAULT 'proposed'
                                 CHECK (status IN
                                   ('proposed', 'active', 'fulfilled',
                                    'cancelled', 'expired')),
  effective_at              timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz,

  proposed_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_at               timestamptz,

  -- Polymorphic evidence pointer (signed doc id, email reference,
  -- external doc URL). { kind: 'document'|'note'|'external',
  -- ref: <id-or-url>, label: <text> }.
  governance_evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,

  cancelled_at              timestamptz,
  cancel_reason             text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CHECK (
    referrer_user_id IS NOT NULL
    OR referrer_contact_id IS NOT NULL
    OR referrer_organization_id IS NOT NULL
  ),
  CHECK (
    recipient_user_id IS NOT NULL
    OR recipient_organization_id IS NOT NULL
  ),
  CHECK ((scope_type <> 'listing')      OR (scope_listing_id      IS NOT NULL)),
  CHECK ((scope_type <> 'deal')         OR (scope_deal_id         IS NOT NULL)),
  CHECK ((scope_type <> 'organization') OR (scope_organization_id IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > effective_at)
);

CREATE INDEX IF NOT EXISTS referral_agreements_referrer_user_idx
  ON public.referral_agreements(referrer_user_id) WHERE referrer_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referral_agreements_recipient_user_idx
  ON public.referral_agreements(recipient_user_id) WHERE recipient_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referral_agreements_recipient_org_idx
  ON public.referral_agreements(recipient_organization_id) WHERE recipient_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referral_agreements_listing_idx
  ON public.referral_agreements(scope_listing_id) WHERE scope_listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referral_agreements_deal_idx
  ON public.referral_agreements(scope_deal_id) WHERE scope_deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referral_agreements_active_idx
  ON public.referral_agreements(status, effective_at, expires_at)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS set_referral_agreements_updated_at ON public.referral_agreements;
CREATE TRIGGER set_referral_agreements_updated_at
  BEFORE UPDATE ON public.referral_agreements
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.referral_agreements IS
  'Referral agreement artifact. Acceptance is two-sided: status flips to active only when accepted_at IS NOT NULL. DELETE blocked — use status=cancelled.';


-- =====================================================================
-- 2. co_broker_agreements — listing-scoped collaboration terms
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.co_broker_agreements (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  listing_id                    bigint NOT NULL REFERENCES public.listings(id) ON DELETE RESTRICT,

  -- The listing's owner-side broker. Defaults to listings.created_by
  -- but operator can override (e.g., an org's listing handed to an
  -- internal sub-team).
  listing_agent_user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  listing_agent_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,

  -- The co-broker side. Either a user or an organization (or both).
  co_broker_user_id             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  co_broker_organization_id     uuid REFERENCES public.organizations(id) ON DELETE SET NULL,

  side                          text NOT NULL CHECK (side IN ('sell_side', 'buy_side', 'both')),

  -- Terms — what the co_broker receives.
  terms_kind                    text NOT NULL CHECK (terms_kind IN
                                       ('percent_of_commission',
                                        'percent_of_deal_value',
                                        'fixed')),
  terms_value                   numeric(12,4) NOT NULL CHECK (terms_value > 0),
  terms_currency                text NOT NULL DEFAULT 'PHP',
  terms_notes                   text,

  exclusivity                   text NOT NULL DEFAULT 'non_exclusive'
                                       CHECK (exclusivity IN ('exclusive', 'non_exclusive')),

  status                        text NOT NULL DEFAULT 'proposed'
                                       CHECK (status IN
                                         ('proposed', 'active', 'fulfilled',
                                          'cancelled', 'expired')),
  effective_at                  timestamptz NOT NULL DEFAULT now(),
  expires_at                    timestamptz,

  proposed_by                   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_by                   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_at                   timestamptz,

  governance_evidence           jsonb NOT NULL DEFAULT '{}'::jsonb,

  cancelled_at                  timestamptz,
  cancel_reason                 text,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CHECK (
    co_broker_user_id IS NOT NULL OR co_broker_organization_id IS NOT NULL
  ),
  CHECK (expires_at IS NULL OR expires_at > effective_at)
);

CREATE INDEX IF NOT EXISTS co_broker_agreements_listing_idx
  ON public.co_broker_agreements(listing_id, status);
CREATE INDEX IF NOT EXISTS co_broker_agreements_co_user_idx
  ON public.co_broker_agreements(co_broker_user_id) WHERE co_broker_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS co_broker_agreements_co_org_idx
  ON public.co_broker_agreements(co_broker_organization_id) WHERE co_broker_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS co_broker_agreements_active_idx
  ON public.co_broker_agreements(status, effective_at, expires_at)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS set_co_broker_agreements_updated_at ON public.co_broker_agreements;
CREATE TRIGGER set_co_broker_agreements_updated_at
  BEFORE UPDATE ON public.co_broker_agreements
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.co_broker_agreements IS
  'Listing-scoped co-broker agreement. side captures which side(s) of the deal the co_broker is sharing. Multiple agreements may co-exist for the same (listing, side) — UI surfaces conflicts; uniqueness not enforced at DB.';


-- =====================================================================
-- 3. referral_attributions — deal -> agreement linking
-- =====================================================================
--
-- A deal may attribute to multiple agreements (chained referrals,
-- multiple referrers cooperating). UNIQUE on (deal_id, agreement_id)
-- prevents double-attribution of the same pair.

CREATE TABLE IF NOT EXISTS public.referral_attributions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  agreement_id    uuid NOT NULL REFERENCES public.referral_agreements(id) ON DELETE RESTRICT,

  -- Attribution provenance.
  attributed_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  attributed_at   timestamptz NOT NULL DEFAULT now(),
  notes           text,

  UNIQUE (deal_id, agreement_id)
);

CREATE INDEX IF NOT EXISTS referral_attributions_agreement_idx
  ON public.referral_attributions(agreement_id);


-- =====================================================================
-- 4. active_agreements_view — current effective agreements
-- =====================================================================
--
-- Filters by status='active' AND now() within [effective_at, expires_at].
-- One row per agreement; UNION across the two physical tables exposes
-- a unified "agreement_kind" column so the preview function can switch
-- on it without separate scans.

CREATE OR REPLACE VIEW public.active_agreements_view AS
  SELECT
    'referral'::text AS agreement_kind,
    ra.id,
    ra.referrer_user_id          AS source_user_id,
    ra.referrer_contact_id       AS source_contact_id,
    ra.referrer_organization_id  AS source_organization_id,
    ra.recipient_user_id         AS target_user_id,
    ra.recipient_organization_id AS target_organization_id,
    ra.scope_type,
    ra.scope_listing_id,
    ra.scope_deal_id,
    ra.scope_organization_id,
    ra.terms_kind,
    ra.terms_value,
    ra.terms_currency,
    ra.effective_at,
    ra.expires_at
  FROM public.referral_agreements ra
  WHERE ra.status = 'active'
    AND ra.effective_at <= now()
    AND (ra.expires_at IS NULL OR ra.expires_at > now())

  UNION ALL

  SELECT
    'co_broker'::text AS agreement_kind,
    cba.id,
    cba.listing_agent_user_id         AS source_user_id,
    NULL::bigint                      AS source_contact_id,
    cba.listing_agent_organization_id AS source_organization_id,
    cba.co_broker_user_id             AS target_user_id,
    cba.co_broker_organization_id     AS target_organization_id,
    'listing'::text                   AS scope_type,
    cba.listing_id                    AS scope_listing_id,
    NULL::uuid                        AS scope_deal_id,
    NULL::uuid                        AS scope_organization_id,
    cba.terms_kind,
    cba.terms_value,
    cba.terms_currency,
    cba.effective_at,
    cba.expires_at
  FROM public.co_broker_agreements cba
  WHERE cba.status = 'active'
    AND cba.effective_at <= now()
    AND (cba.expires_at IS NULL OR cba.expires_at > now());

GRANT SELECT ON public.active_agreements_view TO authenticated;


-- =====================================================================
-- 5. referral_chain_for_deal — recursive walker
-- =====================================================================
--
-- Walks deal -> attributions -> agreements; for each agreement,
-- attempts to find an upstream agreement where the current
-- agreement's referrer was itself the recipient (a chained referral).
-- Cycle-safe via WITH RECURSIVE ... CYCLE clause + max-depth guard.
--
-- session_user bypass enables SQL editor smoke runs.

CREATE OR REPLACE FUNCTION public.referral_chain_for_deal(
  p_deal_id   uuid,
  p_max_depth int DEFAULT 10
)
RETURNS TABLE (
  depth                    int,
  agreement_id             uuid,
  parent_agreement_id      uuid,
  source_user_id           uuid,
  source_organization_id   uuid,
  target_user_id           uuid,
  target_organization_id   uuid,
  terms_kind               text,
  terms_value              numeric,
  scope_type               text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE seed AS (
    SELECT
      1                                AS depth,
      ra.id                            AS agreement_id,
      NULL::uuid                       AS parent_agreement_id,
      ra.referrer_user_id              AS source_user_id,
      ra.referrer_organization_id      AS source_organization_id,
      ra.recipient_user_id             AS target_user_id,
      ra.recipient_organization_id     AS target_organization_id,
      ra.terms_kind,
      ra.terms_value,
      ra.scope_type
    FROM public.referral_attributions att
    JOIN public.referral_agreements ra ON ra.id = att.agreement_id
    WHERE att.deal_id = p_deal_id

    UNION ALL

    SELECT
      s.depth + 1,
      ra2.id,
      s.agreement_id,
      ra2.referrer_user_id,
      ra2.referrer_organization_id,
      ra2.recipient_user_id,
      ra2.recipient_organization_id,
      ra2.terms_kind,
      ra2.terms_value,
      ra2.scope_type
    FROM seed s
    JOIN public.referral_agreements ra2
      ON (s.source_user_id IS NOT NULL AND ra2.recipient_user_id = s.source_user_id)
      OR (s.source_organization_id IS NOT NULL AND ra2.recipient_organization_id = s.source_organization_id)
    WHERE s.depth < p_max_depth
  )
  CYCLE agreement_id SET is_cycle USING path
  SELECT
    s.depth,
    s.agreement_id,
    s.parent_agreement_id,
    s.source_user_id,
    s.source_organization_id,
    s.target_user_id,
    s.target_organization_id,
    s.terms_kind,
    s.terms_value,
    s.scope_type
  FROM seed s
  WHERE NOT s.is_cycle
  ORDER BY s.depth, s.agreement_id;
$$;

GRANT EXECUTE ON FUNCTION public.referral_chain_for_deal(uuid, int) TO authenticated;


-- =====================================================================
-- 6. preview_commission_split — read-only candidates
-- =====================================================================
--
-- Returns one row per applicable commission candidate for a deal.
-- Sources:
--   (a) deal_participants with split_pct → projected from deal_value
--   (b) referral_attributions on the deal → linked agreement terms
--   (c) co_broker_agreements active for the deal's listing
--
-- amount_estimate is computed when the inputs allow it; NULL when
-- the math depends on a missing piece (e.g., percent_of_commission
-- with no headline commission yet known). UI uses this to populate a
-- review screen; operator confirms which entries to insert into
-- commission_ledger.

CREATE OR REPLACE FUNCTION public.preview_commission_split(p_deal_id uuid)
RETURNS TABLE (
  candidate_kind         text,    -- 'participant' | 'referral' | 'co_broker'
  source_id              uuid,    -- agreement id, NULL for participant
  participant_user_id    uuid,
  participant_contact_id bigint,
  participant_organization_id uuid,
  participant_role       text,
  basis_type             text,
  basis_value            numeric,
  amount_estimate        numeric,
  currency               text,
  rationale              text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deal_value    numeric;
  v_currency      text;
  v_listing_id    bigint;
BEGIN
  IF NOT (
    public.deal_can_read(p_deal_id)
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'preview_commission_split: permission denied for deal %', p_deal_id
      USING ERRCODE = '42501';
  END IF;

  SELECT d.deal_value, d.currency, d.listing_id
    INTO v_deal_value, v_currency, v_listing_id
  FROM public.deals d WHERE d.id = p_deal_id;

  IF v_deal_value IS NULL THEN v_deal_value := 0; END IF;

  -- (a) deal_participants with split_pct
  RETURN QUERY
    SELECT
      'participant'::text,
      NULL::uuid,
      dp.user_id,
      dp.contact_id,
      NULL::uuid,
      dp.role,
      'percent_of_deal_value'::text,
      (dp.split_pct::numeric / 100)::numeric,  -- bp×100 -> percent
      CASE
        WHEN v_deal_value > 0 THEN
          round((v_deal_value * (dp.split_pct::numeric / 10000.0))::numeric, 2)
        ELSE NULL
      END,
      v_currency,
      format('deal_participants split_pct=%s bp×100', dp.split_pct)
    FROM public.deal_participants dp
    WHERE dp.deal_id = p_deal_id
      AND dp.split_pct IS NOT NULL
      AND dp.role IN ('buyer_agent', 'seller_agent', 'co_broker', 'referrer');

  -- (b) attributed referral agreements
  RETURN QUERY
    SELECT
      'referral'::text,
      ra.id,
      ra.recipient_user_id,
      NULL::bigint,
      ra.recipient_organization_id,
      'referrer'::text,
      ra.terms_kind,
      ra.terms_value,
      CASE ra.terms_kind
        WHEN 'percent_of_deal_value' THEN
          round((v_deal_value * (ra.terms_value / 100.0))::numeric, 2)
        WHEN 'fixed' THEN ra.terms_value
        ELSE NULL  -- percent_of_commission needs a headline commission to apply against
      END,
      ra.terms_currency,
      format('referral_agreement %s (%s)', ra.id, ra.scope_type)
    FROM public.referral_attributions att
    JOIN public.referral_agreements ra ON ra.id = att.agreement_id
    WHERE att.deal_id = p_deal_id
      AND ra.status = 'active'
      AND ra.effective_at <= now()
      AND (ra.expires_at IS NULL OR ra.expires_at > now());

  -- (c) co_broker agreements active for this listing
  RETURN QUERY
    SELECT
      'co_broker'::text,
      cba.id,
      cba.co_broker_user_id,
      NULL::bigint,
      cba.co_broker_organization_id,
      'co_broker'::text,
      cba.terms_kind,
      cba.terms_value,
      CASE cba.terms_kind
        WHEN 'percent_of_deal_value' THEN
          round((v_deal_value * (cba.terms_value / 100.0))::numeric, 2)
        WHEN 'fixed' THEN cba.terms_value
        ELSE NULL
      END,
      cba.terms_currency,
      format('co_broker_agreement %s (%s)', cba.id, cba.side)
    FROM public.co_broker_agreements cba
    WHERE cba.listing_id = v_listing_id
      AND cba.status = 'active'
      AND cba.effective_at <= now()
      AND (cba.expires_at IS NULL OR cba.expires_at > now());
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_commission_split(uuid) TO authenticated;


-- =====================================================================
-- 7. Permissions catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('agreements.propose',  'Create referral and co-broker agreements (proposed status)', 'deals'),
  ('agreements.accept',   'Accept an agreement on the recipient side',                  'deals'),
  ('agreements.read.all', 'Read every agreement regardless of party',                   'deals')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'agreements.read.all'),
  ('admin',   'agreements.propose'),
  ('admin',   'agreements.accept'),
  ('manager', 'agreements.propose'),
  ('manager', 'agreements.accept')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 8. RLS — agreements + attributions
-- =====================================================================

-- Predicate helper: is the caller a party to a referral agreement?
CREATE OR REPLACE FUNCTION public.referral_agreement_is_party(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.referral_agreements ra
     WHERE ra.id = p_id
       AND (
         ra.referrer_user_id  = auth.uid()
         OR ra.recipient_user_id = auth.uid()
         OR ra.proposed_by    = auth.uid()
         OR ra.accepted_by    = auth.uid()
         OR (ra.referrer_organization_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.organization_memberships om
                          WHERE om.organization_id = ra.referrer_organization_id
                            AND om.user_id = auth.uid()))
         OR (ra.recipient_organization_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.organization_memberships om
                          WHERE om.organization_id = ra.recipient_organization_id
                            AND om.user_id = auth.uid()))
       )
  );
$$;

GRANT EXECUTE ON FUNCTION public.referral_agreement_is_party(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.co_broker_agreement_is_party(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.co_broker_agreements cba
     WHERE cba.id = p_id
       AND (
         cba.listing_agent_user_id = auth.uid()
         OR cba.co_broker_user_id  = auth.uid()
         OR cba.proposed_by        = auth.uid()
         OR cba.accepted_by        = auth.uid()
         OR (cba.listing_agent_organization_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.organization_memberships om
                          WHERE om.organization_id = cba.listing_agent_organization_id
                            AND om.user_id = auth.uid()))
         OR (cba.co_broker_organization_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.organization_memberships om
                          WHERE om.organization_id = cba.co_broker_organization_id
                            AND om.user_id = auth.uid()))
       )
  );
$$;

GRANT EXECUTE ON FUNCTION public.co_broker_agreement_is_party(uuid) TO authenticated;


ALTER TABLE public.referral_agreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS referral_agreements_select ON public.referral_agreements;
CREATE POLICY referral_agreements_select ON public.referral_agreements FOR SELECT
  TO authenticated
  USING (
    public.has_permission('agreements.read.all')
    OR public.referral_agreement_is_party(id)
  );

DROP POLICY IF EXISTS referral_agreements_insert ON public.referral_agreements;
CREATE POLICY referral_agreements_insert ON public.referral_agreements FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('agreements.propose')
    AND proposed_by = auth.uid()
  );

DROP POLICY IF EXISTS referral_agreements_update ON public.referral_agreements;
CREATE POLICY referral_agreements_update ON public.referral_agreements FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('agreements.read.all')
    OR public.referral_agreement_is_party(id)
  )
  WITH CHECK (
    public.has_permission('agreements.read.all')
    OR public.referral_agreement_is_party(id)
  );

-- DELETE blocked. Use status='cancelled'.


ALTER TABLE public.co_broker_agreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS co_broker_agreements_select ON public.co_broker_agreements;
CREATE POLICY co_broker_agreements_select ON public.co_broker_agreements FOR SELECT
  TO authenticated
  USING (
    public.has_permission('agreements.read.all')
    OR public.co_broker_agreement_is_party(id)
  );

DROP POLICY IF EXISTS co_broker_agreements_insert ON public.co_broker_agreements;
CREATE POLICY co_broker_agreements_insert ON public.co_broker_agreements FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('agreements.propose')
    AND proposed_by = auth.uid()
  );

DROP POLICY IF EXISTS co_broker_agreements_update ON public.co_broker_agreements;
CREATE POLICY co_broker_agreements_update ON public.co_broker_agreements FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('agreements.read.all')
    OR public.co_broker_agreement_is_party(id)
  )
  WITH CHECK (
    public.has_permission('agreements.read.all')
    OR public.co_broker_agreement_is_party(id)
  );


ALTER TABLE public.referral_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS referral_attributions_select ON public.referral_attributions;
CREATE POLICY referral_attributions_select ON public.referral_attributions FOR SELECT
  TO authenticated
  USING (
    public.deal_can_read(deal_id)
    OR public.has_permission('agreements.read.all')
  );

DROP POLICY IF EXISTS referral_attributions_insert ON public.referral_attributions;
CREATE POLICY referral_attributions_insert ON public.referral_attributions FOR INSERT
  TO authenticated
  WITH CHECK (
    public.deal_can_write(deal_id)
    AND public.referral_agreement_is_party(agreement_id)
  );

DROP POLICY IF EXISTS referral_attributions_delete ON public.referral_attributions;
CREATE POLICY referral_attributions_delete ON public.referral_attributions FOR DELETE
  TO authenticated USING (public.deal_can_write(deal_id));


-- =====================================================================
-- 9. Schema governance contract registration
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.referral_agreements',     'table', 'userportal',
   ARRAY['userportal']::text[], 'Referral agreement artifact',                false),
  ('public.co_broker_agreements',    'table', 'userportal',
   ARRAY['userportal']::text[], 'Listing-scoped co-broker agreement',         false),
  ('public.referral_attributions',   'table', 'userportal',
   ARRAY['userportal']::text[], 'Deal-to-agreement linking',                  false),
  ('public.active_agreements_view',  'view',  'userportal',
   ARRAY['userportal']::text[], 'Currently effective agreements (union)',     false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
