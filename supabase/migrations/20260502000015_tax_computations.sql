-- Tax computations as record-bearing entities.
--
-- Background: today the Tax Computation forms (TaxComputationForm.vue,
-- TaxComputationCorporateForm.vue) are pure calculators — fill in,
-- generate a PDF via the legacy backend, lose the inputs when the tab
-- closes. There's no audit trail of "this is the tax computation we
-- ran for client X for property Y on date Z."
--
-- This table fixes that. A row captures the form inputs (jsonb) plus a
-- taxpayer-type discriminator, so a saved computation can be re-loaded
-- later and re-rendered. Optional FKs to contact + listing wire the
-- record into the unified CRM timeline + the listing-detail Documents
-- panel.
--
-- Result snapshot: the legacy PDF generator computes server-side; we
-- could persist the rendered output too but that's a heavier ask
-- (PDF blob storage + cleanup). For v1 we capture inputs only — the
-- PDF can be regenerated on demand from the saved inputs.
--
-- DEPENDS ON:
--   public.profiles, public.contacts, public.listings,
--   public.has_permission

CREATE TABLE IF NOT EXISTS public.tax_computations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Auto-stamped from JWT (same pattern as contacts / tasks / notes).
  owner_user_id   uuid NOT NULL DEFAULT auth.uid()
                  REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Optional cross-entity links.
  contact_id      bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  listing_id      bigint REFERENCES public.listings(id) ON DELETE SET NULL,

  -- Discriminators. taxpayer_type drives which form the record was
  -- captured from; computation_kind narrows further within individual
  -- (matches the IndividualFinalGross / IndividualFinalNett /
  -- IndividualFinalNettZV variants). Corporate currently has one
  -- variant, future-proofed via the same column.
  taxpayer_type   text NOT NULL
                  CHECK (taxpayer_type IN ('individual', 'corporate')),
  computation_kind text NOT NULL DEFAULT 'nett'
                  CHECK (computation_kind IN ('gross', 'nett', 'nett_zv')),

  -- Form inputs as recorded. Free-form JSONB so the legacy form can
  -- evolve without a schema migration; downstream re-renderers use
  -- whatever fields are present.
  inputs          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Optional human label for picking from a list ("Smith DOAS, Mar 2026").
  title           text,
  -- Free-form note on why this computation was run / what it's for.
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Defensive heal — if `tax_computations` ever existed in the live DB
-- with a different shape, ADD COLUMN IF NOT EXISTS catches up.
ALTER TABLE public.tax_computations
  ADD COLUMN IF NOT EXISTS owner_user_id    uuid,
  ADD COLUMN IF NOT EXISTS contact_id       bigint,
  ADD COLUMN IF NOT EXISTS listing_id       bigint,
  ADD COLUMN IF NOT EXISTS taxpayer_type    text,
  ADD COLUMN IF NOT EXISTS computation_kind text,
  ADD COLUMN IF NOT EXISTS inputs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS title            text,
  ADD COLUMN IF NOT EXISTS notes            text,
  ADD COLUMN IF NOT EXISTS created_at       timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_tax_computations_owner
  ON public.tax_computations(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tax_computations_contact
  ON public.tax_computations(contact_id);
CREATE INDEX IF NOT EXISTS idx_tax_computations_listing
  ON public.tax_computations(listing_id);
CREATE INDEX IF NOT EXISTS idx_tax_computations_created
  ON public.tax_computations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tax_computations_inputs
  ON public.tax_computations USING gin(inputs);

DROP TRIGGER IF EXISTS set_tax_computations_updated_at ON public.tax_computations;
CREATE TRIGGER set_tax_computations_updated_at
  BEFORE UPDATE ON public.tax_computations
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.tax_computations IS
  'Saved tax-computation records (individual / corporate). Inputs as JSONB so the legacy forms can evolve without a schema migration. Optional links to contact + listing for the unified CRM timeline.';

-- =====================================================================
-- Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('tax_computations.read.own',   'Read your own tax computation records', 'documents'),
  ('tax_computations.read.team',  'Read team members'' tax computation records', 'documents'),
  ('tax_computations.read.all',   'Read every tax computation record', 'documents'),
  ('tax_computations.write.own',  'Create / edit your own tax computation records', 'documents'),
  ('tax_computations.write.team', 'Create / edit team members'' tax computation records', 'documents'),
  ('tax_computations.write.all',  'Create / edit every tax computation record', 'documents')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'tax_computations.read.all'),
  ('admin',   'tax_computations.write.all'),
  ('manager', 'tax_computations.read.own'),
  ('manager', 'tax_computations.read.team'),
  ('manager', 'tax_computations.write.own'),
  ('manager', 'tax_computations.write.team'),
  ('agent',   'tax_computations.read.own'),
  ('agent',   'tax_computations.write.own')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- RLS
-- =====================================================================

ALTER TABLE public.tax_computations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_computations_select ON public.tax_computations;
CREATE POLICY tax_computations_select
  ON public.tax_computations FOR SELECT
  TO authenticated
  USING (
    public.has_permission('tax_computations.read.all')
    OR (
      public.has_permission('tax_computations.read.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = tax_computations.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  );

DROP POLICY IF EXISTS tax_computations_insert ON public.tax_computations;
CREATE POLICY tax_computations_insert
  ON public.tax_computations FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.has_permission('tax_computations.write.all')
    OR public.has_permission('tax_computations.write.team')
  );

DROP POLICY IF EXISTS tax_computations_update ON public.tax_computations;
CREATE POLICY tax_computations_update
  ON public.tax_computations FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('tax_computations.write.all')
    OR (
      public.has_permission('tax_computations.write.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = tax_computations.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  )
  WITH CHECK (
    public.has_permission('tax_computations.write.all')
    OR (
      public.has_permission('tax_computations.write.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = tax_computations.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  );

DROP POLICY IF EXISTS tax_computations_delete ON public.tax_computations;
CREATE POLICY tax_computations_delete
  ON public.tax_computations FOR DELETE
  TO authenticated
  USING (
    public.has_permission('tax_computations.write.all')
    OR owner_user_id = auth.uid()
  );

NOTIFY pgrst, 'reload schema';
