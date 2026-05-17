-- Government documents reference library.
--
-- A read-mostly catalog of government / regulatory PDFs that any
-- broker can browse to understand a process — title transfer, BIR
-- payment of capital gains, tax declarations, registration steps, etc.
-- The structure already existed in app/pages/documents-old.vue (steps
-- + image references); this promotes it to a real entity:
--
--   - Editor uploads the PDF / image via admin UI.
--   - Public anon-readable so the same library can power the public
--     marketing site's "guides" section.
--   - Authenticated brokers see the full library at
--     /documents/government-references.
--
-- Categories (`category` column) let us group docs by step in the
-- broker workflow:
--   - capital_gains   (Step 1: BIR capital gains tax payment)
--   - transfer_tax    (Step 2: provincial / city transfer tax)
--   - registration    (Step 3: register of deeds)
--   - tax_declaration (Step 4: assessor's office)
--   - other           (everything else)
--
-- DEPENDS ON:
--   public.profiles, public.has_permission

CREATE TABLE IF NOT EXISTS public.government_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title           text NOT NULL,
  description     text,
  category        text NOT NULL DEFAULT 'other'
                  CHECK (category IN (
                    'capital_gains',
                    'transfer_tax',
                    'registration',
                    'tax_declaration',
                    'other'
                  )),

  -- step_number drives display order WITHIN a category. NULL means
  -- "no specific step"; sorted last after numbered entries.
  step_number     integer,
  display_order   integer NOT NULL DEFAULT 0,

  -- S3 key for the source document (PDF preferred; image OK for
  -- workflow diagrams). Resolved via getSignedDownloadUrl on read.
  s3_key          text,
  file_name       text,
  file_format     text CHECK (file_format IN ('pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx')),

  -- Optional structured "what to bring" list. JSONB so editors can
  -- evolve the shape without a schema migration.
  -- Shape suggestion: [{label: "Photocopy of TCT", required: true}, …]
  checklist_items jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 'published' = visible to brokers + public; 'draft' = admin only.
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'archived')),

  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gov_docs_category
  ON public.government_documents(category);
CREATE INDEX IF NOT EXISTS idx_gov_docs_status
  ON public.government_documents(status);
CREATE INDEX IF NOT EXISTS idx_gov_docs_display_order
  ON public.government_documents(category, display_order, step_number);

DROP TRIGGER IF EXISTS set_gov_docs_updated_at ON public.government_documents;
CREATE TRIGGER set_gov_docs_updated_at
  BEFORE UPDATE ON public.government_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.government_documents IS
  'Editor-curated reference library for government / regulatory documents (title transfer steps, tax forms, etc.). Broker-facing read-only browse + admin-managed CRUD. Public anon read for the marketing site.';

-- =====================================================================
-- Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('gov_docs.read.all',  'Read every published government reference document', 'documents'),
  ('gov_docs.write',     'Create / edit / delete government reference documents', 'documents')
ON CONFLICT (name) DO NOTHING;

-- Read default-on for every role — explicitly meant as a shared
-- institutional reference. Write gated to admin only.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'gov_docs.read.all'),
  ('admin',   'gov_docs.write'),
  ('manager', 'gov_docs.read.all'),
  ('agent',   'gov_docs.read.all')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- RLS
-- =====================================================================
--
-- Read: anon AND authenticated, but only PUBLISHED rows. Drafts +
-- archived are admin-only via the write-bound select policy.
-- Write: gov_docs.write permission only.

ALTER TABLE public.government_documents ENABLE ROW LEVEL SECURITY;

-- Anon + everyone authenticated can read PUBLISHED.
DROP POLICY IF EXISTS gov_docs_select_published_anon ON public.government_documents;
CREATE POLICY gov_docs_select_published_anon
  ON public.government_documents FOR SELECT
  TO anon
  USING (status = 'published');

DROP POLICY IF EXISTS gov_docs_select_published_authed ON public.government_documents;
CREATE POLICY gov_docs_select_published_authed
  ON public.government_documents FOR SELECT
  TO authenticated
  USING (status = 'published');

-- Admins / editors see drafts + archived too. Composes (ORs) with the
-- published policy above.
DROP POLICY IF EXISTS gov_docs_select_admin ON public.government_documents;
CREATE POLICY gov_docs_select_admin
  ON public.government_documents FOR SELECT
  TO authenticated
  USING (public.has_permission('gov_docs.write'));

DROP POLICY IF EXISTS gov_docs_write ON public.government_documents;
CREATE POLICY gov_docs_write
  ON public.government_documents FOR ALL
  TO authenticated
  USING (public.has_permission('gov_docs.write'))
  WITH CHECK (public.has_permission('gov_docs.write'));

GRANT SELECT ON public.government_documents TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
