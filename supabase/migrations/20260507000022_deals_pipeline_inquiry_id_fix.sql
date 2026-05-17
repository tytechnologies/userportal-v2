-- Fix for 20260507000021 — inquiries.id type mismatch.
--
-- The original migration declared deals.inquiry_id as uuid with an
-- FK to public.inquiries(id). On databases where inquiries.id is
-- integer (legacy pre-uuid schema), the FK creation fails:
--
--   ERROR: 42804: foreign key constraint "deals_inquiry_id_fkey"
--   cannot be implemented
--   DETAIL: Key columns "inquiry_id" and "id" are of incompatible
--   types: uuid and integer.
--
-- This migration:
--   1. Detects inquiries.id type at apply time
--   2. Drops anything 20260507000021 may have created (partial state
--      from a half-applied migration)
--   3. Re-creates everything with deals.inquiry_id matching the
--      actual inquiries.id type (uuid OR bigint)
--
-- Idempotent — safe to apply on a fresh DB (deals* tables don't
-- exist; DROP IF EXISTS is a no-op) and on a half-applied DB
-- (DROP CASCADE clears partial state, then re-creates).
--
-- After this migration, the rest of the session's deal endpoints
-- work IF they're rebuilt to match the actual inquiries.id type.
-- The endpoints `/api/inquiries/:id/forward`,
-- `/api/inquiries/:id/convert-to-deal`, and bulk-assign currently
-- validate `z.string().uuid()` on inquiry ids — they need adjustment
-- to accept integer/numeric ids on this database.

DO $$
DECLARE
  v_inquiry_id_type text;
BEGIN
  SELECT data_type INTO v_inquiry_id_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'inquiries'
     AND column_name  = 'id';

  IF v_inquiry_id_type IS NULL THEN
    RAISE EXCEPTION 'public.inquiries table or id column not found; cannot determine FK type';
  END IF;

  RAISE NOTICE 'public.inquiries.id resolved as type: %', v_inquiry_id_type;

  -- Clean up any partial state from the failed 20260507000021.
  DROP VIEW IF EXISTS public.deal_pipeline_stats;
  DROP VIEW IF EXISTS public.listing_market_status;
  DROP TABLE IF EXISTS public.deal_commissions CASCADE;
  DROP TABLE IF EXISTS public.deal_viewings CASCADE;
  DROP TABLE IF EXISTS public.deal_stage_history CASCADE;
  DROP TABLE IF EXISTS public.deal_participants CASCADE;
  DROP TABLE IF EXISTS public.deals CASCADE;

  -- Build the deals table with the right inquiry_id type.
  -- Using format() + EXECUTE keeps the column type substitution
  -- safe (whitelisted to known good types via the IF/ELSIF gate).
  IF v_inquiry_id_type = 'uuid' THEN
    EXECUTE $sql$
      CREATE TABLE public.deals (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        inquiry_id        uuid REFERENCES public.inquiries(id) ON DELETE SET NULL,
        listing_id        bigint NOT NULL REFERENCES public.listings(id) ON DELETE RESTRICT,
        attribution_source_listing_id bigint REFERENCES public.listings(id) ON DELETE SET NULL,
        buyer_agent_user_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
        buyer_contact_id  bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
        stage_key         text NOT NULL DEFAULT 'inquiry_received',
        stage_entered_at  timestamptz NOT NULL DEFAULT now(),
        deal_value        numeric(14,2),
        currency          text NOT NULL DEFAULT 'PHP',
        title             text,
        notes             text,
        closed_at         timestamptz,
        closed_won        boolean,
        created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
    $sql$;
  ELSIF v_inquiry_id_type IN ('integer', 'bigint', 'smallint') THEN
    -- Use bigint to be future-proof — covers integer + smallint
    -- with no data loss.
    EXECUTE $sql$
      CREATE TABLE public.deals (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        inquiry_id        bigint REFERENCES public.inquiries(id) ON DELETE SET NULL,
        listing_id        bigint NOT NULL REFERENCES public.listings(id) ON DELETE RESTRICT,
        attribution_source_listing_id bigint REFERENCES public.listings(id) ON DELETE SET NULL,
        buyer_agent_user_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
        buyer_contact_id  bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
        stage_key         text NOT NULL DEFAULT 'inquiry_received',
        stage_entered_at  timestamptz NOT NULL DEFAULT now(),
        deal_value        numeric(14,2),
        currency          text NOT NULL DEFAULT 'PHP',
        title             text,
        notes             text,
        closed_at         timestamptz,
        closed_won        boolean,
        created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
    $sql$;
  ELSE
    RAISE EXCEPTION 'public.inquiries.id has unsupported type: %', v_inquiry_id_type;
  END IF;
END $$;

-- The rest of 20260507000021's body is type-independent and applies
-- as a one-shot block.

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


-- deal_participants
CREATE TABLE IF NOT EXISTS public.deal_participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  contact_id      bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  role            text NOT NULL CHECK (role IN
                       ('buyer_agent', 'seller_agent', 'co_broker',
                        'referrer', 'buyer', 'seller')),
  split_pct       integer CHECK (split_pct IS NULL OR (split_pct >= 0 AND split_pct <= 10000)),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, user_id, role)
);
CREATE INDEX IF NOT EXISTS deal_participants_deal_idx ON public.deal_participants(deal_id);
CREATE INDEX IF NOT EXISTS deal_participants_user_idx ON public.deal_participants(user_id) WHERE user_id IS NOT NULL;


-- deal_stage_history + trigger
CREATE TABLE IF NOT EXISTS public.deal_stage_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  from_stage    text,
  to_stage      text NOT NULL,
  entered_at    timestamptz NOT NULL DEFAULT now(),
  changed_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes         text
);
CREATE INDEX IF NOT EXISTS deal_stage_history_deal_idx ON public.deal_stage_history(deal_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS deal_stage_history_stage_idx ON public.deal_stage_history(to_stage, entered_at DESC);

CREATE OR REPLACE FUNCTION public.deals_record_stage_history_fn()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
    VALUES (NEW.id, NULL, NEW.stage_key, NEW.created_by);
  ELSIF TG_OP = 'UPDATE' AND NEW.stage_key IS DISTINCT FROM OLD.stage_key THEN
    INSERT INTO public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
    VALUES (NEW.id, OLD.stage_key, NEW.stage_key, auth.uid());
    NEW.stage_entered_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_record_stage_history ON public.deals;
CREATE TRIGGER deals_record_stage_history
  BEFORE INSERT OR UPDATE OF stage_key ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_record_stage_history_fn();


-- deal_viewings
CREATE TABLE IF NOT EXISTS public.deal_viewings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  scheduled_at      timestamptz NOT NULL,
  duration_minutes  integer NOT NULL DEFAULT 60 CHECK (duration_minutes > 0 AND duration_minutes <= 480),
  attending_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  notes             text,
  buyer_interest    text CHECK (buyer_interest IS NULL OR buyer_interest IN
                       ('high', 'medium', 'low', 'declined')),
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_viewings_deal_idx ON public.deal_viewings(deal_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS deal_viewings_attendee_idx
  ON public.deal_viewings(attending_user_id, scheduled_at DESC)
  WHERE attending_user_id IS NOT NULL AND status = 'scheduled';

DROP TRIGGER IF EXISTS set_deal_viewings_updated_at ON public.deal_viewings;
CREATE TRIGGER set_deal_viewings_updated_at
  BEFORE UPDATE ON public.deal_viewings
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- deal_commissions
CREATE TABLE IF NOT EXISTS public.deal_commissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  participant_id  uuid REFERENCES public.deal_participants(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS deal_commissions_deal_idx ON public.deal_commissions(deal_id);
CREATE INDEX IF NOT EXISTS deal_commissions_user_idx
  ON public.deal_commissions(user_id, status, created_at DESC) WHERE user_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_deal_commissions_updated_at ON public.deal_commissions;
CREATE TRIGGER set_deal_commissions_updated_at
  BEFORE UPDATE ON public.deal_commissions
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- documents.deal_id (additive)
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES public.deals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS documents_deal_idx ON public.documents(deal_id) WHERE deal_id IS NOT NULL;


-- Views
CREATE OR REPLACE VIEW public.listing_market_status AS
SELECT
  l.id AS listing_id,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.deals d
       WHERE d.listing_id = l.id AND d.closed_won = true
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

CREATE OR REPLACE VIEW public.deal_pipeline_stats AS
SELECT
  d.buyer_agent_user_id AS broker_user_id,
  d.stage_key,
  count(*) AS deal_count,
  count(*) FILTER (WHERE d.closed_won = true) AS won_count,
  count(*) FILTER (WHERE d.closed_won = false) AS lost_count,
  avg(EXTRACT(EPOCH FROM (coalesce(d.closed_at, now()) - d.created_at)) / 86400)::numeric(10,2)
    AS avg_days_to_close,
  sum(d.deal_value) FILTER (WHERE d.closed_won = true) AS gmv_won
FROM public.deals d
GROUP BY d.buyer_agent_user_id, d.stage_key;
GRANT SELECT ON public.deal_pipeline_stats TO authenticated;


-- Permissions catalog
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


-- RLS helpers + policies
CREATE OR REPLACE FUNCTION public.deal_can_read(p_deal_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT
    public.has_permission('deals.read.all')
    OR EXISTS (
      SELECT 1 FROM public.deals d
       WHERE d.id = p_deal_id
         AND (d.created_by = auth.uid() OR d.buyer_agent_user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.deal_participants p
       WHERE p.deal_id = p_deal_id AND p.user_id = auth.uid()
    );
$$;
GRANT EXECUTE ON FUNCTION public.deal_can_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.deal_can_write(p_deal_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
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
CREATE POLICY deals_select ON public.deals FOR SELECT TO authenticated USING (public.deal_can_read(id));
DROP POLICY IF EXISTS deals_insert ON public.deals;
CREATE POLICY deals_insert ON public.deals FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() OR public.has_permission('deals.write.team'));
DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals FOR UPDATE TO authenticated
  USING (public.deal_can_write(id)) WITH CHECK (public.deal_can_write(id));
DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_delete ON public.deals FOR DELETE TO authenticated
  USING (public.has_permission('deals.write.team') OR created_by = auth.uid());

ALTER TABLE public.deal_participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_participants_select ON public.deal_participants;
CREATE POLICY deal_participants_select ON public.deal_participants FOR SELECT TO authenticated
  USING (public.deal_can_read(deal_id));
DROP POLICY IF EXISTS deal_participants_insert ON public.deal_participants;
CREATE POLICY deal_participants_insert ON public.deal_participants FOR INSERT TO authenticated
  WITH CHECK (public.deal_can_write(deal_id));
DROP POLICY IF EXISTS deal_participants_delete ON public.deal_participants;
CREATE POLICY deal_participants_delete ON public.deal_participants FOR DELETE TO authenticated
  USING (public.deal_can_write(deal_id));

ALTER TABLE public.deal_stage_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_stage_history_select ON public.deal_stage_history;
CREATE POLICY deal_stage_history_select ON public.deal_stage_history FOR SELECT TO authenticated
  USING (public.deal_can_read(deal_id));

ALTER TABLE public.deal_viewings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_viewings_select ON public.deal_viewings;
CREATE POLICY deal_viewings_select ON public.deal_viewings FOR SELECT TO authenticated
  USING (public.deal_can_read(deal_id));
DROP POLICY IF EXISTS deal_viewings_insert ON public.deal_viewings;
CREATE POLICY deal_viewings_insert ON public.deal_viewings FOR INSERT TO authenticated
  WITH CHECK (public.deal_can_write(deal_id));
DROP POLICY IF EXISTS deal_viewings_update ON public.deal_viewings;
CREATE POLICY deal_viewings_update ON public.deal_viewings FOR UPDATE TO authenticated
  USING (public.deal_can_write(deal_id)) WITH CHECK (public.deal_can_write(deal_id));

ALTER TABLE public.deal_commissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_commissions_select ON public.deal_commissions;
CREATE POLICY deal_commissions_select ON public.deal_commissions FOR SELECT TO authenticated
  USING (public.has_permission('commissions.view.platform') OR user_id = auth.uid());
DROP POLICY IF EXISTS deal_commissions_insert ON public.deal_commissions;
CREATE POLICY deal_commissions_insert ON public.deal_commissions FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('commissions.view.platform') OR public.deal_can_write(deal_id));
DROP POLICY IF EXISTS deal_commissions_update ON public.deal_commissions;
CREATE POLICY deal_commissions_update ON public.deal_commissions FOR UPDATE TO authenticated
  USING (public.has_permission('commissions.view.platform') OR public.deal_can_write(deal_id))
  WITH CHECK (public.has_permission('commissions.view.platform') OR public.deal_can_write(deal_id));

DROP POLICY IF EXISTS documents_select_via_deal ON public.documents;
CREATE POLICY documents_select_via_deal ON public.documents FOR SELECT TO authenticated
  USING (deal_id IS NOT NULL AND public.deal_can_read(deal_id));
DROP POLICY IF EXISTS documents_insert_via_deal ON public.documents;
CREATE POLICY documents_insert_via_deal ON public.documents FOR INSERT TO authenticated
  WITH CHECK (deal_id IS NOT NULL AND public.deal_can_write(deal_id));


NOTIFY pgrst, 'reload schema';
