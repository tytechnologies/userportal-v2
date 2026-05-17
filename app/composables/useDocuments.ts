// Documents data layer. Wraps the existing /api/documents/* endpoints
// (which already enforce per-user RLS via Supabase) so the dashboard
// page stays presentational. No client-side service-role tricks; every
// caller is the authenticated user.

export type DocumentType =
  | 'viewing_list'
  | 'residential_contract_of_lease'
  | 'commercial_contract_of_lease'
  | 'letter_of_intent'
  | 'authority_to_sell'
  | 'contract_to_sell'
  | 'deed_of_absolute_sale'
  | 'property_management_agreement'
  | (string & {})

export type GeneratedDocument = {
  id: string
  document_type: DocumentType
  documentName: string
  documentUrl: string
  file_name: string
  file_format: 'pdf' | 'docx' | string
  metadata: Record<string, unknown> | null
  created_at: string
}

// Catalog of human-readable labels per type. Kept in the composable so
// the dashboard, the per-listing inbox, and any future report rendering
// share one source of truth.
export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  viewing_list: 'Viewing List',
  residential_contract_of_lease: 'Residential Contract of Lease',
  commercial_contract_of_lease: 'Commercial Contract of Lease',
  letter_of_intent: 'Letter of Intent',
  authority_to_sell: 'Authority to Sell',
  contract_to_sell: 'Contract to Sell',
  deed_of_absolute_sale: 'Deed of Absolute Sale',
  property_management_agreement: 'Property Management Agreement',
}

// Where each type lives in the existing legacy generator pages. The
// dashboard "Generate new" CTA routes here. Keep in sync if a generator
// page moves.
export const DOCUMENT_GENERATOR_PATH: Record<string, string> = {
  viewing_list: '/document-viewing-list',
  residential_contract_of_lease: '/contracts-residential-viewing-list',
  commercial_contract_of_lease: '/contracts-commercial-viewing-list',
  letter_of_intent: '/document-tabs',
  authority_to_sell: '/document-tabs',
  contract_to_sell: '/document-tabs',
  deed_of_absolute_sale: '/document-tabs',
  property_management_agreement: '/document-tabs',
}

export const DOCUMENT_TYPE_ICON: Record<string, string> = {
  viewing_list: '📄',
  residential_contract_of_lease: '🏠',
  commercial_contract_of_lease: '🏢',
  letter_of_intent: '✉️',
  authority_to_sell: '🔑',
  contract_to_sell: '📝',
  deed_of_absolute_sale: '🪪',
  property_management_agreement: '📋',
}

export function useDocuments() {
  /**
   * Fetches every document the caller can see (RLS-gated to created_by =
   * auth.uid() per the documents table policy). Optional `type` filter
   * is forwarded to PostgREST as ?type=, narrowing the SELECT server-side.
   */
  async function listDocuments(opts: { type?: DocumentType | '' } = {}): Promise<GeneratedDocument[]> {
    try {
      const url = opts.type
        ? `/api/documents/list?type=${encodeURIComponent(opts.type)}`
        : '/api/documents/list'
      const data = await $fetch<GeneratedDocument[]>(url)
      return Array.isArray(data) ? data : []
    } catch (err: any) {
      console.error('[useDocuments] listDocuments failed:', err?.message ?? err)
      return []
    }
  }

  /** Hard delete: removes the row + the S3 object. RLS-gated server-side. */
  async function deleteDocument(id: string): Promise<void> {
    if (!id) throw new Error('Missing document id')
    await $fetch(`/api/documents/${id}`, { method: 'DELETE' })
  }

  function labelFor(type: string): string {
    return DOCUMENT_TYPE_LABEL[type] ?? type.replace(/_/g, ' ')
  }

  function iconFor(type: string): string {
    return DOCUMENT_TYPE_ICON[type] ?? '📄'
  }

  function generatorPathFor(type: string): string | null {
    return DOCUMENT_GENERATOR_PATH[type] ?? null
  }

  return {
    listDocuments,
    deleteDocument,
    labelFor,
    iconFor,
    generatorPathFor,
  }
}
