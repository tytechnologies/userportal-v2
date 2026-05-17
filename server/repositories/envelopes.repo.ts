// Envelopes repository â€” orchestrates document_envelopes,
// envelope_recipients, envelope_documents and the SECURITY DEFINER
// state-machine RPCs.
//
// Public token-based signing flows live in /api/public/envelope-sign
// and use getServerSupabaseAdmin() to bypass RLS for the token table
// lookup, then call envelope_recipient_advance via the admin client.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { enqueueOutboundEmail, absoluteUrl } from '~~/server/utils/outboundEmail'

export type EnvelopeStatus =
  | 'draft'
  | 'sent'
  | 'in_progress'
  | 'completed'
  | 'declined'
  | 'voided'
  | 'expired'

export type RecipientRole = 'signer' | 'approver' | 'viewer' | 'cc'
export type RecipientState =
  | 'pending'
  | 'invited'
  | 'opened'
  | 'signed'
  | 'declined'
  | 'skipped'

export type EnvelopeCreateInput = {
  title: string
  message?: string | null
  routing_kind?: 'sequential' | 'parallel'
  reminder_interval_hours?: number | null
  expires_at?: string | null
  deal_id?: string | null
}

export type EnvelopePatchInput = {
  title?: string
  message?: string | null
  routing_kind?: 'sequential' | 'parallel'
  reminder_interval_hours?: number | null
  expires_at?: string | null
  deal_id?: string | null
}

export type RecipientInput = {
  user_id?: string | null
  external_email?: string | null
  external_name?: string | null
  role?: RecipientRole
  sequence?: number
  required?: boolean
  notes?: string | null
}

const ENVELOPE_SELECT =
  'id, title, message, routing_kind, status, sent_at, completed_at, ' +
  'declined_at, voided_at, void_reason, expires_at, ' +
  'reminder_interval_hours, last_reminder_sent_at, deal_id, created_by, ' +
  'created_at, updated_at'

const RECIPIENT_SELECT =
  'id, envelope_id, user_id, external_email, external_name, role, sequence, ' +
  'required, state, invited_at, opened_at, signed_at, declined_at, ' +
  'decline_reason, signature_evidence, signed_from_ip, signed_from_ua, ' +
  'notes, created_at, updated_at'

export const envelopesRepo = {
  async list({
    event,
    status,
    dealId,
  }: {
    event: H3Event
    status?: EnvelopeStatus
    dealId?: string
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('document_envelopes')
      .select(ENVELOPE_SELECT)
      .order('created_at', { ascending: false })
    if (status) q = q.eq('status', status)
    if (dealId) q = q.eq('deal_id', dealId)
    const { data, error } = await q
    if (error) {
      logger.error({ err: error.message, op: 'envelopes.list' }, 'envelopes_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async get({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)

    const { data: envelope, error: eErr } = await (client as any)
      .from('document_envelopes')
      .select(ENVELOPE_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (eErr) {
      throw createError({ statusCode: 500, statusMessage: eErr.message })
    }
    if (!envelope) {
      throw createError({ statusCode: 404, statusMessage: 'Envelope not found' })
    }

    const [{ data: recipients }, { data: documents }] = await Promise.all([
      (client as any)
        .from('envelope_recipients')
        .select(RECIPIENT_SELECT)
        .eq('envelope_id', id)
        .order('sequence', { ascending: true })
        .order('created_at', { ascending: true }),
      (client as any)
        .from('envelope_documents')
        .select('id, document_draft_id, display_order, created_at')
        .eq('envelope_id', id)
        .order('display_order', { ascending: true }),
    ])

    return {
      envelope,
      recipients: recipients ?? [],
      documents: documents ?? [],
    }
  },

  async create({ event, input }: { event: H3Event; input: EnvelopeCreateInput }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const { data, error } = await (client as any)
      .from('document_envelopes')
      .insert({
        title: input.title,
        message: input.message ?? null,
        routing_kind: input.routing_kind ?? 'sequential',
        reminder_interval_hours: input.reminder_interval_hours ?? null,
        expires_at: input.expires_at ?? null,
        deal_id: input.deal_id ?? null,
        created_by: user.id,
      })
      .select(ENVELOPE_SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'envelopes.create' },
        'envelopes_create_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'envelope.created',
      entity: 'document',
      entityId: null,
      metadata: { envelope_id: data.id, deal_id: data.deal_id ?? null },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'envelopes_create_activity_log_failed',
      )
    })

    // Wrap to match the `get()` shape + the typed client contract in
    // useEnvelopes.create — `$fetch<{ envelope: Envelope }>`. Returning
    // bare `data` made envelope.value stay undefined on /envelopes/new,
    // which broke Stage 1 "Save and continue".
    return { envelope: data }
  },

  async patch({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: EnvelopePatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    if (input.title !== undefined) updates.title = input.title
    if (input.message !== undefined) updates.message = input.message
    if (input.routing_kind !== undefined) updates.routing_kind = input.routing_kind
    if (input.reminder_interval_hours !== undefined) {
      updates.reminder_interval_hours = input.reminder_interval_hours
    }
    if (input.expires_at !== undefined) updates.expires_at = input.expires_at
    if (input.deal_id !== undefined) updates.deal_id = input.deal_id
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('document_envelopes')
      .update(updates)
      .eq('id', id)
      .select(ENVELOPE_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Envelope not found' })
    }
    return { envelope: data }
  },

  async addRecipient({
    event,
    envelopeId,
    input,
  }: {
    event: H3Event
    envelopeId: string
    input: RecipientInput
  }) {
    const client = await serverSupabaseClient(event)
    if (!input.user_id && !input.external_email) {
      throw createError({
        statusCode: 400,
        statusMessage: 'At least one of user_id or external_email is required',
      })
    }
    const { data, error } = await (client as any)
      .from('envelope_recipients')
      .insert({
        envelope_id: envelopeId,
        user_id: input.user_id ?? null,
        external_email: input.external_email ?? null,
        external_name: input.external_name ?? null,
        role: input.role ?? 'signer',
        sequence: input.sequence ?? 0,
        required: input.required ?? true,
        notes: input.notes ?? null,
      })
      .select(RECIPIENT_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { recipient: data }
  },

  async patchRecipient({
    event,
    envelopeId,
    recipientId,
    input,
  }: {
    event: H3Event
    envelopeId: string
    recipientId: string
    input: Partial<RecipientInput>
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    if (input.user_id !== undefined) updates.user_id = input.user_id
    if (input.external_email !== undefined) updates.external_email = input.external_email
    if (input.external_name !== undefined) updates.external_name = input.external_name
    if (input.role !== undefined) updates.role = input.role
    if (input.sequence !== undefined) updates.sequence = input.sequence
    if (input.required !== undefined) updates.required = input.required
    if (input.notes !== undefined) updates.notes = input.notes
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('envelope_recipients')
      .update(updates)
      .eq('id', recipientId)
      .eq('envelope_id', envelopeId)
      .select(RECIPIENT_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Recipient not found' })
    }
    return { recipient: data }
  },

  async removeRecipient({
    event,
    envelopeId,
    recipientId,
  }: {
    event: H3Event
    envelopeId: string
    recipientId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { error } = await (client as any)
      .from('envelope_recipients')
      .delete()
      .eq('id', recipientId)
      .eq('envelope_id', envelopeId)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { ok: true }
  },

  async attachDocument({
    event,
    envelopeId,
    documentDraftId,
    displayOrder,
  }: {
    event: H3Event
    envelopeId: string
    documentDraftId: string
    displayOrder?: number
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('envelope_documents')
      .insert({
        envelope_id: envelopeId,
        document_draft_id: documentDraftId,
        display_order: displayOrder ?? 0,
      })
      .select('id, document_draft_id, display_order, created_at')
      .single()
    if (error) {
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'This document is already attached to the envelope',
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { document: data }
  },

  async detachDocument({
    event,
    envelopeId,
    envelopeDocumentId,
  }: {
    event: H3Event
    envelopeId: string
    envelopeDocumentId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { error } = await (client as any)
      .from('envelope_documents')
      .delete()
      .eq('id', envelopeDocumentId)
      .eq('envelope_id', envelopeId)
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { ok: true }
  },

  async send({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('envelope_send', {
      p_envelope_id: id,
    })
    if (error) {
      logger.error({ err: error.message, op: 'envelopes.send', id }, 'envelopes_send_failed')
      if ((error as any).code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      if ((error as any).code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: 'Envelope not found' })
      }
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'envelope.sent',
      entity: 'document',
      entityId: null,
      metadata: { envelope_id: id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'envelopes_send_activity_log_failed',
      )
    })

    // Fan-out: enqueue an outbound email for each invited recipient
    // with their unique signing URL. Service-role read of tokens table.
    enqueueInvitationsForEnvelope(id).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), envelope_id: id },
        'envelope_invitation_enqueue_failed',
      )
    })

    // Refetch the envelope (status now 'sent', sent_at populated) and
    // count tokens minted. envelope_send inserts one token per
    // recipient row regardless of role, so tokens_minted equals the
    // recipient count. envelope_recipient_tokens itself is RLS-gated
    // on envelopes.read.all permission and won't return rows for the
    // typical sender — counting recipients instead avoids the admin
    // client. Client contract: { envelope, tokens_minted } per
    // useEnvelopes.send typing.
    const { data: envelope, error: refetchError } = await (client as any)
      .from('document_envelopes')
      .select(ENVELOPE_SELECT)
      .eq('id', id)
      .single()
    if (refetchError) {
      throw createError({ statusCode: 500, statusMessage: refetchError.message })
    }
    const { count: tokens_minted } = await (client as any)
      .from('envelope_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('envelope_id', id)
    return { envelope, tokens_minted: tokens_minted ?? 0 }
  },

  async voidEnvelope({
    event,
    id,
    reason,
  }: {
    event: H3Event
    id: string
    reason: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('envelope_void', {
      p_envelope_id: id,
      p_reason: reason,
    })
    if (error) {
      if ((error as any).code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      if ((error as any).code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: 'Envelope not found' })
      }
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'envelope.voided',
      entity: 'document',
      entityId: null,
      metadata: { envelope_id: id, reason },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'envelopes_void_activity_log_failed',
      )
    })

    // Refetch so the client sees status='voided', voided_at, void_reason.
    // Client contract: { envelope } per useEnvelopes.voidEnvelope typing.
    const { data: envelope, error: refetchError } = await (client as any)
      .from('document_envelopes')
      .select(ENVELOPE_SELECT)
      .eq('id', id)
      .single()
    if (refetchError) {
      throw createError({ statusCode: 500, statusMessage: refetchError.message })
    }
    return { envelope }
  },

  async auditCertificate({ event, id }: { event: H3Event; id: string }) {
    return await auditCertificateImpl({ event, id })
  },
}

// =====================================================================
// Helper: enqueue per-recipient invitations after envelope_send
// =====================================================================
//
// Service-role reads tokens (RLS-blocked from authenticated). One
// outbound_emails row per recipient with the token-bearing signing
// URL. Idempotent via dedupe_key = `envelope-invite:<recipient_id>`.

async function enqueueInvitationsForEnvelope(envelopeId: string): Promise<void> {
  const admin = getServerSupabaseAdmin()

  const { data: envelope } = await (admin as any)
    .from('document_envelopes')
    .select('id, title, message, created_by')
    .eq('id', envelopeId)
    .maybeSingle()
  if (!envelope) return

  // Resolve sender display name (best-effort).
  let actorName: string | null = null
  if (envelope.created_by) {
    const { data: actor } = await (admin as any)
      .from('profiles')
      .select('full_name')
      .eq('id', envelope.created_by)
      .maybeSingle()
    actorName = actor?.full_name ?? null
  }

  const { data: recipients } = await (admin as any)
    .from('envelope_recipients')
    .select('id, role, user_id, external_email, external_name')
    .eq('envelope_id', envelopeId)
    .in('role', ['signer', 'approver'])

  if (!recipients || recipients.length === 0) return

  for (const r of recipients) {
    // Resolve recipient email + display name.
    let toEmail: string | null = r.external_email ?? null
    let toName: string | null = r.external_name ?? null
    if (!toEmail && r.user_id) {
      const { data: profile } = await (admin as any)
        .from('profiles')
        .select('email, full_name')
        .eq('id', r.user_id)
        .maybeSingle()
      toEmail = profile?.email ?? null
      toName = profile?.full_name ?? toName
    }
    if (!toEmail) continue

    // Pull the recipient's token (most recent unconsumed).
    const { data: tokenRow } = await (admin as any)
      .from('envelope_recipient_tokens')
      .select('token, expires_at')
      .eq('recipient_id', r.id)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!tokenRow?.token) continue

    const signingUrl = absoluteUrl(`/sign/${tokenRow.token}`) ?? `/sign/${tokenRow.token}`

    await enqueueOutboundEmail({
      to: toEmail,
      toName,
      recipientUserId: r.user_id ?? null,
      templateKind: 'envelope.invitation',
      subject: `Document to sign: ${envelope.title}`,
      templateInput: {
        recipientName: toName,
        actorName,
        title: envelope.title,
        body: envelope.message ?? null,
        hrefAbsolute: signingUrl,
      },
      dedupeKey: `envelope-invite:${r.id}`,
      referenceKind: 'envelope',
      referenceId: envelopeId,
    })
  }
}

// Internal: auditCertificate body lifted to a standalone helper so
// the enqueueInvitationsForEnvelope helper above can sit between the
// envelopesRepo declaration and the closing brace cleanly.
async function auditCertificateImpl({
  event,
  id,
}: {
  event: H3Event
  id: string
}): Promise<unknown> {
  const client = await serverSupabaseClient(event)
  const { data, error } = await (client as any).rpc('envelope_audit_certificate', {
    p_envelope_id: id,
  })
  if (error) {
    if ((error as any).code === '42501') {
      throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
    }
    if ((error as any).code === 'P0002') {
      throw createError({ statusCode: 404, statusMessage: 'Envelope not found' })
    }
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return data
}
