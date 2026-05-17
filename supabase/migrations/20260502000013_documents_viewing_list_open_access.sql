-- Open viewing-list reads to every authenticated user.
--
-- The original 20250129000000 documents migration scoped reads to the
-- creator only. That's right for personal contracts (LOI, lease, DOAS),
-- wrong for viewing lists — those are a team-wide historical record:
-- any broker should be able to look up what's been shown to which
-- client by which colleague.
--
-- This migration adds a permission `viewing_lists.read.all` (default-on
-- for every role) and a secondary SELECT policy on `public.documents`
-- that allows ANY caller with that permission to read rows where
-- `document_type = 'viewing_list'`. Postgres ORs permissive policies,
-- so the existing per-user policy still gates non-viewing-list rows
-- (LOIs, contracts, tax reports — those stay private to the creator).
--
-- INSERT / UPDATE / DELETE policies are unchanged: only the creator
-- can mutate their own viewing-list row. Read is what's opening up.
--
-- DEPENDS ON:
--   20250129000000 (documents table + per-user RLS)
--   20260430000003 (has_permission RPC + permissions catalog)

-- =====================================================================
-- 1. Permission catalog entry
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('viewing_lists.read.all', 'Read every viewing list (team-wide historical record)', 'documents')
ON CONFLICT (name) DO NOTHING;

-- Default-on for every role. Viewing lists are explicitly meant to be
-- a shared institutional artifact — admin can revoke later if a team
-- ever wants tighter scoping.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'viewing_lists.read.all'),
  ('manager', 'viewing_lists.read.all'),
  ('agent',   'viewing_lists.read.all')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 2. New SELECT policy for viewing lists
-- =====================================================================
--
-- Composes (ORs) with the existing "Users can view own documents"
-- policy. A row is readable if EITHER the caller is the creator OR
-- the caller has viewing_lists.read.all AND the row is a viewing list.

DROP POLICY IF EXISTS documents_viewing_list_select_open ON public.documents;
CREATE POLICY documents_viewing_list_select_open
  ON public.documents FOR SELECT
  TO authenticated
  USING (
    document_type = 'viewing_list'
    AND public.has_permission('viewing_lists.read.all')
  );

COMMENT ON POLICY documents_viewing_list_select_open ON public.documents IS
  'Viewing lists are a team-wide historical record. Any user with viewing_lists.read.all (default: every role) can read any viewing-list row. Other document types remain creator-scoped via the original "Users can view own documents" policy.';

NOTIFY pgrst, 'reload schema';
