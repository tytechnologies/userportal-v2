// Render a draft to DOCX or PDF and stash it in S3 +
// document_exports. Returns a signed download URL.
//
// POST /api/document-drafts/:id/export
// Body: { format: 'docx' | 'pdf' }
//
// The PDF path consults platform_settings.pdf_render for tunables;
// admins can flip headless / paper format / margins without redeploy.
// Render failures surface as 500 with a clear message; a follow-up
// retry is the expected path (renders are pure).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { serverSupabaseServiceRole } from '#supabase/server/serverSupabaseServiceRole'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { uploadObject, getSignedDownloadUrl } from '~~/server/utils/s3'
import { renderDraftToDocx, type DraftForExport } from '~~/server/utils/docx-renderer'
import { renderDraftToPdf } from '~~/server/utils/pdf-renderer'
import { requireRole } from '~~/server/utils/rbac'

const bodySchema = z.object({
  format:     z.enum(['docx', 'pdf']),
  version_id: z.string().uuid().optional(),
}).strict()

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'agent')
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid draft id' })
    }
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    // Read the draft (RLS-scoped). When version_id is supplied, read
    // the snapshot instead of the live row — exports pinned to a
    // specific version are the audit-friendly path.
    let draftRow: DraftForExport | null = null
    if (body.version_id) {
      const { data: snap, error: snapErr } = await (supabase as any)
        .from('document_versions')
        .select('snapshot_data, draft_id')
        .eq('id', body.version_id)
        .eq('draft_id', id)
        .maybeSingle()
      if (snapErr) throw createError({ statusCode: 500, statusMessage: snapErr.message })
      if (!snap) throw createError({ statusCode: 404, statusMessage: 'Version not found' })
      const { data: live } = await (supabase as any)
        .from('document_drafts')
        .select('id, title, template_id, doc_type_key, status')
        .eq('id', id)
        .maybeSingle()
      draftRow = {
        id,
        title: live?.title ?? null,
        template_id: live?.template_id ?? null,
        doc_type_key: live?.doc_type_key ?? null,
        data: snap.snapshot_data ?? {},
        status: live?.status ?? 'draft',
      }
    } else {
      const { data, error } = await (supabase as any)
        .from('document_drafts')
        .select('id, title, template_id, doc_type_key, status, data')
        .eq('id', id)
        .maybeSingle()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      if (!data)  throw createError({ statusCode: 404, statusMessage: 'Draft not found' })
      draftRow = data as DraftForExport
    }

    // Render. Wrap in a try so we can shape the failure as 500 with
    // a useful statusMessage instead of letting Puppeteer/docx
    // bubble up a generic "Internal Server Error".
    let bytes: Buffer
    try {
      if (body.format === 'docx') {
        bytes = await renderDraftToDocx(draftRow)
      } else {
        // Pull tunables from platform_settings.pdf_render via service
        // role (admins only have read access to platform_settings).
        const sr = serverSupabaseServiceRole(event) as any
        const { data: cfg } = await sr
          .from('platform_settings')
          .select('value')
          .eq('key', 'pdf_render')
          .maybeSingle()
        const v = (cfg?.value ?? {}) as Record<string, unknown>
        bytes = await renderDraftToPdf(draftRow, {
          headless:      v.headless     === false ? false : true,
          timeout_ms:    typeof v.timeout_ms === 'number' ? (v.timeout_ms as number) : 30_000,
          extra_args:    Array.isArray(v.extra_args) ? (v.extra_args as string[]) : [],
          paper_format:  (v.paper_format as 'Letter' | 'A4' | 'Legal') ?? 'Letter',
          margin_mm:     typeof v.margin_mm === 'number' ? (v.margin_mm as number) : 12,
        })
      }
    } catch (err: any) {
      logger.error(
        { err: err?.message, op: 'document_exports.render', format: body.format, draft_id: id },
        'doc_export_render_failed',
      )
      throw createError({
        statusCode: 500,
        statusMessage: `Render failed: ${err?.message ?? 'unknown'}`,
      })
    }

    // Upload to S3 under document-exports/<user>/<draft>/<id>.<ext>.
    const ts = Date.now()
    const exportId = (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
      ? (crypto as any).randomUUID()
      : `${ts}_${Math.random().toString(36).slice(2, 10)}`
    const ext = body.format === 'docx' ? 'docx' : 'pdf'
    const key = `document-exports/${user?.id ?? 'unknown'}/${id}/${exportId}.${ext}`
    try {
      await uploadObject(key, bytes)
    } catch (err: any) {
      logger.error({ err: err?.message, op: 'document_exports.upload' }, 'doc_export_upload_failed')
      throw createError({ statusCode: 500, statusMessage: 'Upload to storage failed' })
    }

    // Persist the export record. We don't pre-sign the URL here;
    // download endpoint signs on demand to keep the URL TTL fresh.
    const { data: inserted, error: insErr } = await (supabase as any)
      .from('document_exports')
      .insert({
        draft_id:     id,
        format:       body.format,
        storage_path: key,
        byte_length:  bytes.length,
        version_id:   body.version_id ?? null,
        generated_by: user?.id ?? null,
      })
      .select('*')
      .single()
    if (insErr) {
      logger.error({ err: insErr.message, op: 'document_exports.insert' }, 'doc_export_insert_failed')
      throw createError({ statusCode: 500, statusMessage: insErr.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'document_draft.exported' as any,
      entity: 'document',
      metadata: {
        draft_id: id,
        export_id: inserted?.id,
        format: body.format,
        byte_length: bytes.length,
      },
    })

    const url = await getSignedDownloadUrl(key, 3_600)
    setResponseStatus(event, 201)
    return {
      ...inserted,
      url,
      url_expires_in: 3_600,
    }
  },
})
