-- Enable Supabase Realtime on public.notifications.
--
-- Background: NotificationBell.vue polls every 60s. The poll burns
-- battery on a quiet account and lags by up to 60s on a busy one.
-- Switching to a Realtime subscription makes inserts visible in the
-- bell within ~100ms, with no client-side polling at all.
--
-- Supabase Realtime works by tailing the `supabase_realtime` logical
-- replication publication. Tables are NOT in that publication by
-- default — they have to be added explicitly. This migration:
--   1. Ensures the publication exists (Supabase projects ship with it,
--      but greenfield self-hosted ones may not).
--   2. Adds public.notifications to the publication so INSERT events
--      flow to subscribed clients.
--
-- Authorization is unchanged: clients subscribe via the JWT-bound
-- Supabase client; PostgREST RLS on public.notifications
-- (recipient_user_id = auth.uid()) decides which rows the client sees.
-- A user can only receive realtime events for rows they're already
-- allowed to SELECT.
--
-- DEPENDS ON: 20260501000009 (notifications table + RLS).

DO $$
BEGIN
  -- Create the publication if it doesn't exist. On Supabase Cloud this
  -- is a no-op; on greenfield envs it gives Realtime something to tail.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- Add the table to the publication. ALTER PUBLICATION ... ADD TABLE is
-- not idempotent (re-adding throws a duplicate error), so guard via
-- pg_publication_tables.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications';
  END IF;
END $$;

COMMENT ON TABLE public.notifications IS
  'In-app notifications, scoped to a recipient. Independent of the activities audit log — activities are immutable system events; notifications are per-user, read/unread, dismissible. Realtime: rows are streamed via the supabase_realtime publication so the NotificationBell updates without polling.';

NOTIFY pgrst, 'reload schema';
