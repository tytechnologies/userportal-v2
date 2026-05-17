// Government reference documents composable. Routes through
// /api/government-documents/*.

export type GovDocCategory =
  | 'capital_gains'
  | 'transfer_tax'
  | 'registration'
  | 'tax_declaration'
  | 'other'

export type GovDocStatus = 'draft' | 'published' | 'archived'

export type GovernmentDocument = {
  id: string
  title: string
  description: string | null
  category: GovDocCategory
  step_number: number | null
  display_order: number
  s3_key: string | null
  file_name: string | null
  file_format: string | null
  /** Static URL or absolute path (e.g. /img/documents/foo.jpg) for rows
   *  that reference legacy public assets instead of S3. */
  external_url: string | null
  checklist_items: unknown[]
  status: GovDocStatus
  created_at: string
  updated_at: string
  /** Freshly-signed S3 download URL (only present when s3_key is set). */
  signed_url?: string
  /** Unified link target: signed_url > external_url > ''. Use this in
   *  the UI instead of branching on signed_url vs external_url. */
  display_url?: string
}

export type GovDocsListResult = {
  data: GovernmentDocument[]
  total: number
}

export type CreateGovDocInput = {
  title: string
  description?: string | null
  category?: GovDocCategory
  step_number?: number | null
  display_order?: number
  status?: GovDocStatus
  checklist_items?: unknown[]
  /** Optional file (data URL — pdf or image). */
  file_data_url?: string | null
  file_name?: string | null
}

export type UpdateGovDocInput = Partial<Omit<CreateGovDocInput, 'file_data_url' | 'file_name'>>

export function useGovernmentDocuments() {
  async function listGovDocs(opts: {
    category?: GovDocCategory
    status?: GovDocStatus
    search?: string
  } = {}): Promise<GovDocsListResult> {
    const params = new URLSearchParams()
    if (opts.category) params.set('category', opts.category)
    if (opts.status) params.set('status', opts.status)
    if (opts.search) params.set('search', opts.search)
    const qs = params.toString()
    const url = qs ? `/api/government-documents?${qs}` : '/api/government-documents'
    return await $fetch<GovDocsListResult>(url)
  }

  async function createGovDoc(input: CreateGovDocInput): Promise<GovernmentDocument> {
    return await $fetch<GovernmentDocument>('/api/government-documents', {
      method: 'POST',
      body: input,
    })
  }

  async function updateGovDoc(id: string, patch: UpdateGovDocInput): Promise<GovernmentDocument> {
    return await $fetch<GovernmentDocument>(`/api/government-documents/${id}`, {
      method: 'PATCH',
      body: patch,
    })
  }

  async function deleteGovDoc(id: string): Promise<void> {
    await $fetch(`/api/government-documents/${id}`, { method: 'DELETE' })
  }

  /** Replace the file attached to a doc. The previous S3 object is
   *  deleted on success; the row's s3_key/file_name/file_format are
   *  updated atomically on the server. */
  async function replaceGovDocFile(
    id: string,
    file: { file_data_url: string; file_name: string },
  ): Promise<GovernmentDocument> {
    return await $fetch<GovernmentDocument>(`/api/government-documents/${id}/file`, {
      method: 'POST',
      body: file,
    })
  }

  return {
    listGovDocs,
    createGovDoc,
    updateGovDoc,
    deleteGovDoc,
    replaceGovDocFile,
  }
}

// Display labels for the category enum — used by both the broker
// browse page and the admin edit form.
export const GOV_DOC_CATEGORY_LABELS: Record<GovDocCategory, string> = {
  capital_gains: 'Step 1 · BIR Capital Gains',
  transfer_tax: 'Step 2 · Transfer Tax',
  registration: 'Step 3 · Registration',
  tax_declaration: 'Step 4 · Tax Declaration',
  other: 'Other / Reference',
}
