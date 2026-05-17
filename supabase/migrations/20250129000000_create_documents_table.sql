-- Documents table: stores metadata and S3 key for every generated document.
-- Signed URLs are generated on-demand from s3_key when listing/viewing/downloading.

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  s3_key text NOT NULL,
  file_name text NOT NULL,
  file_format text NOT NULL DEFAULT 'pdf' CHECK (file_format IN ('pdf', 'docx')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_documents_created_by ON public.documents(created_by);
CREATE INDEX IF NOT EXISTS idx_documents_document_type ON public.documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON public.documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_metadata_gin ON public.documents USING gin(metadata);

-- RLS: users can only access their own documents
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own documents"
  ON public.documents FOR SELECT
  USING (auth.uid() = created_by);

CREATE POLICY "Users can insert own documents"
  ON public.documents FOR INSERT
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can update own documents"
  ON public.documents FOR UPDATE
  USING (auth.uid() = created_by);

CREATE POLICY "Users can delete own documents"
  ON public.documents FOR DELETE
  USING (auth.uid() = created_by);

COMMENT ON TABLE public.documents IS 'Generated documents (viewing lists, contracts, etc.) stored in S3; s3_key used to generate signed URLs for view/download';
COMMENT ON COLUMN public.documents.document_type IS 'viewing_list | residential_contract_of_lease | commercial_contract_of_lease | letter_of_intent | authority_to_sell | contract_to_sell | deed_of_absolute_sale | property_management_agreement';
COMMENT ON COLUMN public.documents.metadata IS 'Type-specific: client_name, property_id, listing_id, lessee_name, lessor_name, etc.';
