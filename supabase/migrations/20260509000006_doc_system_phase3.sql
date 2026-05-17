-- Document generation system — Phase 3.
--
-- Adds platform_settings rows for DocuSign + (optional) Puppeteer
-- config. The shape is the same as the AI-generation row from
-- 20260509000003 — single-tenant key/value JSONB.
--
-- DocuSign value shape:
--   {
--     account_id:    string,    // DocuSign API account UUID
--     integration_key: string,  // OAuth integration key (a.k.a. client_id)
--     user_id:       string,    // Impersonated user UUID
--     base_uri:      string,    // demo.docusign.net or na2.docusign.net
--     private_key:   string,    // RSA private key (PEM, line-broken)
--     redirect_uri:  string?,   // optional, for OAuth flows
--     webhook_secret: string?,  // shared secret to validate Connect webhooks
--   }
--
-- Puppeteer config is mostly server-side; this row holds tunable
-- bits the admin might want to flip without redeploy:
--   {
--     headless:       boolean (default true)
--     timeout_ms:     int (default 30000)
--     extra_args:     string[] (default [])
--     paper_format:   "Letter" | "A4" | "Legal" (default "Letter")
--     margin_mm:      int (default 12)
--   }
--
-- Both rows start with `{}` so the wizard / endpoint surface a 503
-- "configure first" CTA when admins haven't filled them in yet.

-- WHERE NOT EXISTS instead of ON CONFLICT (key) — see migration
-- 20260509000003_platform_settings.sql for context. Migration 077
-- replaced the PK on `key` with a composite UNIQUE INDEX, and ON
-- CONFLICT (key) errors on that schema with 42P10. Two separate
-- INSERTs because we want each row to land independently if either
-- already exists from a partial earlier run.
INSERT INTO public.platform_settings (key, description, value)
SELECT 'docusign',
       'DocuSign e-sign integration: account, key, user, base URI, private key.',
       '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM public.platform_settings WHERE key = 'docusign'
);

INSERT INTO public.platform_settings (key, description, value)
SELECT 'pdf_render',
       'Puppeteer PDF rendering tunables (headless, timeout, paper format).',
       '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM public.platform_settings WHERE key = 'pdf_render'
);

-- Document export artifacts — stores generated DOCX/PDF files
-- alongside the draft. Keeps the export pipeline auditable: every
-- "send to lawyer" / "deliver to buyer" event has a frozen artifact
-- the broker can re-download.
CREATE TABLE IF NOT EXISTS public.document_exports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      uuid NOT NULL REFERENCES public.document_drafts(id) ON DELETE CASCADE,
  -- Format of the artifact: docx, pdf. Future formats land in this
  -- check constraint.
  format        text NOT NULL CHECK (format IN ('docx','pdf')),
  -- S3 path under the document-exports/<user>/<draft>/<id>.<ext>
  -- prefix. The download endpoint signs a fresh URL on demand.
  storage_path  text NOT NULL,
  byte_length   bigint NOT NULL,
  -- Optional pin to the version the export was generated from.
  version_id    uuid REFERENCES public.document_versions(id) ON DELETE SET NULL,
  generated_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_exports_draft_idx
  ON public.document_exports(draft_id, generated_at DESC);

ALTER TABLE public.document_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_exports_read   ON public.document_exports;
DROP POLICY IF EXISTS document_exports_write  ON public.document_exports;

CREATE POLICY document_exports_read ON public.document_exports
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.document_drafts d
    WHERE d.id = document_exports.draft_id
  ));

CREATE POLICY document_exports_write ON public.document_exports
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.document_drafts d
    WHERE d.id = document_exports.draft_id
  ));

GRANT SELECT, INSERT ON public.document_exports TO authenticated;

-- DocuSign envelope tracking — one row per envelope created from a
-- draft. Stores the envelope id (DocuSign-side) plus the latest
-- known status from webhook updates. Signers map back to
-- _signature_placeholders on the draft via placeholder_id.
CREATE TABLE IF NOT EXISTS public.docusign_envelopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid NOT NULL REFERENCES public.document_drafts(id) ON DELETE CASCADE,
  envelope_id     text NOT NULL UNIQUE,        -- DocuSign envelope UUID
  status          text NOT NULL DEFAULT 'sent'
                          CHECK (status IN (
                            'created','sent','delivered','completed',
                            'declined','voided','expired'
                          )),
  -- JSONB array mirroring the recipients sent to DocuSign so the UI
  -- can render "who's signed, who hasn't" without round-tripping.
  -- Each entry: { placeholder_id, name, email, role, status, signed_at }
  recipients      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Pin to the draft version that was sent — prevents "what was
  -- signed" confusion if the broker keeps editing.
  version_id      uuid REFERENCES public.document_versions(id) ON DELETE SET NULL,
  sent_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  voided_at       timestamptz,
  webhook_received_at timestamptz
);

CREATE INDEX IF NOT EXISTS docusign_envelopes_draft_idx
  ON public.docusign_envelopes(draft_id);
CREATE INDEX IF NOT EXISTS docusign_envelopes_status_idx
  ON public.docusign_envelopes(status) WHERE status NOT IN ('completed','voided','expired');

ALTER TABLE public.docusign_envelopes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS docusign_envelopes_read   ON public.docusign_envelopes;
DROP POLICY IF EXISTS docusign_envelopes_write  ON public.docusign_envelopes;
DROP POLICY IF EXISTS docusign_envelopes_update ON public.docusign_envelopes;

CREATE POLICY docusign_envelopes_read ON public.docusign_envelopes
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.document_drafts d
    WHERE d.id = docusign_envelopes.draft_id
  ));

CREATE POLICY docusign_envelopes_write ON public.docusign_envelopes
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.document_drafts d
    WHERE d.id = docusign_envelopes.draft_id
  ));

-- Webhook updates write via the service role (no RLS check on the
-- service-role connection); this UPDATE policy is for in-app
-- voids/cancels initiated by the sender.
CREATE POLICY docusign_envelopes_update ON public.docusign_envelopes
  FOR UPDATE TO authenticated
  USING (sent_by = auth.uid() OR public.has_permission('documents.esign.manage'))
  WITH CHECK (sent_by = auth.uid() OR public.has_permission('documents.esign.manage'));

GRANT SELECT, INSERT, UPDATE ON public.docusign_envelopes TO authenticated;
