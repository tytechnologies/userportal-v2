// Inquiries composable. Routes through /api/inquiries/* (portal-side)
// — the public submission path is /api/public/inquiries which the
// portal client never calls.

export type InquiryStatus = 'new' | 'in_progress' | 'replied' | 'closed' | 'spam'

export type Inquiry = {
  id: string
  listing_id: number
  assigned_user_id: string | null
  sender_name: string
  sender_email: string | null
  sender_phone: string | null
  sender_user_id: string | null
  message: string
  source: string
  status: InquiryStatus
  replied_at: string | null
  created_at: string
  updated_at: string
}

export type InquiriesListResult = {
  data: Inquiry[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export type InquiryStats = {
  residential: number
  commercial: number
  total: number
  mine_new: number
}

export function useInquiries() {
  async function listInquiries(opts: {
    page?: number
    pageSize?: number
    status?: InquiryStatus
    listingId?: number
    mine?: boolean
  } = {}): Promise<InquiriesListResult> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('page_size', String(opts.pageSize))
    if (opts.status) params.set('status', opts.status)
    if (opts.listingId) params.set('listing_id', String(opts.listingId))
    if (opts.mine) params.set('mine', 'true')
    const qs = params.toString()
    const url = qs ? `/api/inquiries?${qs}` : '/api/inquiries'
    return await $fetch<InquiriesListResult>(url)
  }

  async function updateInquiry(id: string, patch: { status?: InquiryStatus; assigned_user_id?: string | null }): Promise<Inquiry> {
    return await $fetch<Inquiry>(`/api/inquiries/${id}`, {
      method: 'PATCH',
      body: patch,
    })
  }

  async function fetchStats(): Promise<InquiryStats> {
    return await $fetch<InquiryStats>('/api/inquiries/stats')
  }

  return { listInquiries, updateInquiry, fetchStats }
}
