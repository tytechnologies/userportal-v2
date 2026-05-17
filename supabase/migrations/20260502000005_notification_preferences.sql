-- User notification preferences (opt-out per notification kind).
--
-- One row per (user, kind) when the user has explicitly toggled — no
-- row for a (user, kind) means "use the default" (which is true /
-- emails enabled). This is intentional opt-out semantics, not opt-in:
-- new kinds default to delivery, users mute what's noisy.
--
-- The notify() server helper checks this table before queuing email
-- delivery; in-app notifications are unaffected (the bell always
-- shows them).
--
-- DEPENDS ON:
--   public.profiles, public.has_permission

CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Dotted entity.verb identifier mirroring notifications.kind.
  -- e.g. 'listing.shared', 'task.assigned', 'contact.note_added'.
  kind           text NOT NULL,
  email_enabled  boolean NOT NULL DEFAULT true,
  -- Reserved for future channels. Currently unused; rolling them in
  -- now means we don't need a schema change later.
  push_enabled   boolean NOT NULL DEFAULT true,
  sms_enabled    boolean NOT NULL DEFAULT false,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, kind)
);

DROP TRIGGER IF EXISTS set_unp_updated_at ON public.user_notification_preferences;
CREATE TRIGGER set_unp_updated_at
  BEFORE UPDATE ON public.user_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

CREATE INDEX IF NOT EXISTS idx_unp_user_id
  ON public.user_notification_preferences(user_id);

COMMENT ON TABLE public.user_notification_preferences IS
  'Per-user opt-out of notification channels by kind. Missing row = defaults (email_enabled=true). New rows are created lazily when a user toggles a setting.';

-- =====================================================================
-- RLS
-- =====================================================================
--
-- Users read + write their OWN preferences only. Admins
-- (users.manage permission) can read any row for support / auditing.

ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unp_select ON public.user_notification_preferences;
CREATE POLICY unp_select
  ON public.user_notification_preferences FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_permission('users.manage')
  );

DROP POLICY IF EXISTS unp_insert ON public.user_notification_preferences;
CREATE POLICY unp_insert
  ON public.user_notification_preferences FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS unp_update ON public.user_notification_preferences;
CREATE POLICY unp_update
  ON public.user_notification_preferences FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS unp_delete ON public.user_notification_preferences;
CREATE POLICY unp_delete
  ON public.user_notification_preferences FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
