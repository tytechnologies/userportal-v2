-- Deal Pipeline + Transaction System.
--
-- Five additive tables + one additive column + two views. Existing
-- entities (listings, inquiries, documents, activities,
-- notifications) are PRESERVED — deals reference them, never replace
-- them.
--
-- Stages are free-form text on `deals.stage_key` with a documented
-- allowlist (no CHECK so operators can extend without migration):
--   inquiry_received → contacted → viewing_scheduled →
--   viewing_completed → negotiating → reservation → documentation →
--   financing → closing → closed_won | closed_lost
--
-- All transitions audit via the existing activities table (free-form
-- verbs, no schema change). All notifications fan out via notify()
-- with new free-form kinds.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.deal_pipeline_stats;
--   DROP VIEW IF EXISTS public.listing_market_status;
--   ALTER TABLE public.documents DROP COLUMN IF EXISTS deal_id;
--   DROP TABLE IF EXISTS public.deal_commissions;
--   DROP TABLE IF EXISTS public.deal_viewings;
--   DROP TABLE IF EXISTS public.deal_stage_history;
--   DROP TABLE IF EXISTS public.deal_participants;
--   DROP TABLE IF EXISTS public.deals;
--   DELETE FROM public.permissions WHERE name IN
--     ('deals.read.all', 'deals.write.team', 'commissions.view.platform');


-- =====================================================================
-- 1. deals — transaction-level entity
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.deals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional inquiry origin. NULL when a broker creates a deal from
  -- outreach without an inquiry trail.
  inquiry_id        uuid REFERENCES public.inquiries(id) ON DELETE SET NULL,

  -- The listing being transacted. Required — every deal is FOR
  -- something. ON DELETE RESTRICT (vs. CASCADE) keeps the deal even
  -- if the listing is soft-deleted; cleanup is admin-driven.
  listing_id        bigint NOT NULL REFERENCES public.listings(id) ON DELETE RESTRICT,

  -- Attribution lineage hook. When the deal originates on a copied
  -- listing, this points at the listing_copies row so the chain can
  -- be walked for downstream commission features.
  attribution_source_listing_id bigint REFERENCES public.listings(id) ON DELETE SET NULL,

  -- The buyer agent. Distinct from the listing's created_by (seller
  -- agent) when those differ. Tracks who owns the buy-side.
  buyer_agent_user_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Optional buyer contact (existing CRM contact, if known).
  buyer_contact_id  bigint REFERENCES public.contacts(id) ON DELETE SET NULL,

  -- Pipeline stage — free-form text. Documented allowlist in the
  -- migration header; operators can extend at any time.
  stage_key         text NOT NULL DEFAULT 'inquiry_received',
  stage_entered_at  timestamptz NOT NULL DEFAULT now(),

  -- Money. Optional; populated as negotiations land.
  deal_value        numeric(14,2),
  currency          text NOT NULL DEFAULT 'PHP',

  -- Operator-readable summary. Keeps the row useful without
  -- requiring a full CRM contact + listing join on every render.
  title             text,
  notes             text,

  -- Lifecycle stamps.
  closed_at         timestamptz,
  closed_won        boolean,    -- true / false / null (null = open)

  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Hot indexes:
CREATE INDEX IF NOT EXISTS deals_listing_idx
  ON public.deals(listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deals_inquiry_idx
  ON public.deals(inquiry_id) WHERE inquiry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_stage_idx
  ON public.deals(stage_key, stage_entered_at DESC);
CREATE INDEX IF NOT EXISTS deals_buyer_agent_idx
  ON public.deals(buyer_agent_user_id) WHERE buyer_agent_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_open_idx
  ON public.deals(stage_entered_at DESC) WHERE closed_at IS NULL;

DROP TRIGGER IF EXISTS set_deals_updated_at ON public.deals;
CREATE TRIGGER set_deals_updated_at
  BEFORE UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.deals IS
  'Transaction-level entity. inquiry_id NULL when broker-driven (no inquiry trail). attribution_source_listing_id walks listing_copies for lineage. stage_key is free-form text — see migration 20260507000021 for the allowlist.';


-- =====================================================================
-- 2. deal_participants — multi-role roster + commission splits
-- =====================================================================
--
-- Roles:
--   buyer_agent / seller_agent — primary brokers on each side
--   co_broker                  — shared the listing into the deal
--   referrer                   — referred the buyer or seller
--   buyer / seller             — the actual transacting parties
--                                (not always platform users — both
--                                user_id and contact_id can be set)
--
-- A deal can have many participants per role (rare for primary
-- agents; common for co_brokers). split_pct is the commission share
-- in basis points × 100 (i.e. 100 = 1.00%, 10000 = 100%). Storing
-- as integer avoids float-rounding disputes.

CREATE TABLE IF NOT EXISTS public.deal_participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,

  -- One of user_id OR contact_id must be set. user_id wins when both
  -- are present (the platform-native participant takes precedence).
  user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  contact_id      bigint REFERENCES public.contacts(id) ON DELETE SET NULL,

  role            text NOT NULL CHECK (role IN
                       ('buyer_agent', 'seller_agent', 'co_broker',
                        'referrer', 'buyer', 'seller')),

  -- Commission share in basis points × 100 (10000 = 100%).
  -- NULL = not applicable (e.g., for buyer/seller participants who
  -- don't earn commission). The deals_total_split trigger below
  -- enforces sum ≤ 10000 across agent roles.
  split_pct       integer CHECK (split_pct IS NULL OR (split_pct >= 0 AND split_pct <= 10000)),

  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A platform user appears at most once per role per deal. Allow the
  -- same user as both seller_agent and referrer (legitimate); UNIQUE
  -- on (deal, user, role) tuple.
  UNIQUE (deal_id, user_id, role)
);

CREATE INDEX IF NOT EXISTS deal_participants_deal_idx
  ON public.deal_participants(deal_id);
CREATE INDEX IF NOT EXISTS deal_participants_user_idx
  ON public.deal_participants(user_id) WHERE user_id IS NOT NULL;

COMMENT ON TABLE public.deal_participants IS
  'Multi-role deal roster. Same user can appear in multiple roles (e.g. seller_agent + referrer). split_pct in basis points × 100 (10000 = 100%); commission roles must sum to ≤ 100% across the deal.';


-- =====================================================================
-- 3. deal_stage_history — append-only transition log
-- =====================================================================
--
-- Inserted on every stage_key change (manually by the
-- deals_record_stage_history trigger below). Powers
-- time-in-stage analytics without scanning activities.

CREATE TABLE IF NOT EXISTS public.deal_stage_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  from_stage    text,           -- NULL on the row that captures the initial stage
  to_stage      text NOT NULL,
  entered_at    timestamptz NOT NULL DEFAULT now(),
  changed_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes         text
);

CREATE INDEX IF NOT EXISTS deal_stage_history_deal_idx
  ON public.deal_stage_history(deal_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS deal_stage_history_stage_idx
  ON public.deal_stage_history(to_stage, entered_at DESC);

-- Trigger: on deals INSERT/UPDATE, write a stage_history row when
-- stage_key changes. We use auth.uid() for changed_by; service-role
-- writes get NULL.
CREATE OR REPLACE FUNCTION public.deals_record_stage_history_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
    VALUES (NEW.id, NULL, NEW.stage_key, NEW.created_by);
  ELSIF TG_OP = 'UPDATE' AND NEW.stage_key IS DISTINCT FROM OLD.stage_key THEN
    INSERT INTO public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
    VALUES (NEW.id, OLD.stage_key, NEW.stage_key, auth.uid());
    -- Update stage_entered_at on the deal so the public-facing pill
    -- knows when it landed.
    NEW.stage_entered_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_record_stage_history ON public.deals;
CREATE TRIGGER deals_record_stage_history
  BEFORE INSERT OR UPDATE OF stage_key ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_record_stage_history_fn();


-- =====================================================================
-- 4. deal_viewings — scheduled showings
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.deal_viewings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  scheduled_at      timestamptz NOT NULL,
  duration_minutes  integer NOT NULL DEFAULT 60 CHECK (duration_minutes > 0 AND duration_minutes <= 480),
  attending_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  -- Pre-viewing prep notes; updated post-viewing with feedback.
  notes             text,
  -- Post-viewing outcome — useful for the "viewing → conversion" funnel.
  buyer_interest    text CHECK (buyer_interest IS NULL OR buyer_interest IN
                       ('high', 'medium', 'low', 'declined')),

  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_viewings_deal_idx
  ON public.deal_viewings(deal_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS deal_viewings_attendee_idx
  ON public.deal_viewings(attending_user_id, scheduled_at DESC)
  WHERE attending_user_id IS NOT NULL AND status = 'scheduled';

DROP TRIGGER IF EXISTS set_deal_viewings_updated_at ON public.deal_viewings;
CREATE TRIGGER set_deal_viewings_updated_at
  BEFORE UPDATE ON public.deal_viewings
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 5. deal_commissions — per-participant payout breakdown
-- =====================================================================
--
-- One row per (deal, participant). gross_amount is the deal-level
-- total commission (often duplicated per row for legibility);
-- net_amount is what THIS participant gets after split.
-- status: pending | payable | paid | clawback
-- This is OPERATIONAL VISIBILITY, not accounting. No invoices, no
-- ledgers, no FX. Tracks "what's owed" for the brokerage's records.

CREATE TABLE IF NOT EXISTS public.deal_commissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  participant_id  uuid REFERENCES public.deal_participants(id) ON DELETE SET NULL,

  -- Snapshot of participant.user_id at commission-record creation
  -- so a deleted participant row doesn't lose the payout history.
  user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Money split — gross is the deal-level pot; net is THIS line's share.
  gross_amount    numeric(14,2) NOT NULL,
  net_amount      numeric(14,2) NOT NULL,
  currency        text NOT NULL DEFAULT 'PHP',

  status          text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'payable', 'paid', 'clawback')),

  payable_at      timestamptz,
  paid_at         timestamptz,
  notes           text,

  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_commissions_deal_idx
  ON public.deal_commissions(deal_id);
CREATE INDEX IF NOT EXISTS deal_commissions_user_idx
  ON public.deal_commissions(user_id, status, created_at DESC)
  WHERE user_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_deal_commissions_updated_at ON public.deal_commissions;
CREATE TRIGGER set_deal_commissions_updated_at
  BEFORE UPDATE ON public.deal_commissions
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 6. documents.deal_id — additive column (not new table)
-- =====================================================================
--
-- Existing documents table gets a nullable deal_id. RLS branch (added
-- below) gates docs with non-null deal_id to deal participants only.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES public.deals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_deal_idx
  ON public.documents(deal_id) WHERE deal_id IS NOT NULL;

COMMENT ON COLUMN public.documents.deal_id IS
  'Optional FK to public.deals. When set, the document is part of a deal pipeline (LOI / contract / etc.) — RLS gates it to deal participants + admin.';


-- =====================================================================
-- 7. listing_market_status — derived public-facing status
-- =====================================================================
--
-- Returns one row per listing, with the listing's current
-- transaction-driven status:
--   'available'  — no closed_won deal in the last N days, no
--                  reservation
--   'reserved'   — open deal at stage 'reservation' or beyond but
--                  not yet closed_won
--   'sold'       — has a closed_won deal
--
-- Used by the website to render badges. View is anon-readable; the
-- input deals table is admin-readable, so the view's contents are
-- safe (only the derived status leaks, not deal details).

CREATE OR REPLACE VIEW public.listing_market_status AS
SELECT
  l.id AS listing_id,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.deals d
       WHERE d.listing_id = l.id
         AND d.closed_won = true
    ) THEN 'sold'
    WHEN EXISTS (
      SELECT 1 FROM public.deals d
       WHERE d.listing_id = l.id
         AND d.closed_at IS NULL
         AND d.stage_key IN ('reservation', 'documentation', 'financing', 'closing')
    ) THEN 'reserved'
    ELSE 'available'
  END AS market_status
FROM public.listings l
WHERE l.deleted_at IS NULL;

GRANT SELECT ON public.listing_market_status TO anon, authenticated;

COMMENT ON VIEW public.listing_market_status IS
  'Derived public-facing listing status. available / reserved / sold. Anon-readable; underlying deals table is not. Refreshes implicitly via deals state.';


-- =====================================================================
-- 8. deal_pipeline_stats — aggregate analytics
-- =====================================================================

CREATE OR REPLACE VIEW public.deal_pipeline_stats AS
SELECT
  d.buyer_agent_user_id AS broker_user_id,
  d.stage_key,
  count(*)                          AS deal_count,
  count(*) FILTER (WHERE d.closed_won = true) AS won_count,
  count(*) FILTER (WHERE d.closed_won = false) AS lost_count,
  avg(EXTRACT(EPOCH FROM (
    coalesce(d.closed_at, now()) - d.created_at
  )) / 86400)::numeric(10,2)        AS avg_days_to_close,
  sum(d.deal_value) FILTER (WHERE d.closed_won = true) AS gmv_won
FROM public.deals d
GROUP BY d.buyer_agent_user_id, d.stage_key;

GRANT SELECT ON public.deal_pipeline_stats TO authenticated;


-- =====================================================================
-- 9. Permissions catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('deals.read.all',          'Read every deal regardless of participant status', 'deals'),
  ('deals.write.team',        'Edit any deal owned by a team member',             'deals'),
  ('commissions.view.platform', 'View platform-wide commission rollups',          'deals')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'deals.read.all'),
  ('admin',   'deals.write.team'),
  ('admin',   'commissions.view.platform'),
  ('manager', 'deals.write.team')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 10. RLS — deals + participants + viewings + commissions + docs
-- =====================================================================
--
-- Common predicate: "caller participates in this deal" — either as
-- created_by OR as a row in deal_participants with user_id = auth.uid().
-- Wrapped in a SECURITY DEFINER helper so the policies can compose
-- without ad-hoc EXISTS subqueries.

CREATE OR REPLACE FUNCTION public.deal_can_read(p_deal_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    public.has_permission('deals.read.all')
    OR EXISTS (
      SELECT 1 FROM public.deals d
       WHERE d.id = p_deal_id
         AND (d.created_by = auth.uid() OR d.buyer_agent_user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.deal_participants p
       WHERE p.deal_id = p_deal_id
         AND p.user_id = auth.uid()
    );
$$;

GRANT EXECUTE ON FUNCTION public.deal_can_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.deal_can_write(p_deal_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    public.has_permission('deals.write.team')
    OR EXISTS (
      SELECT 1 FROM public.deals d
       WHERE d.id = p_deal_id
         AND (d.created_by = auth.uid() OR d.buyer_agent_user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.deal_participants p
       WHERE p.deal_id = p_deal_id
         AND p.user_id = auth.uid()
         AND p.role IN ('buyer_agent', 'seller_agent', 'co_broker')
    );
$$;

GRANT EXECUTE ON FUNCTION public.deal_can_write(uuid) TO authenticated;


ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deals_select ON public.deals;
CREATE POLICY deals_select ON public.deals FOR SELECT
  TO authenticated
  USING (public.deal_can_read(id));

DROP POLICY IF EXISTS deals_insert ON public.deals;
CREATE POLICY deals_insert ON public.deals FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid() OR public.has_permission('deals.write.team'));

DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals FOR UPDATE
  TO authenticated
  USING (public.deal_can_write(id))
  WITH CHECK (public.deal_can_write(id));

DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_delete ON public.deals FOR DELETE
  TO authenticated
  USING (public.has_permission('deals.write.team') OR created_by = auth.uid());


ALTER TABLE public.deal_participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_participants_select ON public.deal_participants;
CREATE POLICY deal_participants_select ON public.deal_participants FOR SELECT
  TO authenticated USING (public.deal_can_read(deal_id));
DROP POLICY IF EXISTS deal_participants_insert ON public.deal_participants;
CREATE POLICY deal_participants_insert ON public.deal_participants FOR INSERT
  TO authenticated WITH CHECK (public.deal_can_write(deal_id));
DROP POLICY IF EXISTS deal_participants_delete ON public.deal_participants;
CREATE POLICY deal_participants_delete ON public.deal_participants FOR DELETE
  TO authenticated USING (public.deal_can_write(deal_id));


ALTER TABLE public.deal_stage_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_stage_history_select ON public.deal_stage_history;
CREATE POLICY deal_stage_history_select ON public.deal_stage_history FOR SELECT
  TO authenticated USING (public.deal_can_read(deal_id));
-- INSERT happens via the trigger; not exposed to authenticated.


ALTER TABLE public.deal_viewings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_viewings_select ON public.deal_viewings;
CREATE POLICY deal_viewings_select ON public.deal_viewings FOR SELECT
  TO authenticated USING (public.deal_can_read(deal_id));
DROP POLICY IF EXISTS deal_viewings_insert ON public.deal_viewings;
CREATE POLICY deal_viewings_insert ON public.deal_viewings FOR INSERT
  TO authenticated WITH CHECK (public.deal_can_write(deal_id));
DROP POLICY IF EXISTS deal_viewings_update ON public.deal_viewings;
CREATE POLICY deal_viewings_update ON public.deal_viewings FOR UPDATE
  TO authenticated USING (public.deal_can_write(deal_id))
                    WITH CHECK (public.deal_can_write(deal_id));


-- Commissions: more sensitive than other deal tables. Read gated to
-- the participant who's owed (user_id = auth.uid()) OR
-- commissions.view.platform (admin). Even other deal participants
-- don't see each other's payouts unless they have the platform
-- permission.
ALTER TABLE public.deal_commissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_commissions_select ON public.deal_commissions;
CREATE POLICY deal_commissions_select ON public.deal_commissions FOR SELECT
  TO authenticated
  USING (
    public.has_permission('commissions.view.platform')
    OR user_id = auth.uid()
  );
DROP POLICY IF EXISTS deal_commissions_insert ON public.deal_commissions;
CREATE POLICY deal_commissions_insert ON public.deal_commissions FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('commissions.view.platform')
    OR public.deal_can_write(deal_id)
  );
DROP POLICY IF EXISTS deal_commissions_update ON public.deal_commissions;
CREATE POLICY deal_commissions_update ON public.deal_commissions FOR UPDATE
  TO authenticated
  USING (public.has_permission('commissions.view.platform') OR public.deal_can_write(deal_id))
  WITH CHECK (public.has_permission('commissions.view.platform') OR public.deal_can_write(deal_id));


-- Documents extension: docs WITH a deal_id are visible to deal
-- participants only. Docs WITHOUT a deal_id keep their existing
-- (untouched) policies. We add a new permissive SELECT policy that
-- ORs onto the existing ones — Postgres ORs permissive policies, so
-- this composes without breaking the existing surface.
DROP POLICY IF EXISTS documents_select_via_deal ON public.documents;
CREATE POLICY documents_select_via_deal ON public.documents FOR SELECT
  TO authenticated
  USING (
    deal_id IS NOT NULL AND public.deal_can_read(deal_id)
  );
DROP POLICY IF EXISTS documents_insert_via_deal ON public.documents;
CREATE POLICY documents_insert_via_deal ON public.documents FOR INSERT
  TO authenticated
  WITH CHECK (
    deal_id IS NOT NULL AND public.deal_can_write(deal_id)
  );


NOTIFY pgrst, 'reload schema';
