-- DB-backed document templates. The hardcoded registry in
-- app/utils/documentTemplates.ts stays in place for backwards compat;
-- this table lets non-engineers ship new templates via the admin UI
-- without a code deploy.
--
-- Discriminator: a template's `id` (text PK) is the same identifier
-- used by document_drafts.template_id. The hybrid registry the
-- frontend uses checks the static registry first, then the DB.
--
-- DEPENDS ON:
--   public.has_permission(text)  (20260430000003 / 000004)
--   public.profiles              (20260429000001)

CREATE TABLE IF NOT EXISTS public.document_template_definitions (
  -- Stable text id reused by document_drafts.template_id. Uses slug
  -- form (snake_case) so it's safe to embed in URLs and nice to read.
  id              text PRIMARY KEY,

  name            text NOT NULL,
  description     text,

  -- S3 key for the background image. Browser fetches via a signed URL
  -- minted on demand by the designer / editor.
  background_path text,
  -- Original filename / mime, just for display in the admin UI.
  background_name text,
  background_mime text,

  width           integer NOT NULL DEFAULT 816,   -- letter @ 96 DPI
  height          integer NOT NULL DEFAULT 1056,

  -- Array of DocumentTemplateField (see app/utils/documentTemplates.ts).
  -- Storing as JSONB lets the designer mutate freely without schema
  -- migrations every time we add a field property (e.g. validation
  -- rules, conditional logic).
  fields          jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 'draft' = visible to admin only; 'published' = picker shows it.
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'archived')),

  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_defs_status
  ON public.document_template_definitions(status);
CREATE INDEX IF NOT EXISTS idx_template_defs_created_by
  ON public.document_template_definitions(created_by);

DROP TRIGGER IF EXISTS set_template_defs_updated_at
  ON public.document_template_definitions;
CREATE TRIGGER set_template_defs_updated_at
  BEFORE UPDATE ON public.document_template_definitions
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.document_template_definitions IS
  'DB-backed editable document templates. Coexists with the static registry; admin UI mutates these without a code deploy.';

-- =====================================================================
-- Permission catalog entry
-- =====================================================================
INSERT INTO public.permissions (name, description, category) VALUES
  ('templates.manage', 'Create / edit / delete document templates', 'admin')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'templates.manage')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- RLS
-- =====================================================================
ALTER TABLE public.document_template_definitions ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated user can see PUBLISHED templates (they need
-- to pick from them). Drafts + archived only visible to template
-- managers, who also see published.
DROP POLICY IF EXISTS template_defs_select ON public.document_template_definitions;
CREATE POLICY template_defs_select
  ON public.document_template_definitions FOR SELECT
  TO authenticated
  USING (
    status = 'published'
    OR public.has_permission('templates.manage')
  );

-- Write: admin only via has_permission. Don't bootstrap with
-- current_user_role() = 'admin' — templates aren't in the
-- self-lockout protected set; if every admin loses templates.manage,
-- a SECURITY DEFINER restoration is fine.
DROP POLICY IF EXISTS template_defs_write ON public.document_template_definitions;
CREATE POLICY template_defs_write
  ON public.document_template_definitions FOR ALL
  TO authenticated
  USING (public.has_permission('templates.manage'))
  WITH CHECK (public.has_permission('templates.manage'));

NOTIFY pgrst, 'reload schema';
