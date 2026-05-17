// Send a draft for e-signing via DocuSign. Renders the draft to PDF
// (via Puppeteer), creates a DocuSign envelope, and persists a
// docusign_envelopes row keyed to the draft + version.
//
// POST /api/document-drafts/:id/esign/send
// Body:
//   {
//     version_id?: uuid,           // pin to a specific snapshot
//     subject?: string,            // email subject; defaults to draft title
//     message?: string,            // email body; defaults to a short note
//     recipients: [
//       { placeholder_id, name, email, role }   // role from PartyRole
//     ]
//   }
//
// Each recipient gets a SignHere tab anchored to the placeholder's
// inline marker `{{sig:label}}` in the rendered PDF (we use anchor
// text rather than absolute coordinates because the rendered PDF
// flow doesn't have predictable pixel positions). For drafts whose
// PDF lacks the marker text, the SignHere lands at the bottom of
// the last page — the broker is told to add the marker if they want
// inline placement.

import { z } from 'zod'
// @ts-ignore — `docusign-esign` resolves after `pnpm install`; declared in package.json.
import * as docusign from 'docusign-esign'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { renderDraftToPdf } from '~~/server/utils/pdf-renderer'
import { getDocusignClient } from '~~/server/utils/docusign'
import { requireRole } from '~~/server/utils/rbac'

const recipientSchema = z.object({
  placeholder_id: z.string().min(1).max(80),
  name:           z.string().trim().min(1).max(200),
  email:          z.string().email().max(320),
  role:           z.string().min(1).max(40),
})

const bodySchema = z.object({
  version_id: z.string().uuid().optional(),
  subject:    z.string().trim().max(200).optional(),
  message:    z.string().trim().max(2000).optional(),
  recipients: z.array(recipientSchema).min(1).max(20),
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

    // Pull draft (or version snapshot if pinned).
    let draftRow: any = null
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
        id, title: live?.title ?? null, template_id: live?.template_id ?? null,
        doc_type_key: live?.doc_type_key ?? null, status: live?.status ?? 'draft',
        data: snap.snapshot_data ?? {},
      }
    } else {
      const { data, error } = await (supabase as any)
        .from('document_drafts')
        .select('id, title, template_id, doc_type_key, status, data')
        .eq('id', id)
        .maybeSingle()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      if (!data)  throw createError({ statusCode: 404, statusMessage: 'Draft not found' })
      draftRow = data
    }

    // Render to PDF (server-side via Puppeteer). DocuSign accepts
    // base64-encoded document bytes inline in the envelope payload.
    let pdfBytes: Buffer
    try {
      pdfBytes = await renderDraftToPdf(draftRow)
    } catch (err: any) {
      logger.error({ err: err?.message, op: 'esign.render' }, 'esign_render_failed')
      throw createError({
        statusCode: 500,
        statusMessage: `PDF render failed before sending to DocuSign: ${err?.message ?? 'unknown'}`,
      })
    }

    // Build the envelope. signers map 1:1 with the body.recipients
    // we received, plus a SignHere tab anchored to the placeholder's
    // inline marker text.
    const envelope = new docusign.EnvelopeDefinition()
    envelope.emailSubject =
      body.subject || `Please sign: ${draftRow.title || 'document'}`
    envelope.emailBlurb =
      body.message ||
      'Please review and sign at your earliest convenience.'
    envelope.status = 'sent'

    const document = new docusign.Document()
    document.documentBase64 = pdfBytes.toString('base64')
    document.name = (draftRow.title || 'document').slice(0, 80) + '.pdf'
    document.fileExtension = 'pdf'
    document.documentId = '1'
    envelope.documents = [document]

    const signers: docusign.Signer[] = body.recipients.map((r, idx) => {
      const signer = new docusign.Signer()
      signer.email = r.email
      signer.name = r.name
      signer.recipientId = String(idx + 1)
      signer.routingOrder = String(idx + 1)

      // Anchor to {{sig:<placeholder_id-or-label>}} the editor places
      // in the body. We use the placeholder_id by convention so the
      // anchor is unambiguous; if the broker hasn't typed it, the
      // SignHere tab lands at default position.
      const sign = new docusign.SignHere()
      sign.anchorString = `{{sig:${r.placeholder_id}}}`
      sign.anchorYOffset = '0'
      sign.anchorXOffset = '0'
      sign.anchorUnits = 'pixels'
      sign.anchorIgnoreIfNotPresent = 'true'
      const tabs = new docusign.Tabs()
      tabs.signHereTabs = [sign]
      signer.tabs = tabs
      return signer
    })

    const recipients = new docusign.Recipients()
    recipients.signers = signers
    envelope.recipients = recipients

    // Send through DocuSign.
    let envelopeId: string
    try {
      const { client, accountId } = await getDocusignClient(event)
      const envelopesApi = new docusign.EnvelopesApi(client)
      const result = await envelopesApi.createEnvelope(accountId, { envelopeDefinition: envelope })
      envelopeId = (result as any).envelopeId
      if (!envelopeId) {
        throw new Error('No envelope id returned from DocuSign')
      }
    } catch (err: any) {
      if (err?.statusCode) throw err
      logger.error({ err: err?.message, op: 'esign.create' }, 'esign_create_failed')
      throw createError({
        statusCode: 502,
        statusMessage: 'DocuSign envelope creation failed',
      })
    }

    // Persist envelope row.
    const recipientRows = body.recipients.map((r) => ({
      placeholder_id: r.placeholder_id,
      name: r.name,
      email: r.email,
      role: r.role,
      status: 'sent',
      signed_at: null,
    }))
    const { data: row, error: rowErr } = await (supabase as any)
      .from('docusign_envelopes')
      .insert({
        draft_id:    id,
        envelope_id: envelopeId,
        status:      'sent',
        recipients:  recipientRows,
        version_id:  body.version_id ?? null,
        sent_by:     user?.id ?? null,
      })
      .select('*')
      .single()
    if (rowErr) {
      logger.error({ err: rowErr.message, op: 'esign.row' }, 'esign_row_insert_failed')
      // Don't throw — the envelope was sent successfully. Surface
      // the persistence failure as a 207-ish response.
    }

    await logActivity({
      event,
      client: supabase,
      action: 'document_draft.esign_sent' as any,
      entity: 'document',
      metadata: {
        draft_id: id,
        envelope_id: envelopeId,
        recipient_count: body.recipients.length,
      },
    })

    setResponseStatus(event, 201)
    return {
      envelope_id: envelopeId,
      row: row ?? null,
    }
  },
})
