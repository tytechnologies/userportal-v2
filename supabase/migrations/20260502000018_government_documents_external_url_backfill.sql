-- Backfill the seed rows with their legacy image paths and publish.
--
-- The 24 rows seeded by 20260502000017 have no file attached — admins
-- would have to upload PDFs one-by-one before brokers could see
-- anything. The 26 reference images already live on disk under
-- public/img/documents/ (legacy assets), so we add an `external_url`
-- column that lets a row point at a static path INSTEAD of going
-- through S3, then backfill each seed row with its matching image
-- and flip status to 'published'.
--
-- s3_key + external_url are independent: an admin who later uploads a
-- proper PDF via "Replace file" gets s3_key set, and the read path
-- prefers s3_key > external_url. Removing s3_key (e.g. via an admin
-- delete) falls back to external_url. Either field on its own is
-- enough for the UI to render a clickable link.
--
-- DEPENDS ON:
--   20260502000016 (table)
--   20260502000017 (seed rows by title)

-- =====================================================================
-- 1. Schema column
-- =====================================================================

ALTER TABLE public.government_documents
  ADD COLUMN IF NOT EXISTS external_url text;

COMMENT ON COLUMN public.government_documents.external_url IS
  'Optional static URL or absolute path to the file (e.g. /img/documents/foo.jpg for a public asset). Used when the row references content not stored in S3. Read path prefers s3_key when both are set; UI falls back to external_url when s3_key is null.';

-- =====================================================================
-- 2. Backfill seed rows with their legacy image paths
-- =====================================================================
--
-- Mapping derived from app/pages/documents-old.vue's `image:` field
-- per checklist entry. Files exist under public/img/documents/ and
-- are served at /img/documents/<filename>.

DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('Copy of Deed of Absolute Sale',
        '/img/documents/deed-of-absolute-sale.jpg'),
      ('Original Copy of CCT (Condominium Certificate of Title)',
        '/img/documents/original-copy-cct.jpg'),
      ('Certified True Copy of CCT (Condominium Certificate of Title)',
        '/img/documents/certified-copy-cct.jpg'),
      ('Original Copy of Declaration of Real Property (Tax Declaration)',
        '/img/documents/original-copy-declaration-real-property.jpg'),
      ('Certified True Copy of Declaration of Real Property (Tax Declaration)',
        '/img/documents/certified-copy-declaration-real-property.jpg'),
      ('Original Copy of Certificate of Authorizing Registration',
        '/img/documents/original-copy-certificate-authorizing-registration.jpg'),
      ('Certified True Copy of Certificate of Authorizing Registration',
        '/img/documents/certified-copy-certificate-authorizing-registration.jpg'),
      ('Certified True Copy of Certificate of Non-Delinquency on Real Property Tax (Tax Clearance)',
        '/img/documents/certified-copy-tax-clearance.jpg'),
      ('Original Copy of Updated Real Property Tax Receipt',
        '/img/documents/original-copy-real-property-tax-receipt.jpg'),
      ('Original Copy of Certificate of Non-Tenancy from the Building Administration Office',
        '/img/documents/original-copy-certificate-non-tenancy.jpg'),
      ('Original Copy of the Certificate of Non-Delinquency of Bill Payments from the Building Administration Office',
        '/img/documents/original-copy-certificate-non-delinquency-of-bill-payments.jpg'),
      ('Original Copy of the Certificate of Management from the Building Administration',
        '/img/documents/original-copy-certificate-management.jpg'),
      ('2 Valid Government IDs',
        '/img/documents/government-id-passport.jpg'),
      ('Special Power of Attorney (SPA)',
        '/img/documents/special-power-attorney.jpg'),
      ('Notarized Deed of Absolute Sale',
        '/img/documents/doas.jpg'),
      ('Computation of Capital Gains Tax (CGT)',
        '/img/documents/cgt.jpg'),
      ('Computation of Documentary Stamp Tax (DST)',
        '/img/documents/dst.jpg'),
      ('Certificate Authorizing Registration (CAR)',
        '/img/documents/car.jpg'),
      ('Transfer Tax computation & payment',
        '/img/documents/transfer-tax.jpg'),
      ('Transfer of Certificate of Title (TCT)',
        '/img/documents/tct.jpg'),
      ('Property Title',
        '/img/documents/ctc-title.jpg'),
      ('Certified True Copies of the Title',
        '/img/documents/ctc-title.jpg'),
      ('New Tax Declaration under Buyer''s name',
        '/img/documents/new-tax-declaration.jpg'),
      ('Transmittal of the unit''s Original Document to the new Unit Owner',
        '/img/documents/transmittal.png')
    ) AS s(title, url)
  LOOP
    -- Only update if external_url is currently null. Re-running won't
    -- clobber an admin's later customization.
    UPDATE public.government_documents
       SET external_url = pair.url
     WHERE government_documents.title = pair.title
       AND government_documents.external_url IS NULL;
  END LOOP;
END $$;

-- =====================================================================
-- 3. Promote seed rows from draft → published
-- =====================================================================
--
-- Now that they have viewable content via external_url, brokers should
-- see them. Only flip rows that we just gave a URL to (still draft,
-- still no s3_key, has external_url). Admin-customized rows are left
-- untouched.

UPDATE public.government_documents
   SET status = 'published'
 WHERE status = 'draft'
   AND s3_key IS NULL
   AND external_url IS NOT NULL;

NOTIFY pgrst, 'reload schema';
