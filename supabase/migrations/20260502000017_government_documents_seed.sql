-- Seed the government_documents library with the canonical entries
-- that were hardcoded in app/pages/documents-old.vue (the legacy
-- 3-step workflow checklist).
--
-- Each row is inserted as `status = 'draft'` so an admin must review
-- + publish before brokers see it. The admin can also attach the
-- actual PDF file via /admin/government-documents (Replace file).
--
-- Idempotent — uses a NOT EXISTS guard on title so re-running this
-- migration is safe and won't duplicate the seed.
--
-- DEPENDS ON:
--   20260502000016 (government_documents table)

DO $$
DECLARE
  -- Each tuple: (title, description, category, step_number).
  -- description seeds the broker-facing help text shown on
  -- /document-tabs (Document Checklist tab) and the standalone page.
  row RECORD;
BEGIN
  FOR row IN
    SELECT * FROM (VALUES
      -- ============================================================
      -- Step 1 — PRE-DOAS (gather these before the Deed of Absolute Sale)
      -- ============================================================
      (
        'Copy of Deed of Absolute Sale',
        'Working copy used during pre-DOAS preparation. The notarized version is collected at Step 2.',
        'other',
        1
      ),
      (
        'Original Copy of CCT (Condominium Certificate of Title)',
        'Original certificate, surrendered for the title transfer process.',
        'registration',
        1
      ),
      (
        'Certified True Copy of CCT (Condominium Certificate of Title)',
        'Certified copy obtained from the Register of Deeds.',
        'registration',
        1
      ),
      (
        'Original Copy of Declaration of Real Property (Tax Declaration)',
        'Original tax declaration issued by the city / municipal assessor.',
        'tax_declaration',
        1
      ),
      (
        'Certified True Copy of Declaration of Real Property (Tax Declaration)',
        'Certified copy obtained from the assessor''s office.',
        'tax_declaration',
        1
      ),
      (
        'Original Copy of Certificate of Authorizing Registration',
        'Original CAR issued by the BIR.',
        'registration',
        1
      ),
      (
        'Certified True Copy of Certificate of Authorizing Registration',
        'Certified copy of the CAR from the BIR.',
        'registration',
        1
      ),
      (
        'Certified True Copy of Certificate of Non-Delinquency on Real Property Tax (Tax Clearance)',
        'Tax clearance from the local treasurer confirming RPT is current.',
        'tax_declaration',
        1
      ),
      (
        'Original Copy of Updated Real Property Tax Receipt',
        'Most recent RPT receipt — proves taxes are paid through the current period.',
        'tax_declaration',
        1
      ),
      (
        'Original Copy of Certificate of Non-Tenancy from the Building Administration Office',
        'Confirms the unit has no current tenant. Issued by the building admin.',
        'other',
        1
      ),
      (
        'Original Copy of the Certificate of Non-Delinquency of Bill Payments from the Building Administration Office',
        'Confirms condo / association dues are paid current.',
        'other',
        1
      ),
      (
        'Original Copy of the Certificate of Management from the Building Administration',
        'Issued by the building admin; confirms management responsibilities.',
        'other',
        1
      ),
      (
        '2 Valid Government IDs',
        'Two valid government-issued IDs from the seller (and the buyer at closing).',
        'other',
        1
      ),
      (
        'Special Power of Attorney (SPA)',
        'Required when the seller / buyer is represented by an attorney-in-fact.',
        'other',
        1
      ),

      -- ============================================================
      -- Step 2 — BIR payment of Capital Gains taxes
      -- ============================================================
      (
        'Notarized Deed of Absolute Sale',
        'Notarized DOAS — the trigger document for BIR filing.',
        'capital_gains',
        2
      ),
      (
        'Computation of Capital Gains Tax (CGT)',
        'CGT computation worksheet. Use the in-portal Tax Computation tool to generate.',
        'capital_gains',
        2
      ),
      (
        'Computation of Documentary Stamp Tax (DST)',
        'DST computation worksheet (typically 1.5% of higher of zonal value / contract price).',
        'capital_gains',
        2
      ),
      (
        'Certificate Authorizing Registration (CAR)',
        'BIR-issued CAR — required to proceed to transfer tax + registration.',
        'capital_gains',
        2
      ),
      (
        'Transfer Tax computation & payment',
        'Local transfer tax computation + payment receipt from the city / provincial treasurer.',
        'transfer_tax',
        2
      ),
      (
        'Transfer of Certificate of Title (TCT)',
        'TCT transfer documentation — submitted to the Register of Deeds.',
        'registration',
        2
      ),

      -- ============================================================
      -- Step 3 — Transfer taxes and Registration fees
      -- ============================================================
      (
        'Property Title',
        'Final transferred title in the buyer''s name.',
        'registration',
        3
      ),
      (
        'Certified True Copies of the Title',
        'Certified copies of the new title from the Register of Deeds.',
        'registration',
        3
      ),
      (
        'New Tax Declaration under Buyer''s name',
        'New tax declaration issued by the assessor in the buyer''s name.',
        'tax_declaration',
        3
      ),
      (
        'Transmittal of the unit''s Original Document to the new Unit Owner',
        'Hand-off of all original documents to the new owner — closes the transfer.',
        'registration',
        3
      )
    ) AS s(title, description, category, step_number)
  LOOP
    -- Skip if a row with this title already exists (idempotency guard).
    IF NOT EXISTS (
      SELECT 1 FROM public.government_documents
      WHERE government_documents.title = row.title
    ) THEN
      INSERT INTO public.government_documents (
        title,
        description,
        category,
        step_number,
        display_order,
        status
      ) VALUES (
        row.title,
        row.description,
        row.category,
        row.step_number,
        row.step_number * 100,  -- coarse default ordering by step
        'draft'
      );
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
