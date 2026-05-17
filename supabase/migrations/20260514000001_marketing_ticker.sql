-- Marketing ticker banner — admin-managed live-data ticker that sits
-- below the top nav on the public website.
--
-- One table, admin-curated rows. Each row carries a `kind` that picks
-- which server-side resolver fills in live values (counts, city
-- pulses, etc.). `source_config` jsonb supplies kind-specific params.
-- The label uses {{value}} as the placeholder the resolver substitutes
-- — `"🆕 {{value}} new listings this week"` is a typical pattern.
--
-- Strictly additive. New table, UUID PK per feedback_pk_typing_rule.
-- No reference tables touched.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.marketing_ticker_messages;
--   DELETE FROM public.governance_schema_contracts
--    WHERE contract_name = 'public.marketing_ticker_messages';


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='profiles') THEN
    RAISE EXCEPTION 'Migration 20260514000001 requires public.profiles'
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. marketing_ticker_messages
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.marketing_ticker_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Closed kind set — each maps to a server-side resolver. Adding a
  -- new kind = release a new resolver + amend this CHECK.
  kind            text NOT NULL CHECK (kind IN (
    'static',                  -- label is verbatim; no live value
    'new_listings_recent',     -- count of listings created in window
    'active_agents',           -- distinct agents active in window
    'total_listings_online',   -- is_online=true count
    'city_pulse'               -- median sale price vs 90-day baseline for a city
  )),
  -- Display template. Use {{value}} where the resolved live value
  -- should be substituted. Static rows can omit the placeholder.
  label           text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 240),
  -- kind-specific params: { window_days: 7 } for new_listings_recent,
  -- { city_id: 1 } or { city_slug: 'makati' } for city_pulse, etc.
  source_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Optional click target on the rendered chip.
  link_url        text CHECK (link_url IS NULL OR link_url ~ '^(/|https?://)'),
  -- Inline-style classes — `success | warning | destructive | info | primary | neutral`.
  -- Maps to the website's UiBadge variant tokens.
  tone            text NOT NULL DEFAULT 'neutral'
                       CHECK (tone IN ('success','warning','destructive','info','primary','neutral')),
  -- Sort order — lower wins. Defaults give operators headroom to
  -- insert between existing entries without renumbering.
  priority        int NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  enabled         boolean NOT NULL DEFAULT true,
  -- Lifecycle stamps.
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Free-form ops notes.
  notes           text
);

CREATE INDEX IF NOT EXISTS marketing_ticker_enabled_idx
  ON public.marketing_ticker_messages(priority, created_at DESC)
  WHERE enabled = true;

COMMENT ON TABLE public.marketing_ticker_messages IS
  'Live-data ticker chips shown below the website nav. Each row picks a kind (resolved by /api/public/ticker) and a label template with {{value}} substitution. Admin CRUD via /admin/ticker.';


-- =====================================================================
-- 2. Trigger — keep updated_at fresh
-- =====================================================================

DROP TRIGGER IF EXISTS set_marketing_ticker_updated_at
  ON public.marketing_ticker_messages;
CREATE TRIGGER set_marketing_ticker_updated_at
  BEFORE UPDATE ON public.marketing_ticker_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 3. RLS
-- =====================================================================
-- Anon SELECT of enabled rows is the website's read path; admin
-- write is gated. Service role bypasses.

ALTER TABLE public.marketing_ticker_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_ticker_anon_read
  ON public.marketing_ticker_messages;
CREATE POLICY marketing_ticker_anon_read
  ON public.marketing_ticker_messages FOR SELECT
  TO anon, authenticated
  USING (enabled = true);

DROP POLICY IF EXISTS marketing_ticker_admin_all
  ON public.marketing_ticker_messages;
CREATE POLICY marketing_ticker_admin_all
  ON public.marketing_ticker_messages FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 4. Seed — three starter messages so the ticker has something to
--    show out of the box. Operators can disable/replace them.
-- =====================================================================

INSERT INTO public.marketing_ticker_messages
  (kind, label, tone, source_config, priority, enabled, notes)
VALUES
  ('new_listings_recent',
   '🆕 {{value}} new listings this week',
   'success',
   '{"window_days": 7}'::jsonb,
   10, true,
   'Starter row — counts listings.created_at in last 7 days.'),
  ('active_agents',
   '👥 {{value}} active brokers + agents',
   'info',
   '{"window_days": 30}'::jsonb,
   20, true,
   'Starter row — distinct created_by on listings touched in last 30 days.'),
  ('total_listings_online',
   '🏘️ {{value}} live listings on the platform',
   'primary',
   '{}'::jsonb,
   30, true,
   'Starter row — current online inventory.')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5. Governance
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RETURN;
  END IF;
  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('public.marketing_ticker_messages', 'table', 'userportal', ARRAY['userportal','website'],
     'Admin-managed ticker entries for the website hero. Public read of enabled rows.', true)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste in SQL editor.
-- =====================================================================
--
-- 1) Three seed rows landed.
-- SELECT kind, label, tone, enabled FROM public.marketing_ticker_messages ORDER BY priority;
--
-- 2) Anon can read enabled rows (run as anon — adjust JWT in client).
-- SELECT count(*) FROM public.marketing_ticker_messages WHERE enabled = true;
--
-- 3) Toggle one off + verify anon no longer sees it.
-- UPDATE public.marketing_ticker_messages
--    SET enabled = false WHERE kind = 'total_listings_online';
