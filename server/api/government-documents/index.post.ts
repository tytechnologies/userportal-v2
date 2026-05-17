// Create a government reference document. Admin-gated via the
// gov_docs_write RLS policy (gov_docs.write permission).
//
// Two flavors:
//   - Metadata-only: body has title + description + category +
//     status; s3_key/file_name come later via the upload endpoint.
//   - Full upload: body includes file_base64 + mime_type; we decode,
//     upload to S3 under government-documents/<category>/<ts>-<name>,
//     then insert.
//
// Keeping the upload bundled here (vs. a separate /upload endpoint
// like document templates use) since gov docs are simpler — no row-
// then-upload state machine, no swap-on-update flow.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { uploadObject, deleteObjectsByKeys, decodeDataUrl } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).nullable().optional(),
  category: z
    .enum(['capital_gains', 'transfer_tax', 'registration', 'tax_declaration', 'other'])
    .default('other'),
  step_number: z.number().int().min(1).max(99).nullable().optional(),
  display_order: z.number().int().min(0).max(9999).default(0),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  checklist_items: z.array(z.unknown()).optional(),
  // Optional file payload — base64 data URL ("data:application/pdf;base64,..."
  // OR "data:image/<png|jpg|webp>;base64,..."). Capped at 50 MB.
  file_data_url: z
    .string()
    .min(20)
    .max(50_000_000)
    .nullable()
    .optional(),
  file_name: z.string().max(255).nullable().optional(),
})

const ALLOWED_FORMATS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx'])

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\-+ ]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 200) || 'document'
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const supabase = await serverSupabaseClient(event)

    let s3Key: string | null = null
    let fileFormat: string | null = null
    let fileName: string | null = body.file_name ?? null

    if (body.file_data_url) {
      // Reuse decodeDataUrl for image MIMEs; PDFs need a manual decode
      // since the helper only matches data:image/...
      const pdfMatch = body.file_data_url.match(/^data:application\/pdf;base64,/)
      if (pdfMatch) {
        const base64 = body.file_data_url.replace(/^data:application\/pdf;base64,/, '')
        const buffer = Buffer.from(base64, 'base64')
        if (buffer.length === 0) {
          throw createError({ statusCode: 400, statusMessage: 'Empty PDF body' })
        }
        const safe = sanitizeFileName(body.file_name ?? 'document.pdf')
        fileName = safe
        fileFormat = 'pdf'
        s3Key = `government-documents/${body.category}/${Date.now()}-${safe}`
        try {
          await uploadObject(s3Key, buffer)
        } catch (e: any) {
          logger.error({ err: e?.message, s3Key }, 'gov_docs_upload_failed')
          throw createError({ statusCode: 500, statusMessage: 'Upload failed.' })
        }
      } else {
        // Image variant — delegate to the canonical helper.
        const { extension, body: buf } = decodeDataUrl(body.file_data_url)
        if (!ALLOWED_FORMATS.has(extension)) {
          throw createError({
            statusCode: 422,
            statusMessage: `Unsupported file type: ${extension}`,
          })
        }
        const safe = sanitizeFileName(body.file_name ?? `document.${extension}`)
        fileName = safe
        fileFormat = extension === 'jpeg' ? 'jpg' : extension
        s3Key = `government-documents/${body.category}/${Date.now()}-${safe}`
        try {
          await uploadObject(s3Key, buf)
        } catch (e: any) {
          logger.error({ err: e?.message, s3Key }, 'gov_docs_upload_failed')
          throw createError({ statusCode: 500, statusMessage: 'Upload failed.' })
        }
      }
    }

    const insert: Record<string, unknown> = {
      title: body.title,
      description: body.description ?? null,
      category: body.category,
      step_number: body.step_number ?? null,
      display_order: body.display_order,
      status: body.status,
      checklist_items: body.checklist_items ?? [],
      s3_key: s3Key,
      file_name: fileName,
      file_format: fileFormat,
      created_by: user?.id ?? null,
    }

    const { data, error } = await (supabase as any)
      .from('government_documents')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      // S3 upload succeeded but DB insert failed — clean up the orphan.
      if (s3Key) {
        try { await deleteObjectsByKeys([s3Key]) }
        catch (cleanupErr) {
          logger.error(
            { err: (cleanupErr as Error).message, s3Key },
            'gov_docs_orphan_cleanup_failed',
          )
        }
      }
      logger.error({ err: error.message, op: 'gov_docs.create' }, 'gov_docs_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    setResponseStatus(event, 201)
    return data
  },
})
