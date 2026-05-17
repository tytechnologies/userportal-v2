-- CRM trio: tasks, notes, notifications.
--
-- Each table follows the project's established shape:
--   - id uuid PK
--   - owner_user_id uuid DEFAULT auth.uid() (auto-stamped, never sent
--     by clients) referencing profiles
--   - cross-entity FKs (contact_id, listing_id) so the unified
--     timeline can pivot on either entity
--   - timestamps + updated_at trigger
--   - RLS scoped own/team/all via has_permission('<entity>.read|write.*')
--
-- Permissions seed defaults: agents get .own, managers get .team,
-- admins get .all (matching the listings/contacts pattern).
--
-- DEPENDS ON:
--   public.profiles, public.contacts, public.listings,
--   public.has_permission

-- =====================================================================
-- 1. TASKS
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL DEFAULT auth.uid()
                  REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Optional cross-entity links — either, both, or neither.
  contact_id      bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  listing_id      bigint REFERENCES public.listings(id) ON DELETE SET NULL,
  -- Optional assignee (defaults to owner). Used by team workflows.
  assignee_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  title           text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  priority        text NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_at          timestamptz,
  completed_at    timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Defensive heal: if `tasks` already existed in the baseline (e.g. an
-- older job-queue table by the same name), CREATE TABLE IF NOT EXISTS
-- is a no-op and we'd be missing columns. ADD COLUMN IF NOT EXISTS
-- patches the shape to what the rest of this migration expects.
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS owner_user_id    uuid,
  ADD COLUMN IF NOT EXISTS contact_id       bigint,
  ADD COLUMN IF NOT EXISTS listing_id       bigint,
  ADD COLUMN IF NOT EXISTS assignee_user_id uuid,
  ADD COLUMN IF NOT EXISTS title            text,
  ADD COLUMN IF NOT EXISTS description      text,
  ADD COLUMN IF NOT EXISTS status           text,
  ADD COLUMN IF NOT EXISTS priority         text,
  ADD COLUMN IF NOT EXISTS due_at           timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS created_at       timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_tasks_owner    ON public.tasks(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON public.tasks(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contact  ON public.tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_listing  ON public.tasks(listing_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON public.tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at   ON public.tasks(due_at);

DROP TRIGGER IF EXISTS set_tasks_updated_at ON public.tasks;
CREATE TRIGGER set_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.tasks IS
  'CRM tasks. Linked to optional contact + listing for cross-entity timeline pivoting; can be reassigned via assignee_user_id.';

-- =====================================================================
-- 2. NOTES
-- =====================================================================
--
-- Distinct from contacts.notes (a single text column). This is a
-- per-entity notes feed — many notes per contact/listing, with their
-- own author + timestamp.

CREATE TABLE IF NOT EXISTS public.notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL DEFAULT auth.uid()
                  REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_id      bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  listing_id      bigint REFERENCES public.listings(id) ON DELETE SET NULL,

  body            text NOT NULL,
  -- Soft-pin so important notes float to the top of the feed.
  is_pinned       boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Defensive heal in case `notes` predates this migration with a
-- different column shape.
ALTER TABLE public.notes
  ADD COLUMN IF NOT EXISTS owner_user_id uuid,
  ADD COLUMN IF NOT EXISTS contact_id    bigint,
  ADD COLUMN IF NOT EXISTS listing_id    bigint,
  ADD COLUMN IF NOT EXISTS body          text,
  ADD COLUMN IF NOT EXISTS is_pinned     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_notes_owner    ON public.notes(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_notes_contact  ON public.notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_notes_listing  ON public.notes(listing_id);
CREATE INDEX IF NOT EXISTS idx_notes_created  ON public.notes(created_at DESC);

DROP TRIGGER IF EXISTS set_notes_updated_at ON public.notes;
CREATE TRIGGER set_notes_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.notes IS
  'CRM notes feed (one row per note). Coexists with contacts.notes single-column free text — that column stays as the contact''s primary description.';

-- =====================================================================
-- 3. NOTIFICATIONS
-- =====================================================================
--
-- In-app notifications. Distinct from the activities (audit) table —
-- activities are immutable + system-wide; notifications are per-user
-- + read/unread + dismissible.
--
-- recipient_user_id is the only FK that matters for the read scope.
-- Owner is the recipient (not the actor). To "send" a notification,
-- a server endpoint INSERTs with recipient_user_id = <them>.

CREATE TABLE IF NOT EXISTS public.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who should see it.
  recipient_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Who triggered it (optional).
  actor_user_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Dotted entity.verb identifier mirroring activities.action.
  -- e.g. 'listing.shared', 'task.assigned', 'contact.note_added'.
  kind            text NOT NULL,
  title           text NOT NULL,
  body            text,
  -- URL to open when the user clicks; e.g. /listings/123 or
  -- /document-drafts/<uuid>.
  href            text,
  -- Cross-entity pointers for downstream UI grouping.
  contact_id      bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  listing_id      bigint REFERENCES public.listings(id) ON DELETE SET NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  read_at         timestamptz,
  dismissed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Defensive heal in case `notifications` predates this migration with a
-- different column shape.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS recipient_user_id uuid,
  ADD COLUMN IF NOT EXISTS actor_user_id     uuid,
  ADD COLUMN IF NOT EXISTS kind              text,
  ADD COLUMN IF NOT EXISTS title             text,
  ADD COLUMN IF NOT EXISTS body              text,
  ADD COLUMN IF NOT EXISTS href              text,
  ADD COLUMN IF NOT EXISTS contact_id        bigint,
  ADD COLUMN IF NOT EXISTS listing_id        bigint,
  ADD COLUMN IF NOT EXISTS metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS read_at           timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS created_at        timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON public.notifications(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON public.notifications(recipient_user_id)
  WHERE read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_kind
  ON public.notifications(kind);

COMMENT ON TABLE public.notifications IS
  'In-app notifications, scoped to a recipient. Independent of the activities audit log — activities are immutable system events; notifications are per-user, read/unread, dismissible.';

-- =====================================================================
-- 4. Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('tasks.read.own',   'Read your own tasks',                    'tasks'),
  ('tasks.read.team',  'Read team members'' tasks',              'tasks'),
  ('tasks.read.all',   'Read every task',                        'tasks'),
  ('tasks.write.own',  'Create / edit your own tasks',           'tasks'),
  ('tasks.write.team', 'Create / edit team members'' tasks',     'tasks'),
  ('tasks.write.all',  'Create / edit every task',               'tasks'),

  ('notes.read.own',   'Read your own notes',                    'notes'),
  ('notes.read.team',  'Read team members'' notes',              'notes'),
  ('notes.read.all',   'Read every note',                        'notes'),
  ('notes.write.own',  'Create / edit your own notes',           'notes'),
  ('notes.write.team', 'Create / edit team members'' notes',     'notes'),
  ('notes.write.all',  'Create / edit every note',               'notes')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'tasks.read.all'),
  ('admin',   'tasks.write.all'),
  ('admin',   'notes.read.all'),
  ('admin',   'notes.write.all'),

  ('manager', 'tasks.read.own'),
  ('manager', 'tasks.read.team'),
  ('manager', 'tasks.write.own'),
  ('manager', 'tasks.write.team'),
  ('manager', 'notes.read.own'),
  ('manager', 'notes.read.team'),
  ('manager', 'notes.write.own'),
  ('manager', 'notes.write.team'),

  ('agent',   'tasks.read.own'),
  ('agent',   'tasks.write.own'),
  ('agent',   'notes.read.own'),
  ('agent',   'notes.write.own')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 5. RLS
-- =====================================================================

ALTER TABLE public.tasks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- ---- TASKS ----
DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select
  ON public.tasks FOR SELECT
  TO authenticated
  USING (
    public.has_permission('tasks.read.all')
    OR (
      public.has_permission('tasks.read.team') AND (
        owner_user_id = auth.uid()
        OR assignee_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = tasks.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
    OR assignee_user_id = auth.uid()
  );

DROP POLICY IF EXISTS tasks_insert ON public.tasks;
CREATE POLICY tasks_insert
  ON public.tasks FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.has_permission('tasks.write.all')
    OR public.has_permission('tasks.write.team')
  );

DROP POLICY IF EXISTS tasks_update ON public.tasks;
CREATE POLICY tasks_update
  ON public.tasks FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('tasks.write.all')
    OR (
      public.has_permission('tasks.write.team') AND (
        owner_user_id = auth.uid()
        OR assignee_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = tasks.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
    OR assignee_user_id = auth.uid()
  )
  WITH CHECK (
    public.has_permission('tasks.write.all')
    OR (
      public.has_permission('tasks.write.team') AND (
        owner_user_id = auth.uid()
        OR assignee_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = tasks.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
    OR assignee_user_id = auth.uid()
  );

DROP POLICY IF EXISTS tasks_delete ON public.tasks;
CREATE POLICY tasks_delete
  ON public.tasks FOR DELETE
  TO authenticated
  USING (
    public.has_permission('tasks.write.all')
    OR owner_user_id = auth.uid()
  );

-- ---- NOTES ----
DROP POLICY IF EXISTS notes_select ON public.notes;
CREATE POLICY notes_select
  ON public.notes FOR SELECT
  TO authenticated
  USING (
    public.has_permission('notes.read.all')
    OR (
      public.has_permission('notes.read.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = notes.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  );

DROP POLICY IF EXISTS notes_insert ON public.notes;
CREATE POLICY notes_insert
  ON public.notes FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.has_permission('notes.write.all')
    OR public.has_permission('notes.write.team')
  );

DROP POLICY IF EXISTS notes_update ON public.notes;
CREATE POLICY notes_update
  ON public.notes FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('notes.write.all')
    OR (
      public.has_permission('notes.write.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = notes.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  )
  WITH CHECK (
    public.has_permission('notes.write.all')
    OR (
      public.has_permission('notes.write.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = notes.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR owner_user_id = auth.uid()
  );

DROP POLICY IF EXISTS notes_delete ON public.notes;
CREATE POLICY notes_delete
  ON public.notes FOR DELETE
  TO authenticated
  USING (
    public.has_permission('notes.write.all')
    OR owner_user_id = auth.uid()
  );

-- ---- NOTIFICATIONS ----
-- Read = recipient sees own + admins see all. Write is server-only;
-- we don't expose INSERT to authenticated (notifications are produced
-- by trusted server code paths — listing.shared, task.assigned, etc.).
-- Update = recipient can mark read/dismissed; admins can do anything.

DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select
  ON public.notifications FOR SELECT
  TO authenticated
  USING (
    recipient_user_id = auth.uid()
    OR public.has_permission('users.manage')
  );

DROP POLICY IF EXISTS notifications_update ON public.notifications;
CREATE POLICY notifications_update
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (
    recipient_user_id = auth.uid()
    OR public.has_permission('users.manage')
  )
  WITH CHECK (
    recipient_user_id = auth.uid()
    OR public.has_permission('users.manage')
  );

DROP POLICY IF EXISTS notifications_delete ON public.notifications;
CREATE POLICY notifications_delete
  ON public.notifications FOR DELETE
  TO authenticated
  USING (
    recipient_user_id = auth.uid()
    OR public.has_permission('users.manage')
  );

-- INSERT policy intentionally absent for `authenticated`. Server code
-- using the request-bound client triggers RLS; if you want to write
-- notifications via the regular API path, add a policy that gates on
-- a 'notifications.send' permission, or write through service-role.

NOTIFY pgrst, 'reload schema';
