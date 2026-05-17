-- Listing inquiries from the public website.
--
-- A visitor on housinginteractive.com.ph clicks "Inquire" on a listing
-- detail page. The website POSTs to /api/public/inquiries (anon-
-- writable via service-role), which:
--   1) snapshots listing.created_by → assigned_user_id (so a future
--      change to the listing's owner doesn't reroute old inquiries)
--   2) writes the row
--   3) fans out a notification (in-app + email) to the assigned agent
--
-- Portal-side reads are RLS-scoped: the assigned agent sees their own
-- (default), managers/admins see team/all per inquiries.read.* perms.
-- INSERT is intentionally not exposed to anon at the table level —
-- the public-facing endpoint uses service-role + Zod validation +
-- (eventually) edge rate limiting as the security boundary.
--
-- DEPENDS ON:
--   public.listings, public.profiles, public.has_permission

CREATE TABLE IF NOT EXISTS public.inquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      bigint NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  -- Snapshotted at insert time. If listing.created_by later changes
  -- (transfer to another agent), this stays pointed at the original
  -- recipient so the audit + reply context survives the reassignment.
  assigned_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Submitter identity. Free-text fields capped at the input layer
  -- (Zod) — server-side guardrails here are length-only.
  sender_name     text NOT NULL CHECK (char_length(sender_name) BETWEEN 1 AND 200),
  sender_email    text CHECK (sender_email IS NULL OR char_length(sender_email) <= 320),
  sender_phone    text CHECK (sender_phone IS NULL OR char_length(sender_phone) <= 40),
  -- Logged-in portal users can also inquire (rare, but possible if
  -- agents preview the public site). NULL for anonymous submissions.
  sender_user_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  message         text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000),
  -- Where the inquiry came from — defaults to 'website'. Future
  -- channels: 'portal', 'imported', 'api'.
  source          text NOT NULL DEFAULT 'website',

  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'in_progress', 'replied', 'closed', 'spam')),
  replied_at      timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Either email or phone must be present so the agent can reply.
  CONSTRAINT inquiries_sender_contact_required
    CHECK (sender_email IS NOT NULL OR sender_phone IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_inquiries_listing_id    ON public.inquiries(listing_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_assigned      ON public.inquiries(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_status        ON public.inquiries(status);
CREATE INDEX IF NOT EXISTS idx_inquiries_created_at    ON public.inquiries(created_at DESC);
-- Compound index for the dashboard widget's per-agent unread count
-- query (assigned_user_id + status='new'). Partial so we don't pay
-- write cost for the eventually-large 'replied'/'closed' majority.
CREATE INDEX IF NOT EXISTS idx_inquiries_assigned_new
  ON public.inquiries(assigned_user_id)
  WHERE status = 'new';

DROP TRIGGER IF EXISTS set_inquiries_updated_at ON public.inquiries;
CREATE TRIGGER set_inquiries_updated_at
  BEFORE UPDATE ON public.inquiries
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.inquiries IS
  'Listing inquiries — public website visitors submit via /api/public/inquiries; assigned to listing.created_by at insert time. Status state machine: new → in_progress → replied → closed. spam is a terminal sink for moderation.';
COMMENT ON COLUMN public.inquiries.assigned_user_id IS
  'Snapshotted from listings.created_by at insert time. Survives later transfers of the parent listing.';

-- =====================================================================
-- Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('inquiries.read.assigned',  'Read inquiries on listings you''re assigned to',  'inquiries'),
  ('inquiries.read.team',      'Read inquiries on team members'' listings',       'inquiries'),
  ('inquiries.read.all',       'Read every inquiry',                              'inquiries'),
  ('inquiries.write.assigned', 'Update inquiries on listings you''re assigned to','inquiries'),
  ('inquiries.write.team',     'Update inquiries on team members'' listings',     'inquiries'),
  ('inquiries.write.all',      'Update every inquiry',                            'inquiries')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'inquiries.read.all'),
  ('admin',   'inquiries.write.all'),
  ('manager', 'inquiries.read.assigned'),
  ('manager', 'inquiries.read.team'),
  ('manager', 'inquiries.write.assigned'),
  ('manager', 'inquiries.write.team'),
  ('agent',   'inquiries.read.assigned'),
  ('agent',   'inquiries.write.assigned')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- RLS
-- =====================================================================

ALTER TABLE public.inquiries ENABLE ROW LEVEL SECURITY;

-- READ: assigned agent + team members + admins. We re-use the same
-- own/team/all pattern as tasks/notes/contacts for consistency.
DROP POLICY IF EXISTS inquiries_select ON public.inquiries;
CREATE POLICY inquiries_select
  ON public.inquiries FOR SELECT
  TO authenticated
  USING (
    public.has_permission('inquiries.read.all')
    OR (
      public.has_permission('inquiries.read.team') AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = inquiries.assigned_user_id
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR assigned_user_id = auth.uid()
    OR sender_user_id = auth.uid()
  );

-- UPDATE: same shape as SELECT — anyone who can see can also act
-- (status flips, mark replied). Spam moderation gated to admins
-- via the application-side check on the endpoint.
DROP POLICY IF EXISTS inquiries_update ON public.inquiries;
CREATE POLICY inquiries_update
  ON public.inquiries FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('inquiries.write.all')
    OR (
      public.has_permission('inquiries.write.team') AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = inquiries.assigned_user_id
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR assigned_user_id = auth.uid()
  )
  WITH CHECK (
    public.has_permission('inquiries.write.all')
    OR (
      public.has_permission('inquiries.write.team') AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = inquiries.assigned_user_id
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR assigned_user_id = auth.uid()
  );

-- DELETE: admins only. Inquiries are soft data — preserve audit.
DROP POLICY IF EXISTS inquiries_delete ON public.inquiries;
CREATE POLICY inquiries_delete
  ON public.inquiries FOR DELETE
  TO authenticated
  USING (public.has_permission('inquiries.write.all'));

-- INSERT policy intentionally absent for `authenticated` and `anon`.
-- The public endpoint writes via service-role with explicit field
-- shape + length checks; we don't want to expose a write surface
-- on the table that bypasses the endpoint's validation.

NOTIFY pgrst, 'reload schema';
