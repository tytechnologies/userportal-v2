# Documents table (generated files in S3 + metadata in DB)

Generated documents (viewing lists, contracts, etc.) are stored in S3. The **S3 key** and metadata are stored in Supabase so we can list, view, and delete by record—and generate signed URLs on demand.

## Setup

1. **Run the migration** (in Supabase SQL Editor or via CLI):

   ```bash
   supabase db push
   ```

   Or run the SQL in `migrations/20250129000000_create_documents_table.sql` manually.

2. **Environment**: Documents use the same Supabase access as properties (Nuxt `serverSupabaseClient` with the user’s session + RLS). No `SUPABASE_SERVICE_ROLE_KEY` is required for documents.

## Flow

- **Create**: When a document is generated (e.g. viewing list PDF, contract DOCX), the file is uploaded to S3 and a row is inserted into `public.documents` with `created_by`, `document_type`, `s3_key`, `file_name`, `file_format`, and `metadata`.
- **List**: List API reads from `documents` (filtered by current user and optional `document_type`), then generates a signed URL per row from `s3_key` for view/download.
- **View/Download**: Use the signed URL returned in the list, or call `GET /api/documents/:id` for a fresh signed URL.
- **Delete**: `DELETE /api/documents/:id` deletes the object from S3 (using `s3_key`) and the row from `documents`.

## Document types

Stored in `document_type`: `viewing_list`, `residential_contract_of_lease`, `commercial_contract_of_lease`, `letter_of_intent`, `authority_to_sell`, `contract_to_sell`, `deed_of_absolute_sale`, `property_management_agreement`, `other`.

## APIs

- `POST /api/documents/upload-viewing-list-pdf` — body: `{ pdfBase64, clientName, userId }` → uploads PDF to S3, inserts viewing_list row.
- `POST /api/documents/generate-docx` — body: `{ htmlTemplate, userId, documentName, metadata? }` → generates DOCX, uploads to S3, inserts row.
- `GET /api/documents/viewing-lists` — returns viewing list documents for current user (same shape as before: `{ id, documentName, documentUrl }[]`).
- `GET /api/documents/list?type=...` — list all document types (optional filter).
- `GET /api/documents/:id` — single document + signed URL.
- `DELETE /api/documents/:id` — delete from S3 and DB (current user only).
