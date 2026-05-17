// Tax computations data layer. Routes through /api/tax-computations/*.
//
// Records are saved snapshots of the legacy TaxComputationForm /
// TaxComputationCorporateForm state. Inputs go in `inputs` JSONB so
// the form schema can evolve without re-migrating the table.

export type TaxpayerType = 'individual' | 'corporate'
export type ComputationKind = 'gross' | 'nett' | 'nett_zv'

export type TaxComputation = {
  id: string
  owner_user_id: string
  contact_id: number | null
  listing_id: number | null
  taxpayer_type: TaxpayerType
  computation_kind: ComputationKind
  inputs: Record<string, unknown>
  title: string | null
  notes: string | null
  created_at: string
  updated_at: string
  owner?: { id: string; full_name: string | null; avatar_url: string | null } | null
}

export type CreateTaxComputationInput = {
  taxpayer_type: TaxpayerType
  computation_kind?: ComputationKind
  inputs: Record<string, unknown>
  title?: string | null
  notes?: string | null
  contact_id?: number | null
  listing_id?: number | null
}

export type UpdateTaxComputationInput = Partial<CreateTaxComputationInput>

export type TaxComputationsListOptions = {
  page?: number
  pageSize?: number
  mine?: boolean
  listingId?: number
  contactId?: number
  taxpayerType?: TaxpayerType
}

export type TaxComputationsListResult = {
  data: TaxComputation[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export function useTaxComputations() {
  async function listTaxComputations(opts: TaxComputationsListOptions = {}): Promise<TaxComputationsListResult> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('page_size', String(opts.pageSize))
    if (opts.mine) params.set('mine', 'true')
    if (opts.listingId) params.set('listing_id', String(opts.listingId))
    if (opts.contactId) params.set('contact_id', String(opts.contactId))
    if (opts.taxpayerType) params.set('taxpayer_type', opts.taxpayerType)
    const qs = params.toString()
    const url = qs ? `/api/tax-computations?${qs}` : '/api/tax-computations'
    // Cast through unknown — Nitro's typed-router union triggers TS2589
    // (excessive stack depth) on dynamic route segments.
    return await ($fetch(url) as unknown as Promise<TaxComputationsListResult>)
  }

  async function getTaxComputation(id: string): Promise<TaxComputation> {
    return await ($fetch(`/api/tax-computations/${id}`) as unknown as Promise<TaxComputation>)
  }

  async function createTaxComputation(input: CreateTaxComputationInput): Promise<TaxComputation> {
    return await ($fetch('/api/tax-computations', {
      method: 'POST',
      body: input,
    } as any) as unknown as Promise<TaxComputation>)
  }

  async function updateTaxComputation(id: string, patch: UpdateTaxComputationInput): Promise<TaxComputation> {
    return await ($fetch(`/api/tax-computations/${id}`, {
      method: 'PATCH',
      body: patch,
    } as any) as unknown as Promise<TaxComputation>)
  }

  async function deleteTaxComputation(id: string): Promise<void> {
    await $fetch(`/api/tax-computations/${id}`, { method: 'DELETE' })
  }

  return {
    listTaxComputations,
    getTaxComputation,
    createTaxComputation,
    updateTaxComputation,
    deleteTaxComputation,
  }
}
