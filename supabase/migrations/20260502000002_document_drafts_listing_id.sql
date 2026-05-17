-- Add `listing_id` to document_drafts so a draft can be linked to a
-- listing (in addition to the existing contact_id link). This unlocks:
--
--   - The drafts dashboard showing "For: <listing> · <contact>"
--   - Quick-create from a listing page (pre-fills listing_id)
--   - The unified activity timeline pivoting on listing_id
--   - Filtering drafts by listing_id (dashboard widgets)
--
-- DEPENDS ON:
--   20260501000003 (document_drafts table)

ALTER TABLE public.document_drafts
  ADD COLUMN IF NOT EXISTS listing_id bigint REFERENCES public.listings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_document_drafts_listing_id
  ON public.document_drafts(listing_id);

COMMENT ON COLUMN public.document_drafts.listing_id IS
  'Optional link to a listing — drafts are commonly created in the context of a property (offer, lease, listing agreement). Both contact_id and listing_id may be set; either or neither also valid.';

NOTIFY pgrst, 'reload schema';
