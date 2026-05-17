-- Seed: sale_transfer_v1 + lease_v1 workflow templates.
--
-- Idempotent (ON CONFLICT DO NOTHING). Re-runs safely.
-- Step text is editable post-seed via SQL or future admin UI;
-- `key` is immutable (appears in documents.document_type +
-- activities.metadata).
--
-- See: docs/superpowers/specs/2026-05-12-post-signing-document-workflow-design.md
--
-- ROLLBACK:
--   DELETE FROM public.workflow_template_steps
--    WHERE template_id IN (SELECT id FROM public.workflow_templates
--                          WHERE key IN ('sale_transfer_v1','lease_v1'));
--   DELETE FROM public.workflow_templates WHERE key IN ('sale_transfer_v1','lease_v1');

-- =====================================================================
-- 1. sale_transfer_v1
-- =====================================================================

INSERT INTO public.workflow_templates (key, title, description, applies_to, active)
VALUES (
  'sale_transfer_v1',
  'Sale transfer documents',
  'Post-signing document upload workflow for property sale transfers: BIR taxes (CGT, DST), the BIR-issued CAR, provincial transfer tax, title transfer (CCT for condo / TCT for land), and final tax declaration in the buyer''s name.',
  'sale',
  true
)
ON CONFLICT (key) DO NOTHING;

-- Seed steps. attestation_text is "I confirm this is the correct <title> for this deal."
-- pre-substituted per row so the runtime doesn't have to template.

WITH t AS (
  SELECT id FROM public.workflow_templates WHERE key = 'sale_transfer_v1'
)
INSERT INTO public.workflow_template_steps
  (template_id, step_index, key, title, description, phase, branch, attestation_text)
SELECT t.id, v.step_index, v.key, v.title, v.description, v.phase, v.branch, v.attestation_text
FROM t, (VALUES
  ( 1, 'cgt_computation',
       'Computation of Capital Gains Tax (CGT)',
       'Upload the CGT computation for this sale. Required by the BIR before they will issue the CAR.',
       'bir_taxes', 'always',
       'I confirm this is the correct Computation of Capital Gains Tax (CGT) for this deal.'),
  ( 2, 'dst_computation',
       'Computation of Documentary Stamp Tax (DST)',
       'Upload the DST computation for this sale.',
       'bir_taxes', 'always',
       'I confirm this is the correct Computation of Documentary Stamp Tax (DST) for this deal.'),
  ( 3, 'bir_car_issued',
       'BIR-issued CAR (Certificate Authorizing Registration)',
       'Upload the BIR-issued CAR. Required to proceed to transfer tax + registration.',
       'bir_taxes', 'always',
       'I confirm this is the correct BIR-issued CAR for this deal.'),
  ( 4, 'transfer_tax_payment',
       'Transfer Tax computation & payment',
       'Upload the transfer tax computation and the proof of payment.',
       'transfer_tax', 'always',
       'I confirm this is the correct Transfer Tax computation & payment for this deal.'),
  ( 5, 'cct_original',
       'Original Copy of CCT',
       'Surrender the seller''s original Condominium Certificate of Title to the Register of Deeds. Upload a scan/photo for our records.',
       'title_transfer', 'condo_only',
       'I confirm this is the correct Original Copy of CCT for this deal.'),
  ( 6, 'cct_certified_true_copy',
       'Certified True Copy of CCT',
       'Upload the certified true copy of the new CCT issued in the buyer''s name.',
       'title_transfer', 'condo_only',
       'I confirm this is the correct Certified True Copy of CCT for this deal.'),
  ( 7, 'car_original',
       'Original Copy of Certificate of Authorizing Registration',
       'Upload the original BIR CAR document presented to the Register of Deeds.',
       'title_transfer', 'always',
       'I confirm this is the correct Original Copy of Certificate of Authorizing Registration for this deal.'),
  ( 8, 'car_certified_true_copy',
       'Certified True Copy of Certificate of Authorizing Registration',
       'Upload the certified true copy of the CAR.',
       'title_transfer', 'always',
       'I confirm this is the correct Certified True Copy of Certificate of Authorizing Registration for this deal.'),
  ( 9, 'tct_filed',
       'Transfer of Certificate of Title (TCT)',
       'Upload the filed TCT transfer paperwork.',
       'title_transfer', 'land_only',
       'I confirm this is the correct Transfer of Certificate of Title (TCT) for this deal.'),
  (10, 'property_title',
       'Property Title',
       'Upload the new property title issued in the buyer''s name.',
       'title_transfer', 'land_only',
       'I confirm this is the correct Property Title for this deal.'),
  (11, 'title_certified_true_copies',
       'Certified True Copies of the Title',
       'Upload certified true copies of the new title.',
       'title_transfer', 'land_only',
       'I confirm this is the correct Certified True Copies of the Title for this deal.'),
  (12, 'original_documents_transmittal',
       'Transmittal of unit''s Original Documents to new Owner',
       'Upload the transmittal receipt for the original documents handed over to the new owner.',
       'title_transfer', 'always',
       'I confirm this is the correct Transmittal of unit''s Original Documents to new Owner for this deal.'),
  (13, 'real_property_declaration',
       'Original Copy of Declaration of Real Property',
       'Upload the original Declaration of Real Property.',
       'tax_declaration', 'always',
       'I confirm this is the correct Original Copy of Declaration of Real Property for this deal.'),
  (14, 'rpt_non_delinquency_certified',
       'Certified True Copy of Certificate of Non-Delinquency on Real Property Tax',
       'Upload the certified true copy of the non-delinquency certificate.',
       'tax_declaration', 'always',
       'I confirm this is the correct Certified True Copy of Certificate of Non-Delinquency on Real Property Tax for this deal.'),
  (15, 'rpt_receipt_updated',
       'Original Copy of Updated Real Property Tax Receipt',
       'Upload the updated RPT receipt.',
       'tax_declaration', 'always',
       'I confirm this is the correct Original Copy of Updated Real Property Tax Receipt for this deal.'),
  (16, 'new_tax_declaration_buyer',
       'New Tax Declaration under Buyer''s name',
       'Upload the new tax declaration issued under the buyer''s name. Final step.',
       'tax_declaration', 'always',
       'I confirm this is the correct New Tax Declaration under Buyer''s name for this deal.')
) AS v(step_index, key, title, description, phase, branch, attestation_text)
ON CONFLICT (template_id, key) DO NOTHING;

-- =====================================================================
-- 2. lease_v1
-- =====================================================================

INSERT INTO public.workflow_templates (key, title, description, applies_to, active)
VALUES (
  'lease_v1',
  'Lease documents',
  'Post-signing document checklist for rental/lease deals: signed lease, tenant ID, deposit/advance receipts.',
  'lease',
  true
)
ON CONFLICT (key) DO NOTHING;

WITH t AS (
  SELECT id FROM public.workflow_templates WHERE key = 'lease_v1'
)
INSERT INTO public.workflow_template_steps
  (template_id, step_index, key, title, description, phase, branch, attestation_text)
SELECT t.id, v.step_index, v.key, v.title, v.description, v.phase, v.branch, v.attestation_text
FROM t, (VALUES
  (1, 'signed_lease_contract',
      'Signed lease contract (final executed copy)',
      'Upload the signed and dated lease contract.',
      'lease_documents', 'always',
      'I confirm this is the correct Signed lease contract (final executed copy) for this deal.'),
  (2, 'tenant_valid_id',
      'Tenant''s valid government ID',
      'Upload a scan/photo of the tenant''s valid government-issued ID.',
      'lease_documents', 'always',
      'I confirm this is the correct Tenant''s valid government ID for this deal.'),
  (3, 'security_deposit_receipt',
      'Proof of security deposit + advance rent payment',
      'Upload the receipt(s) for the security deposit and advance rent payment.',
      'lease_documents', 'always',
      'I confirm this is the correct Proof of security deposit + advance rent payment for this deal.')
) AS v(step_index, key, title, description, phase, branch, attestation_text)
ON CONFLICT (template_id, key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
