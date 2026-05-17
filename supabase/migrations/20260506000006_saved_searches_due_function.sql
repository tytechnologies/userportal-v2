-- Helper function: which saved-search subscriptions are due for a digest?
--
-- Returns confirmed subscriptions whose last digest is older than the
-- cadence implied by digest_frequency, plus those that have never been
-- digested.
--
--   digest_frequency = 'daily'  → due if last_digest_sent_at IS NULL
--                                  OR last_digest_sent_at < now() - 1 day
--   digest_frequency = 'weekly' → due if last_digest_sent_at IS NULL
--                                  OR last_digest_sent_at < now() - 7 days
--
-- Wrapped in a SECURITY DEFINER function so the admin endpoint
-- (and pg_cron in a future round) can call it without granting raw
-- table access. RLS on saved_search_subscriptions stays no-policies;
-- this function is the only sanctioned read path.
--
-- Returns the full row shape the digest worker needs:
--   id, email, name, filters, digest_frequency, last_digest_sent_at,
--   unsubscribe_token
-- (confirmation_token is NOT returned — the worker doesn't need it
--  and we keep tokens scoped to their purpose.)
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.saved_searches_due_for_digest();
--
-- DEPENDS ON:
--   20260506000005_saved_search_subscriptions.sql

CREATE OR REPLACE FUNCTION public.saved_searches_due_for_digest()
RETURNS TABLE (
  id                  uuid,
  email               text,
  name                text,
  filters             jsonb,
  digest_frequency    text,
  last_digest_sent_at timestamptz,
  unsubscribe_token   text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    s.id,
    s.email,
    s.name,
    s.filters,
    s.digest_frequency,
    s.last_digest_sent_at,
    s.unsubscribe_token
  FROM public.saved_search_subscriptions s
  WHERE s.confirmed_at IS NOT NULL
    AND (
      s.last_digest_sent_at IS NULL
      OR (
        s.digest_frequency = 'daily'
        AND s.last_digest_sent_at < now() - interval '1 day'
      )
      OR (
        s.digest_frequency = 'weekly'
        AND s.last_digest_sent_at < now() - interval '7 days'
      )
    )
  ORDER BY s.last_digest_sent_at NULLS FIRST, s.created_at;
$$;

COMMENT ON FUNCTION public.saved_searches_due_for_digest() IS
  'Returns confirmed saved-search subscriptions due for a digest based on their digest_frequency cadence. Used by the admin run-digest endpoint and (in a future round) pg_cron. Read-only — does not stamp last_digest_sent_at.';

REVOKE ALL ON FUNCTION public.saved_searches_due_for_digest() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.saved_searches_due_for_digest()
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
