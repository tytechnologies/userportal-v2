// Listing shares composable (co-brokering primitive). Routes through
// /api/listing-shares/*.

export type ShareRole = 'co_broker' | 'viewer'
export type ShareStatus = 'pending' | 'accepted' | 'revoked'

export type ListingShare = {
  id: string
  listing_id: number
  shared_with_user_id: string
  shared_by_user_id: string | null
  share_role: ShareRole
  status: ShareStatus
  message: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export type CreateListingShareInput = {
  listing_id: number
  shared_with_user_id: string
  share_role?: ShareRole
  message?: string | null
  expires_at?: string | null
}

export type UpdateListingShareInput = {
  status?: ShareStatus
  share_role?: ShareRole
  message?: string | null
  expires_at?: string | null
}

export type ListingSharesListResult = {
  data: ListingShare[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export type ListingSharesListOptions = {
  page?: number
  pageSize?: number
  listingId?: number
  direction?: 'incoming' | 'outgoing'
  status?: ShareStatus
}

export function useListingShares() {
  async function listShares(opts: ListingSharesListOptions = {}): Promise<ListingSharesListResult> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('page_size', String(opts.pageSize))
    if (opts.listingId) params.set('listing_id', String(opts.listingId))
    if (opts.direction) params.set('direction', opts.direction)
    if (opts.status) params.set('status', opts.status)
    const qs = params.toString()
    const url = qs ? `/api/listing-shares?${qs}` : '/api/listing-shares'
    return await $fetch<ListingSharesListResult>(url)
  }

  async function createShare(input: CreateListingShareInput): Promise<ListingShare> {
    return await $fetch<ListingShare>('/api/listing-shares', { method: 'POST', body: input })
  }

  async function updateShare(id: string, patch: UpdateListingShareInput): Promise<ListingShare> {
    return await $fetch<ListingShare>(`/api/listing-shares/${id}`, { method: 'PATCH', body: patch })
  }

  async function deleteShare(id: string): Promise<void> {
    await $fetch(`/api/listing-shares/${id}`, { method: 'DELETE' })
  }

  /** Recipient: accept a pending invite. */
  async function acceptShare(id: string): Promise<ListingShare> {
    return await updateShare(id, { status: 'accepted' })
  }

  /** Recipient: decline a pending invite. */
  async function declineShare(id: string): Promise<ListingShare> {
    return await updateShare(id, { status: 'revoked' })
  }

  /** Owner: revoke an active share. */
  async function revokeShare(id: string): Promise<ListingShare> {
    return await updateShare(id, { status: 'revoked' })
  }

  return { listShares, createShare, updateShare, deleteShare, acceptShare, declineShare, revokeShare }
}
