// Document-drafts data layer. Distinct from useDocuments (which serves
// the existing materialized-DOCX `documents` table). Goes through the
// /api/document-drafts/* server routes so the client never talks to
// Supabase directly — RLS is enforced server-side and we get the
// usual nice error shapes.

export type DraftStatus = 'draft' | 'in_review' | 'signed' | 'archived'

export type DocumentDraft = {
  id: string
  owner_user_id: string | null
  contact_id: number | null
  listing_id: number | null
  template_id: string | null
  /** Phase 1 doc-system addition. Links the draft to one of the
   *  18 canonical document types (document_types table). Null for
   *  legacy drafts created before the column landed. */
  doc_type_key: string | null
  data: Record<string, unknown>
  storage_path: string | null
  storage_bucket: string | null
  storage_mime: string | null
  storage_size_bytes: number | null
  title: string | null
  status: DraftStatus
  tags: string[]
  created_at: string
  updated_at: string
}

export type CreateDraftInput = {
  template_id?: string | null
  contact_id?: number | null
  listing_id?: number | null
  data?: Record<string, unknown>
  title?: string
  tags?: string[]
}

export type UpdateDraftInput = {
  contact_id?: number | null
  listing_id?: number | null
  data?: Record<string, unknown>
  title?: string | null
  tags?: string[]
  /**
   * Optional optimistic-concurrency guard. When set, the server returns
   * 409 if the row's current updated_at differs — meaning someone
   * else saved between our last load and this PATCH. The editor uses
   * this to detect concurrent edits.
   */
  expected_updated_at?: string
}

export function useDocumentDrafts() {
  async function createDraft(input: CreateDraftInput): Promise<DocumentDraft> {
    return await $fetch<DocumentDraft>('/api/document-drafts', {
      method: 'POST',
      body: input,
    })
  }

  async function loadDraft(id: string): Promise<DocumentDraft> {
    if (!id) throw new Error('Missing draft id')
    return await $fetch<DocumentDraft>(`/api/document-drafts/${id}`)
  }

  async function saveDraft(id: string, patch: UpdateDraftInput): Promise<DocumentDraft> {
    if (!id) throw new Error('Missing draft id')
    return await $fetch<DocumentDraft>(`/api/document-drafts/${id}`, {
      method: 'PATCH',
      body: patch,
    })
  }

  async function deleteDraft(id: string): Promise<void> {
    if (!id) throw new Error('Missing draft id')
    await $fetch(`/api/document-drafts/${id}`, { method: 'DELETE' })
  }

  async function listDrafts(opts: {
    contact_id?: number
    listing_id?: number
    status?: DraftStatus
    tag?: string
    limit?: number
  } = {}): Promise<DocumentDraft[]> {
    const q: string[] = []
    if (opts.contact_id) q.push(`contact_id=${opts.contact_id}`)
    if (opts.listing_id) q.push(`listing_id=${opts.listing_id}`)
    if (opts.status)     q.push(`status=${opts.status}`)
    if (opts.tag)        q.push(`tag=${encodeURIComponent(opts.tag)}`)
    if (opts.limit)      q.push(`limit=${opts.limit}`)
    const url = q.length ? `/api/document-drafts?${q.join('&')}` : '/api/document-drafts'
    const res = await $fetch<{ data: DocumentDraft[] }>(url)
    return res?.data ?? []
  }

  async function listDraftsByContact(contactId: number): Promise<DocumentDraft[]> {
    if (!Number.isFinite(contactId)) return []
    const res = await $fetch<{ data: DocumentDraft[] }>(
      `/api/document-drafts/contact/${contactId}`,
    )
    return res?.data ?? []
  }

  // ---- Workflow / status -------------------------------------------------

  async function transitionDraft(
    id: string,
    to: 'draft' | 'in_review' | 'signed' | 'archived',
  ): Promise<DocumentDraft> {
    if (!id) throw new Error('Missing draft id')
    return await $fetch<DocumentDraft>(`/api/document-drafts/${id}/transition`, {
      method: 'POST',
      body: { to },
    })
  }

  // ---- Signatures --------------------------------------------------------

  /**
   * Upload a PNG signature for a draft + field. The data URL must be
   * "data:image/png;base64,...". Returns the signed URL the editor
   * embeds plus the storage path persisted in data._signatures.
   */
  async function uploadSignature(
    draftId: string,
    fieldKey: string,
    dataUrl: string,
  ): Promise<{ url: string; path: string; field_key: string }> {
    if (!draftId) throw new Error('Missing draft id')
    if (!fieldKey) throw new Error('Missing field key')
    return await $fetch<{ url: string; path: string; field_key: string }>(
      `/api/document-drafts/${draftId}/signature`,
      {
        method: 'POST',
        body: { field_key: fieldKey, data_url: dataUrl },
      },
    )
  }

  // ---- Share links -------------------------------------------------------

  async function createShareLink(draftId: string, expiresInDays = 7): Promise<ShareLink> {
    if (!draftId) throw new Error('Missing draft id')
    return await $fetch<ShareLink>(`/api/document-drafts/${draftId}/share`, {
      method: 'POST',
      body: { expires_in_days: expiresInDays },
    })
  }

  async function listShareLinks(draftId: string): Promise<ShareLink[]> {
    if (!draftId) throw new Error('Missing draft id')
    const res = await $fetch<{ data: ShareLink[] }>(
      `/api/document-drafts/${draftId}/share`,
    )
    return res?.data ?? []
  }

  async function revokeShareLink(linkId: string): Promise<void> {
    if (!linkId) throw new Error('Missing link id')
    await $fetch(`/api/document-drafts/share-links/${linkId}`, {
      method: 'DELETE',
    })
  }

  return {
    createDraft,
    loadDraft,
    saveDraft,
    deleteDraft,
    listDrafts,
    listDraftsByContact,
    transitionDraft,
    uploadSignature,
    createShareLink,
    listShareLinks,
    revokeShareLink,
  }
}

export type ShareLink = {
  id: string
  token: string
  expires_at: string
  revoked_at: string | null
  created_at: string
  created_by: string | null
  share_url?: string
}
