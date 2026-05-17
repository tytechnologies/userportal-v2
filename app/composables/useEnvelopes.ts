// Wrapper around /api/envelopes/*. Keeps every page on a single
// $fetch surface so backend renames don't require a sweep through
// the page templates.

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

export type Envelope = {
  id: string
  title: string
  message: string | null
  routing_kind: 'sequential' | 'parallel'
  status: EnvelopeStatus
  sent_at: string | null
  completed_at: string | null
  declined_at: string | null
  voided_at: string | null
  void_reason: string | null
  expires_at: string | null
  reminder_interval_hours: number | null
  last_reminder_sent_at: string | null
  deal_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type Recipient = {
  id: string
  envelope_id: string
  user_id: string | null
  external_email: string | null
  external_name: string | null
  role: RecipientRole
  sequence: number
  required: boolean
  state: RecipientState
  invited_at: string | null
  opened_at: string | null
  signed_at: string | null
  declined_at: string | null
  decline_reason: string | null
  signature_evidence: Record<string, unknown> | null
  signed_from_ip: string | null
  signed_from_ua: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export type EnvelopeDocument = {
  id: string
  envelope_id: string
  document_draft_id: string
  display_order: number
  created_at: string
}

export function useEnvelopes() {
  async function list(opts: { status?: EnvelopeStatus; dealId?: string } = {}) {
    const query: Record<string, string> = {}
    if (opts.status) query.status = opts.status
    if (opts.dealId) query.deal_id = opts.dealId
    return await $fetch<{ items: Envelope[] }>('/api/envelopes', { query })
  }

  async function get(id: string) {
    return await $fetch<{
      envelope: Envelope
      recipients: Recipient[]
      documents: EnvelopeDocument[]
    }>(`/api/envelopes/${id}`)
  }

  async function create(input: {
    title: string
    message?: string | null
    routing_kind?: 'sequential' | 'parallel'
    reminder_interval_hours?: number | null
    expires_at?: string | null
    deal_id?: string | null
  }) {
    return await $fetch<{ envelope: Envelope }>('/api/envelopes', {
      method: 'POST',
      body: input,
    })
  }

  async function patch(id: string, body: Partial<Pick<Envelope, 'title' | 'message' | 'routing_kind' | 'reminder_interval_hours' | 'expires_at'>>) {
    return await $fetch<{ envelope: Envelope }>(`/api/envelopes/${id}`, {
      method: 'PATCH',
      body,
    })
  }

  async function addRecipient(envelopeId: string, input: {
    user_id?: string | null
    external_email?: string | null
    external_name?: string | null
    role?: RecipientRole
    sequence?: number
    required?: boolean
    notes?: string | null
  }) {
    return await $fetch<{ recipient: Recipient }>(
      `/api/envelopes/${envelopeId}/recipients`,
      { method: 'POST', body: input },
    )
  }

  async function removeRecipient(envelopeId: string, recipientId: string) {
    return await $fetch(
      `/api/envelopes/${envelopeId}/recipients/${recipientId}`,
      { method: 'DELETE' },
    )
  }

  async function attachDocument(envelopeId: string, documentDraftId: string, displayOrder?: number) {
    return await $fetch<{ document: EnvelopeDocument }>(
      `/api/envelopes/${envelopeId}/documents`,
      {
        method: 'POST',
        body: { document_draft_id: documentDraftId, display_order: displayOrder },
      },
    )
  }

  async function detachDocument(envelopeId: string, envelopeDocumentId: string) {
    return await $fetch(
      `/api/envelopes/${envelopeId}/documents/${envelopeDocumentId}`,
      { method: 'DELETE' },
    )
  }

  async function send(id: string) {
    return await $fetch<{ envelope: Envelope; tokens_minted: number }>(
      `/api/envelopes/${id}/send`,
      { method: 'POST', body: {} },
    )
  }

  async function voidEnvelope(id: string, reason: string) {
    return await $fetch<{ envelope: Envelope }>(
      `/api/envelopes/${id}/void`,
      { method: 'POST', body: { reason } },
    )
  }

  function auditCertificateUrl(id: string): string {
    return `/api/envelopes/${id}/audit-certificate`
  }

  return {
    list,
    get,
    create,
    patch,
    addRecipient,
    removeRecipient,
    attachDocument,
    detachDocument,
    send,
    voidEnvelope,
    auditCertificateUrl,
  }
}

// Display helpers — kept outside the composable so pages can import
// without instantiating $fetch (e.g. SSR-only label lookups).
export const ENVELOPE_STATUS_LABEL: Record<EnvelopeStatus, string> = {
  draft:       'Draft',
  sent:        'Sent',
  in_progress: 'In progress',
  completed:   'Completed',
  declined:    'Declined',
  voided:      'Voided',
  expired:     'Expired',
}

export const RECIPIENT_STATE_LABEL: Record<RecipientState, string> = {
  pending:  'Pending',
  invited:  'Invited',
  opened:   'Opened',
  signed:   'Signed',
  declined: 'Declined',
  skipped:  'Skipped',
}

export function envelopeStatusVariant(s: EnvelopeStatus):
  'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'info' {
  switch (s) {
    case 'draft':       return 'neutral'
    case 'sent':        return 'info'
    case 'in_progress': return 'warning'
    case 'completed':   return 'success'
    case 'declined':    return 'destructive'
    case 'voided':      return 'destructive'
    case 'expired':     return 'destructive'
  }
}

export function recipientStateVariant(s: RecipientState):
  'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'info' {
  switch (s) {
    case 'pending':  return 'neutral'
    case 'invited':  return 'info'
    case 'opened':   return 'warning'
    case 'signed':   return 'success'
    case 'declined': return 'destructive'
    case 'skipped':  return 'neutral'
  }
}
