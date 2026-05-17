-- document_drafts: editable form-data parallel to the existing
-- generator-pipeline `documents` table.
--
-- Why a new table instead of extending `documents`:
--   - `documents.s3_key` and `documents.file_format` are NOT NULL —
--     the existing rows are always materialized DOCX/PDF artifacts.
--     Drafts are JSONB form values (or imported file pointers) and
--     rarely come with an S3 artifact at draft time.
--   - The two systems audit, search, and surface differently
--     (document.uploaded vs draft.created). Keeping them separate
--     avoids a discriminator-soup column on `documents`.
--
-- A row is one of two flavors, switched by which fields are populated:
--
--   FORM DRAFT  →  template_id is set, data carries form values,
--                  storage_* are NULL.
--   IMPORT      →  storage_path + storage_bucket are set, template_id is
--                  NULL or '__imported__', data may carry a filename.
--
-- A CHECK constraint enforces the XOR.
--
-- DEPENDS ON:
--   public.profiles, public.contacts (Phase 4 contacts.rls migration)
--   public.has_permission(text)         (20260430000003_permissions_rbac.sql)

CREATE TABLE IF NOT EXISTS public.document_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Auto-stamped from the JWT on INSERT (same pattern as contacts.owner_user_id).
  owner_user_id   uuid NOT NULL DEFAULT auth.uid()
                  REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Optional cross-entity link. Lets the contact detail page list a
  -- contact's drafts and lets the unified timeline pivot on contact_id.
  contact_id      bigint
                  REFERENCES public.contacts(id) ON DELETE SET NULL,

  -- Form-draft fields.
  template_id     text,                                  -- e.g. 'lease_agreement'
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,    -- { tenant_name, rent, start_date, … }

  -- Import fields. storage_path is the key inside the bucket; bucket
  -- defaults to 's3://<existing-listings-bucket>/document-drafts/...'
  -- so we reuse the project's existing S3 wiring rather than spinning
  -- up a separate Supabase Storage bucket.
  storage_path    text,
  storage_bucket  text,
  storage_mime    text,
  storage_size_bytes bigint,

  -- Display name in UI lists. Free text; defaults derived from
  -- template name or filename at insert time by the API layer.
  title           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- A row is either a form draft (template_id set) or an import
  -- (storage_path set). NULL on both is allowed for the brief
  -- "untyped scratch" case and would just render as an empty draft.
  CONSTRAINT document_drafts_one_flavor
    CHECK (
      (template_id IS NOT NULL AND storage_path IS NULL)
      OR (template_id IS NULL AND storage_path IS NOT NULL)
      OR (template_id IS NULL AND storage_path IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_document_drafts_owner
  ON public.document_drafts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_document_drafts_contact
  ON public.document_drafts(contact_id);
CREATE INDEX IF NOT EXISTS idx_document_drafts_template
  ON public.document_drafts(template_id);
CREATE INDEX IF NOT EXISTS idx_document_drafts_created_at
  ON public.document_drafts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_drafts_data
  ON public.document_drafts USING gin (data);

-- Auto-bump updated_at. Reuses the helper Phase-4 already shipped on
-- public.set_current_timestamp_updated_at().
DROP TRIGGER IF EXISTS set_document_drafts_updated_at ON public.document_drafts;
CREATE TRIGGER set_document_drafts_updated_at
  BEFORE UPDATE ON public.document_drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.document_drafts IS
  'Editable form-data drafts and imported file pointers. Parallel to the materialized `documents` table; same UI surface, different lifecycle.';

-- =====================================================================
-- RLS
-- =====================================================================
--
-- Same own / team / all shape as contacts + listings.

ALTER TABLE public.document_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_drafts_select ON public.document_drafts;
CREATE POLICY document_drafts_select
  ON public.document_drafts FOR SELECT
  TO authenticated
  USING (
    public.has_permission('documents.read.all')
    OR (
      public.has_permission('documents.read.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = document_drafts.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  );

DROP POLICY IF EXISTS document_drafts_insert ON public.document_drafts;
CREATE POLICY document_drafts_insert
  ON public.document_drafts FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.has_permission('documents.write.all')
    OR public.has_permission('documents.write.team')
  );

DROP POLICY IF EXISTS document_drafts_update ON public.document_drafts;
CREATE POLICY document_drafts_update
  ON public.document_drafts FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('documents.write.all')
    OR (
      public.has_permission('documents.write.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = document_drafts.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  )
  WITH CHECK (
    public.has_permission('documents.write.all')
    OR (
      public.has_permission('documents.write.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = document_drafts.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  );

DROP POLICY IF EXISTS document_drafts_delete ON public.document_drafts;
CREATE POLICY document_drafts_delete
  ON public.document_drafts FOR DELETE
  TO authenticated
  USING (
    public.has_permission('documents.write.all')
    OR owner_user_id = auth.uid()
  );

-- =====================================================================
-- Permission catalog entries (idempotent insert)
-- =====================================================================
--
-- The Phase-4 permissions.manage table already exists. Add three new
-- permissions for drafts: read.own/team/all and write.own/team/all
-- compose with existing roles via the admin /admin → roles & permissions
-- matrix UI.

INSERT INTO public.permissions (name, description, category) VALUES
  ('documents.read.own',   'Read your own document drafts',           'documents'),
  ('documents.read.team',  'Read team members'' document drafts',     'documents'),
  ('documents.read.all',   'Read every document draft',               'documents'),
  ('documents.write.own',  'Create / edit your own document drafts',  'documents'),
  ('documents.write.team', 'Create / edit team members'' drafts',     'documents'),
  ('documents.write.all',  'Create / edit every draft',               'documents')
ON CONFLICT (name) DO NOTHING;

-- Default role bindings — same shape as listings/contacts.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'documents.read.all'),
  ('admin',   'documents.write.all'),
  ('manager', 'documents.read.own'),
  ('manager', 'documents.read.team'),
  ('manager', 'documents.write.own'),
  ('manager', 'documents.write.team'),
  ('agent',   'documents.read.own'),
  ('agent',   'documents.write.own')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
