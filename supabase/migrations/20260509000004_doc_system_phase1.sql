-- Document generation system — Phase 1 foundation.
--
-- Adds:
--   document_types          — canonical registry of the 18 supported types
--   clause_library          — versioned, approved-only clause snippets
--   transaction_rooms       — top-level "deal room" container
--   transaction_room_*      — junction tables (participants, files, docs)
--   document_drafts.doc_type_key — link drafts to the canonical type
--
-- Deferred to Phase 2:
--   document_versions table (full snapshot history)
--   approval workflows (pending state machine)
--   e-sign signature placeholders (tagged regions)
--
-- Why a `document_types` table when the TS registry already lists them:
-- foreign-key integrity. Drafts and clauses point at type keys; without
-- a constrainable column we'd silently accept typos. Code seeds the
-- table from app/utils/documentTypes.ts on deploy via a side-effect
-- migration in Phase 2; for now we hand-seed the 18.

-- ============================================================
-- 1. document_types
-- ============================================================
CREATE TABLE IF NOT EXISTS public.document_types (
  key                       text PRIMARY KEY,
  name                      text NOT NULL,
  category                  text NOT NULL CHECK (category IN (
    'sale','lease','rental','agency','reservation','commission',
    'management','spa','acknowledgement','disclosure','turnover',
    'movement','hoa','notice','demand','extension'
  )),
  jurisdiction              text NOT NULL DEFAULT 'PH',
  requires_notary           boolean NOT NULL DEFAULT false,
  requires_witnesses        integer NOT NULL DEFAULT 0,
  requires_spouse_consent   boolean NOT NULL DEFAULT false,
  description               text,
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.document_types
  (key, name, category, requires_notary, requires_witnesses, requires_spouse_consent, description)
VALUES
  ('deed_of_absolute_sale',         'Deed of Absolute Sale',         'sale',           true, 2, true,  'Transfers ownership; required for title transfer at the Registry of Deeds.'),
  ('contract_to_sell',              'Contract to Sell',              'sale',           false, 2, false, 'Conditional sale; ownership transfers only on full payment.'),
  ('lease_agreement',               'Lease Agreement',               'lease',          false, 2, false, 'Long-term tenancy contract (≥1 year typical).'),
  ('rental_agreement',              'Rental Agreement',              'rental',         false, 2, false, 'Short-term or month-to-month rental.'),
  ('authority_to_sell',             'Authority to Sell',             'agency',         false, 0, false, 'Owner grants the broker the right to market the property.'),
  ('exclusive_listing_agreement',   'Exclusive Listing Agreement',   'agency',         false, 0, false, 'Broker has exclusive right to list and sell.'),
  ('reservation_agreement',         'Reservation Agreement',         'reservation',    false, 0, false, 'Buyer reserves the unit with a deposit before formal contract.'),
  ('broker_commission_agreement',   'Broker Commission Agreement',   'commission',     false, 0, false, 'Defines the commission structure and split between brokers.'),
  ('property_management_agreement', 'Property Management Agreement', 'management',     false, 0, false, 'Owner authorizes a property manager to operate the property.'),
  ('special_power_of_attorney',     'Special Power of Attorney',     'spa',            true, 2, true,  'Authorizes another person to act on principal''s behalf for specific transactions.'),
  ('acknowledgement_receipt',       'Acknowledgment Receipt',        'acknowledgement',false, 0, false, 'Confirms receipt of payment, items, or documents.'),
  ('disclosure_statement',          'Disclosure Statement',          'disclosure',     false, 0, false, 'Discloses material facts about the property condition/status.'),
  ('turnover_document',             'Turnover Document',             'turnover',       false, 1, false, 'Records property turnover from developer/seller to buyer.'),
  ('move_in_form',                  'Move-in Form',                  'movement',       false, 0, false, 'Inspection + condition record at move-in.'),
  ('move_out_form',                 'Move-out Form',                 'movement',       false, 0, false, 'Inspection + condition record at move-out.'),
  ('hoa_form',                      'HOA Form',                      'hoa',            false, 0, false, 'Generic homeowners-association form (membership, dues, rules).'),
  ('tenant_notice',                 'Tenant Notice',                 'notice',         false, 0, false, 'Statutory notice to tenant (renewal, increase, termination).'),
  ('demand_letter',                 'Demand Letter',                 'demand',         false, 0, false, 'Formal demand for payment, vacate, or compliance.'),
  ('extension_agreement',           'Extension Agreement',           'extension',      false, 0, false, 'Extends the term of an existing lease or contract.')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  requires_notary = EXCLUDED.requires_notary,
  requires_witnesses = EXCLUDED.requires_witnesses,
  requires_spouse_consent = EXCLUDED.requires_spouse_consent,
  description = EXCLUDED.description;

ALTER TABLE public.document_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_types_read ON public.document_types;
CREATE POLICY document_types_read ON public.document_types
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.document_types TO authenticated;

-- ============================================================
-- 2. clause_library — versioned, approved-only snippets
-- ============================================================
CREATE TABLE IF NOT EXISTS public.clause_library (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL,                                      -- stable slug across versions
  version       integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','deprecated')),
  -- Empty array = applies to all doc_types. Otherwise restricts
  -- which document types may insert this clause.
  doc_type_keys text[] NOT NULL DEFAULT '{}',
  jurisdiction  text NOT NULL DEFAULT 'PH',
  title         text NOT NULL,
  body          text NOT NULL,
  description   text,
  -- Optional placeholders the body uses, e.g. ['{tenant_name}', '{rent_amount}'].
  placeholders  text[] NOT NULL DEFAULT '{}',
  approved_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at   timestamptz,
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

CREATE INDEX IF NOT EXISTS clause_library_status_idx ON public.clause_library(status);
CREATE INDEX IF NOT EXISTS clause_library_doc_type_idx ON public.clause_library USING gin(doc_type_keys);

ALTER TABLE public.clause_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clause_library_read     ON public.clause_library;
DROP POLICY IF EXISTS clause_library_admin_w  ON public.clause_library;
DROP POLICY IF EXISTS clause_library_admin_u  ON public.clause_library;
DROP POLICY IF EXISTS clause_library_admin_d  ON public.clause_library;

-- Any authenticated user can read approved clauses; admins can see drafts too.
CREATE POLICY clause_library_read ON public.clause_library
  FOR SELECT TO authenticated
  USING (status = 'approved' OR public.has_permission('clauses.manage'));

CREATE POLICY clause_library_admin_w ON public.clause_library
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('clauses.manage'));
CREATE POLICY clause_library_admin_u ON public.clause_library
  FOR UPDATE TO authenticated
  USING (public.has_permission('clauses.manage'))
  WITH CHECK (public.has_permission('clauses.manage'));
CREATE POLICY clause_library_admin_d ON public.clause_library
  FOR DELETE TO authenticated
  USING (public.has_permission('clauses.manage'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.clause_library TO authenticated;

CREATE OR REPLACE FUNCTION public.clause_library_set_updated()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS clause_library_set_updated ON public.clause_library;
CREATE TRIGGER clause_library_set_updated
  BEFORE UPDATE ON public.clause_library
  FOR EACH ROW EXECUTE FUNCTION public.clause_library_set_updated();

-- ============================================================
-- 3. document_drafts.doc_type_key — link to canonical type
-- ============================================================
ALTER TABLE public.document_drafts
  ADD COLUMN IF NOT EXISTS doc_type_key text REFERENCES public.document_types(key) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS document_drafts_doc_type_idx
  ON public.document_drafts(doc_type_key);

-- ============================================================
-- 4. transaction_rooms — the top-level "deal room"
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transaction_rooms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in_review','closed','archived','cancelled')),
  -- Optional anchors. A room can be linked to any combination.
  listing_id        bigint REFERENCES public.listings(id) ON DELETE SET NULL,
  buyer_contact_id  bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  seller_contact_id bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  deal_id           uuid   REFERENCES public.deals(id)    ON DELETE SET NULL,
  organization_id   uuid   REFERENCES public.organizations(id) ON DELETE SET NULL,
  owner_user_id     uuid   REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Free-form metadata for jurisdiction/region/notes that don't yet
  -- warrant a column.
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transaction_rooms_status_idx       ON public.transaction_rooms(status);
CREATE INDEX IF NOT EXISTS transaction_rooms_listing_idx      ON public.transaction_rooms(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transaction_rooms_buyer_idx        ON public.transaction_rooms(buyer_contact_id) WHERE buyer_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transaction_rooms_deal_idx         ON public.transaction_rooms(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transaction_rooms_owner_idx        ON public.transaction_rooms(owner_user_id);
CREATE INDEX IF NOT EXISTS transaction_rooms_org_idx          ON public.transaction_rooms(organization_id) WHERE organization_id IS NOT NULL;

ALTER TABLE public.transaction_rooms ENABLE ROW LEVEL SECURITY;

-- Note: RLS policies on transaction_rooms are deliberately deferred
-- until after transaction_room_participants is created (the read
-- policy references that junction table for participation lookups).
-- Postgres resolves the table reference at policy-creation time, so
-- forward-declaring it here would error with 42P01.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transaction_rooms TO authenticated;

CREATE OR REPLACE FUNCTION public.transaction_rooms_set_updated()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS transaction_rooms_set_updated ON public.transaction_rooms;
CREATE TRIGGER transaction_rooms_set_updated
  BEFORE UPDATE ON public.transaction_rooms
  FOR EACH ROW EXECUTE FUNCTION public.transaction_rooms_set_updated();

-- ============================================================
-- 5. transaction_room_participants
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transaction_room_participants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      uuid NOT NULL REFERENCES public.transaction_rooms(id) ON DELETE CASCADE,
  -- Either a user (broker, admin staff) or an external contact (party
  -- to the transaction). Exactly one is set.
  user_id      uuid   REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_id   bigint REFERENCES public.contacts(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN (
                  'buyer','seller','buyer_agent','seller_agent','co_broker',
                  'attorney','witness','notary','manager','observer'
               )),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (contact_id IS NULL)),
  UNIQUE (room_id, user_id, contact_id, role)
);

CREATE INDEX IF NOT EXISTS trp_room_idx    ON public.transaction_room_participants(room_id);
CREATE INDEX IF NOT EXISTS trp_user_idx    ON public.transaction_room_participants(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trp_contact_idx ON public.transaction_room_participants(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.transaction_room_participants ENABLE ROW LEVEL SECURITY;

-- Read: anyone who can read the parent room.
DROP POLICY IF EXISTS trp_read   ON public.transaction_room_participants;
DROP POLICY IF EXISTS trp_write  ON public.transaction_room_participants;
DROP POLICY IF EXISTS trp_delete ON public.transaction_room_participants;

CREATE POLICY trp_read ON public.transaction_room_participants
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_participants.room_id
  ));
CREATE POLICY trp_write ON public.transaction_room_participants
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_participants.room_id
      AND (r.owner_user_id = auth.uid() OR public.has_permission('transactions.write'))
  ));
CREATE POLICY trp_delete ON public.transaction_room_participants
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_participants.room_id
      AND (r.owner_user_id = auth.uid() OR public.has_permission('transactions.write'))
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.transaction_room_participants TO authenticated;

-- Deferred RLS policies on transaction_rooms — placed here because
-- the read policy references transaction_room_participants, which
-- has to exist first. (See note above the table creation for context.)
DROP POLICY IF EXISTS transaction_rooms_read   ON public.transaction_rooms;
DROP POLICY IF EXISTS transaction_rooms_write  ON public.transaction_rooms;
DROP POLICY IF EXISTS transaction_rooms_update ON public.transaction_rooms;
DROP POLICY IF EXISTS transaction_rooms_delete ON public.transaction_rooms;

CREATE POLICY transaction_rooms_read ON public.transaction_rooms
  FOR SELECT TO authenticated
  USING (
       owner_user_id = auth.uid()
    OR public.has_permission('transactions.read.all')
    OR EXISTS (
      SELECT 1 FROM public.transaction_room_participants p
      WHERE p.room_id = transaction_rooms.id AND p.user_id = auth.uid()
    )
  );
CREATE POLICY transaction_rooms_write ON public.transaction_rooms
  FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid() OR public.has_permission('transactions.write'));
CREATE POLICY transaction_rooms_update ON public.transaction_rooms
  FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid() OR public.has_permission('transactions.write'));
CREATE POLICY transaction_rooms_delete ON public.transaction_rooms
  FOR DELETE TO authenticated
  USING (owner_user_id = auth.uid() OR public.has_permission('transactions.delete'));

-- ============================================================
-- 6. transaction_room_documents — junction: room ↔ document_drafts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transaction_room_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES public.transaction_rooms(id) ON DELETE CASCADE,
  draft_id    uuid NOT NULL REFERENCES public.document_drafts(id)   ON DELETE CASCADE,
  added_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, draft_id)
);

CREATE INDEX IF NOT EXISTS trd_room_idx  ON public.transaction_room_documents(room_id);
CREATE INDEX IF NOT EXISTS trd_draft_idx ON public.transaction_room_documents(draft_id);

ALTER TABLE public.transaction_room_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trd_read  ON public.transaction_room_documents;
DROP POLICY IF EXISTS trd_write ON public.transaction_room_documents;

CREATE POLICY trd_read ON public.transaction_room_documents
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_documents.room_id
  ));
CREATE POLICY trd_write ON public.transaction_room_documents
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_documents.room_id
      AND (r.owner_user_id = auth.uid() OR public.has_permission('transactions.write'))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_documents.room_id
      AND (r.owner_user_id = auth.uid() OR public.has_permission('transactions.write'))
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.transaction_room_documents TO authenticated;

-- ============================================================
-- 7. transaction_room_files — uploaded supporting files
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transaction_room_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       uuid NOT NULL REFERENCES public.transaction_rooms(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL,
  description   text,
  uploaded_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trf_room_idx ON public.transaction_room_files(room_id);

ALTER TABLE public.transaction_room_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trf_read  ON public.transaction_room_files;
DROP POLICY IF EXISTS trf_write ON public.transaction_room_files;

CREATE POLICY trf_read ON public.transaction_room_files
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_files.room_id
  ));
CREATE POLICY trf_write ON public.transaction_room_files
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_files.room_id
      AND (r.owner_user_id = auth.uid() OR public.has_permission('transactions.write'))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.transaction_rooms r
    WHERE r.id = transaction_room_files.room_id
      AND (r.owner_user_id = auth.uid() OR public.has_permission('transactions.write'))
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.transaction_room_files TO authenticated;

-- ============================================================
-- Permissions registered for has_permission() expansion
-- (the actual permission rows are inserted by the role taxonomy
-- migration; this is documentation for the integrator)
-- transactions.write   — create/update transaction rooms
-- transactions.read.all — read every room (manager+)
-- transactions.delete   — delete transaction rooms (admin only)
-- clauses.manage        — clause library CRUD
-- platform.settings.manage — already added in 20260509000003
-- ============================================================
