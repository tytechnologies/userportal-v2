-- Broker + Organization Import Pipeline.
--
-- Two-step staged flow for bulk broker onboarding:
--   1. POST /api/admin/brokers/import  → stages rows in
--      broker_import_rows. Admin reviews. No DB change yet.
--   2. POST /api/admin/brokers/import/:id/process →
--      process_broker_import_batch() runs matching:
--        - email matches existing profile + already in target org
--          → outcome 'already_member' (no-op)
--        - email matches existing profile + not in target org
--          → add organization_membership; outcome 'linked_existing'
--        - email matches no profile → create broker_invitations row
--          with unique token; outcome 'invitation_created'
--          (actual email/magic-link send is deferred to next sprint)
--        - org_slug invalid → outcome 'org_not_found'
--        - branch_slug doesn't belong to org → 'branch_not_found'
--
-- All admin-only via RLS. Auditable via existing log_activity flow.
-- NO silent profile creation: profile rows still require auth.users
-- backing, which only happens at invitation acceptance time.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.process_broker_import_batch(uuid);
--   DROP TABLE IF EXISTS public.broker_invitations;
--   DROP TABLE IF EXISTS public.broker_import_rows;
--   DROP TABLE IF EXISTS public.broker_import_batches;


-- =====================================================================
-- 1. broker_import_batches — one row per CSV upload
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.broker_import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Operator-supplied label so the admin UI can show "Q2 Makati team"
  -- instead of just a uuid.
  source_label    text,
  uploaded_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  total_rows      int  NOT NULL DEFAULT 0,
  processed_rows  int  NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  -- Lifecycle: 'staged' (rows uploaded, not yet processed),
  -- 'processed' (process_broker_import_batch ran). 'staged' batches
  -- are reviewable; 'processed' batches are read-only history.
  status          text NOT NULL DEFAULT 'staged'
                       CHECK (status IN ('staged', 'processed'))
);

CREATE INDEX IF NOT EXISTS broker_import_batches_status_idx
  ON public.broker_import_batches(status, created_at DESC);

ALTER TABLE public.broker_import_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS broker_import_batches_admin ON public.broker_import_batches;
CREATE POLICY broker_import_batches_admin ON public.broker_import_batches FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 2. broker_import_rows — one row per CSV record
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.broker_import_rows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL REFERENCES public.broker_import_batches(id) ON DELETE CASCADE,
  -- 1-based row number from the original CSV (helps the admin UI
  -- correlate outcomes back to the source).
  row_number          int NOT NULL,

  -- Staged data — exactly what the CSV said. Validation happens at
  -- process time; staging just records.
  email               text NOT NULL,
  full_name           text,
  mobile_number       text,
  organization_slug   text NOT NULL,
  branch_slug         text,
  org_role            text NOT NULL DEFAULT 'senior_agent'
                           CHECK (org_role IN (
                             'brokerage_owner','branch_manager','team_lead',
                             'senior_agent','junior_agent','assistant'
                           )),

  -- Outcome state machine. 'pending' → terminal state after process.
  outcome             text NOT NULL DEFAULT 'pending'
                           CHECK (outcome IN (
                             'pending',
                             'linked_existing',         -- existing profile, added to org
                             'already_member',          -- existing profile, already in org
                             'invitation_created',      -- new email, broker_invitations row
                             'duplicate_email_in_batch',-- same email twice in this CSV
                             'org_not_found',
                             'branch_not_found',
                             'validation_error',
                             'error'                    -- generic DB / RPC failure
                           )),
  outcome_detail      text,
  resolved_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_invitation_id uuid,    -- FK populated below after table exists
  resolved_membership_id uuid REFERENCES public.organization_memberships(id) ON DELETE SET NULL,
  processed_at        timestamptz,

  UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS broker_import_rows_batch_idx
  ON public.broker_import_rows(batch_id, outcome);
CREATE INDEX IF NOT EXISTS broker_import_rows_email_idx
  ON public.broker_import_rows(lower(email));

ALTER TABLE public.broker_import_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS broker_import_rows_admin ON public.broker_import_rows;
CREATE POLICY broker_import_rows_admin ON public.broker_import_rows FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 3. broker_invitations — token-based pending invitations
-- =====================================================================
--
-- A row here means: "we want this email to become a member of
-- organization X with role Y; the user hasn't signed up yet." When
-- they sign up via the token (next sprint's flow), we promote this
-- to a real profile + organization_memberships row.

CREATE TABLE IF NOT EXISTS public.broker_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Email is the matching key. Lowercased application-side before
  -- insert; the index uses lower() to enforce uniqueness regardless
  -- of how the operator typed it.
  email           text NOT NULL,
  full_name       text,
  mobile_number   text,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id       uuid REFERENCES public.organization_branches(id) ON DELETE SET NULL,
  org_role        text NOT NULL CHECK (org_role IN (
                       'brokerage_owner','branch_manager','team_lead',
                       'senior_agent','junior_agent','assistant'
                     )),
  -- Cryptographically random uuid; the acceptance URL embeds this.
  token           uuid NOT NULL DEFAULT gen_random_uuid(),
  invited_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  accepted_at     timestamptz,
  accepted_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  declined_at     timestamptz,
  -- Lifecycle: 'pending' → 'accepted' / 'declined' / 'expired'.
  -- 'expired' is set by a nightly prune cron, not at request time.
  status          text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One active invitation per (email, org). If a re-import lands the
  -- same email/org pair again while a row already exists, the
  -- importer reuses the existing token rather than minting a new one.
  UNIQUE (email, organization_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS broker_invitations_token_idx
  ON public.broker_invitations(token);
CREATE INDEX IF NOT EXISTS broker_invitations_email_idx
  ON public.broker_invitations(lower(email));
CREATE INDEX IF NOT EXISTS broker_invitations_pending_idx
  ON public.broker_invitations(expires_at) WHERE status = 'pending';

ALTER TABLE public.broker_invitations ENABLE ROW LEVEL SECURITY;

-- Admin: full read/write.
DROP POLICY IF EXISTS broker_invitations_admin ON public.broker_invitations;
CREATE POLICY broker_invitations_admin ON public.broker_invitations FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

-- Backfill the deferred FK from rows → invitations now that the
-- target table exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
     WHERE constraint_name = 'broker_import_rows_resolved_invitation_id_fkey'
  ) THEN
    ALTER TABLE public.broker_import_rows
      ADD CONSTRAINT broker_import_rows_resolved_invitation_id_fkey
      FOREIGN KEY (resolved_invitation_id)
      REFERENCES public.broker_invitations(id) ON DELETE SET NULL;
  END IF;
END $$;


-- =====================================================================
-- 4. process_broker_import_batch — the matcher
-- =====================================================================
--
-- SECURITY DEFINER so it can write across organizations / memberships
-- regardless of the caller's RLS view. Idempotent — re-running on a
-- 'processed' batch is a no-op (every row's outcome is already set).

CREATE OR REPLACE FUNCTION public.process_broker_import_batch(p_batch_id uuid)
RETURNS TABLE (
  total           int,
  linked_existing int,
  already_member  int,
  invitation_created int,
  duplicate_email int,
  validation_error int,
  errors          int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch       record;
  v_row         record;
  v_existing_profile_id uuid;
  v_org_id      uuid;
  v_branch_id   uuid;
  v_existing_membership_id uuid;
  v_invitation_id uuid;
  c_linked      int := 0;
  c_already     int := 0;
  c_invited     int := 0;
  c_dup         int := 0;
  c_valerr      int := 0;
  c_err         int := 0;
  c_total       int := 0;
BEGIN
  -- Auth gate. Cron / admin only.
  IF NOT (session_user IN ('postgres','supabase_admin','service_role')
          OR public.has_permission('admin.access')) THEN
    RAISE EXCEPTION 'permission denied: process_broker_import_batch is admin only'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_batch FROM public.broker_import_batches WHERE id = p_batch_id;
  IF v_batch IS NULL THEN
    RAISE EXCEPTION 'batch not found: %', p_batch_id USING ERRCODE = '42704';
  END IF;
  IF v_batch.status = 'processed' THEN
    -- Idempotent re-run: just return the current counts.
    SELECT
      count(*) FILTER (WHERE outcome = 'linked_existing'),
      count(*) FILTER (WHERE outcome = 'already_member'),
      count(*) FILTER (WHERE outcome = 'invitation_created'),
      count(*) FILTER (WHERE outcome = 'duplicate_email_in_batch'),
      count(*) FILTER (WHERE outcome = 'validation_error'),
      count(*) FILTER (WHERE outcome = 'error'),
      count(*)
    INTO c_linked, c_already, c_invited, c_dup, c_valerr, c_err, c_total
    FROM public.broker_import_rows WHERE batch_id = p_batch_id;

    total := c_total;
    linked_existing := c_linked; already_member := c_already;
    invitation_created := c_invited; duplicate_email := c_dup;
    validation_error := c_valerr; errors := c_err;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Pre-pass: flag duplicate emails within this batch. Same email
  -- twice in one upload → mark all but the first row as
  -- 'duplicate_email_in_batch' and skip in the main loop.
  UPDATE public.broker_import_rows r
     SET outcome = 'duplicate_email_in_batch',
         outcome_detail = 'Email appeared earlier in this batch',
         processed_at = now()
   WHERE r.batch_id = p_batch_id
     AND r.outcome = 'pending'
     AND EXISTS (
       SELECT 1 FROM public.broker_import_rows r2
        WHERE r2.batch_id = r.batch_id
          AND lower(r2.email) = lower(r.email)
          AND r2.row_number < r.row_number
     );

  -- Main pass.
  FOR v_row IN
    SELECT * FROM public.broker_import_rows
     WHERE batch_id = p_batch_id AND outcome = 'pending'
     ORDER BY row_number
  LOOP
    c_total := c_total + 1;

    -- Validate org slug.
    SELECT id INTO v_org_id FROM public.organizations
     WHERE slug = v_row.organization_slug LIMIT 1;
    IF v_org_id IS NULL THEN
      UPDATE public.broker_import_rows
         SET outcome = 'org_not_found',
             outcome_detail = 'No organization with slug ' || v_row.organization_slug,
             processed_at = now()
       WHERE id = v_row.id;
      c_valerr := c_valerr + 1;
      CONTINUE;
    END IF;

    -- Validate branch (optional).
    v_branch_id := NULL;
    IF v_row.branch_slug IS NOT NULL AND length(v_row.branch_slug) > 0 THEN
      SELECT id INTO v_branch_id FROM public.organization_branches
       WHERE organization_id = v_org_id AND slug = v_row.branch_slug LIMIT 1;
      IF v_branch_id IS NULL THEN
        UPDATE public.broker_import_rows
           SET outcome = 'branch_not_found',
               outcome_detail = 'No branch ' || v_row.branch_slug || ' under ' || v_row.organization_slug,
               processed_at = now()
         WHERE id = v_row.id;
        c_valerr := c_valerr + 1;
        CONTINUE;
      END IF;
    END IF;

    -- Email match.
    SELECT id INTO v_existing_profile_id FROM public.profiles
     WHERE lower(email) = lower(v_row.email) LIMIT 1;

    IF v_existing_profile_id IS NOT NULL THEN
      -- Existing profile path. Check current membership.
      SELECT id INTO v_existing_membership_id FROM public.organization_memberships
       WHERE user_id = v_existing_profile_id
         AND organization_id = v_org_id
         AND status IN ('active', 'trial')
       LIMIT 1;

      IF v_existing_membership_id IS NOT NULL THEN
        UPDATE public.broker_import_rows
           SET outcome = 'already_member',
               outcome_detail = 'Profile already an active member',
               resolved_profile_id = v_existing_profile_id,
               resolved_membership_id = v_existing_membership_id,
               processed_at = now()
         WHERE id = v_row.id;
        c_already := c_already + 1;
      ELSE
        BEGIN
          INSERT INTO public.organization_memberships
            (organization_id, user_id, branch_id, org_role, status, joined_at, invited_by)
          VALUES
            (v_org_id, v_existing_profile_id, v_branch_id, v_row.org_role,
             'active', now(), v_batch.uploaded_by)
          RETURNING id INTO v_existing_membership_id;
          UPDATE public.broker_import_rows
             SET outcome = 'linked_existing',
                 outcome_detail = 'Added to organization',
                 resolved_profile_id = v_existing_profile_id,
                 resolved_membership_id = v_existing_membership_id,
                 processed_at = now()
           WHERE id = v_row.id;
          c_linked := c_linked + 1;
        EXCEPTION WHEN OTHERS THEN
          UPDATE public.broker_import_rows
             SET outcome = 'error',
                 outcome_detail = SQLERRM,
                 processed_at = now()
           WHERE id = v_row.id;
          c_err := c_err + 1;
        END;
      END IF;
    ELSE
      -- New email path: create / reuse invitation.
      BEGIN
        INSERT INTO public.broker_invitations
          (email, full_name, mobile_number, organization_id, branch_id, org_role, invited_by)
        VALUES
          (lower(v_row.email), v_row.full_name, v_row.mobile_number,
           v_org_id, v_branch_id, v_row.org_role, v_batch.uploaded_by)
        ON CONFLICT (email, organization_id) DO UPDATE
          SET full_name     = coalesce(EXCLUDED.full_name, broker_invitations.full_name),
              mobile_number = coalesce(EXCLUDED.mobile_number, broker_invitations.mobile_number),
              branch_id     = coalesce(EXCLUDED.branch_id, broker_invitations.branch_id),
              org_role      = EXCLUDED.org_role
          RETURNING id INTO v_invitation_id;
        UPDATE public.broker_import_rows
           SET outcome = 'invitation_created',
               outcome_detail = 'Invitation row created (delivery deferred to next sprint)',
               resolved_invitation_id = v_invitation_id,
               processed_at = now()
         WHERE id = v_row.id;
        c_invited := c_invited + 1;
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.broker_import_rows
           SET outcome = 'error',
               outcome_detail = SQLERRM,
               processed_at = now()
         WHERE id = v_row.id;
        c_err := c_err + 1;
      END;
    END IF;
  END LOOP;

  UPDATE public.broker_import_batches
     SET status = 'processed',
         processed_at = now(),
         processed_rows = c_total
   WHERE id = p_batch_id;

  total := c_total;
  linked_existing := c_linked; already_member := c_already;
  invitation_created := c_invited; duplicate_email := c_dup;
  validation_error := c_valerr; errors := c_err;
  RETURN NEXT;
END;
$$;
GRANT EXECUTE ON FUNCTION public.process_broker_import_batch(uuid) TO authenticated;


-- =====================================================================
-- 5. Nightly prune cron — expire old invitations
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('broker_invitations_expire_daily')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'broker_invitations_expire_daily');
    PERFORM cron.schedule(
      'broker_invitations_expire_daily',
      '20 4 * * *',
      $cmd$
        UPDATE public.broker_invitations
           SET status = 'expired'
         WHERE status = 'pending'
           AND expires_at < now();
      $cmd$
    );
  END IF;
END $$;


-- =====================================================================
-- 6. Governance contracts
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.broker_import_batches',  'table',    'userportal', ARRAY['userportal'],
   'CSV upload metadata. One row per admin-initiated bulk broker import.', false),
  ('public.broker_import_rows',     'table',    'userportal', ARRAY['userportal'],
   'Per-row staging for broker imports. Outcomes: linked_existing, already_member, invitation_created, validation errors, dup-in-batch.', false),
  ('public.broker_invitations',     'table',    'userportal', ARRAY['userportal'],
   'Pending broker invitations with cryptographically random tokens. Admin-only.', false),
  ('public.process_broker_import_batch', 'function', 'userportal', ARRAY['userportal'],
   'Two-step processor: matches CSV rows to existing profiles or creates invitation rows. Never silently creates profiles.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
