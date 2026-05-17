-- Broker invitation email-state additions.
--
-- Adds columns to broker_invitations to track whether an admin has
-- shared the invitation (manually copied a link OR sent a future
-- email). Optional — the accept/decline endpoints don't require
-- these. They exist for the admin invitations list UI so operators
-- can tell which invitations have been distributed and which are
-- still untouched.
--
-- ROLLBACK:
--   ALTER TABLE public.broker_invitations
--     DROP COLUMN IF EXISTS link_shared_at,
--     DROP COLUMN IF EXISTS email_sent_at,
--     DROP COLUMN IF EXISTS email_send_error;

ALTER TABLE public.broker_invitations
  ADD COLUMN IF NOT EXISTS link_shared_at   timestamptz,
  ADD COLUMN IF NOT EXISTS email_sent_at    timestamptz,
  ADD COLUMN IF NOT EXISTS email_send_error text;

COMMENT ON COLUMN public.broker_invitations.link_shared_at IS
  'Stamped when an admin copies the invitation link from the UI (out-of-band distribution).';
COMMENT ON COLUMN public.broker_invitations.email_sent_at IS
  'Stamped when the future automated email worker sends the invitation. NULL = never sent automatically.';


NOTIFY pgrst, 'reload schema';
