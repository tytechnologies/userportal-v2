// In-app notifications composable. Routes through /api/notifications/*.
// Read-only from the client's perspective — inserts come from server
// code paths via service-role.

export type Notification = {
  id: string
  recipient_user_id: string
  actor_user_id: string | null
  kind: string
  title: string
  body: string | null
  href: string | null
  contact_id: number | null
  listing_id: number | null
  metadata: Record<string, unknown>
  read_at: string | null
  dismissed_at: string | null
  created_at: string
}

export type NotificationsListResult = {
  data: Notification[]
  total: number
  unread_count: number
  page: number
  page_size: number
  total_pages: number
}

export type NotificationsListOptions = {
  page?: number
  pageSize?: number
  unread?: boolean
  kind?: string
}

export function useNotifications() {
  async function listNotifications(opts: NotificationsListOptions = {}): Promise<NotificationsListResult> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('page_size', String(opts.pageSize))
    if (opts.unread) params.set('unread', 'true')
    if (opts.kind) params.set('kind', opts.kind)
    const qs = params.toString()
    const url = qs ? `/api/notifications?${qs}` : '/api/notifications'
    // Cast through unknown — Nitro's typed-router union triggers TS2589
    // (excessive stack depth) on a generic string-template route.
    return await ($fetch(url) as unknown as Promise<NotificationsListResult>)
  }

  // Cast through unknown — Nitro's typed-router union triggers TS2589 on
  // the dynamic `/api/notifications/${id}` route segment.
  async function markRead(id: string): Promise<Notification> {
    return await ($fetch(`/api/notifications/${id}`, {
      method: 'PATCH',
      body: { read: true },
    } as any) as unknown as Promise<Notification>)
  }

  async function markUnread(id: string): Promise<Notification> {
    return await ($fetch(`/api/notifications/${id}`, {
      method: 'PATCH',
      body: { read: false },
    } as any) as unknown as Promise<Notification>)
  }

  async function dismiss(id: string): Promise<Notification> {
    return await ($fetch(`/api/notifications/${id}`, {
      method: 'PATCH',
      body: { dismissed: true },
    } as any) as unknown as Promise<Notification>)
  }

  async function markAllRead(): Promise<{ success: boolean; updated: number }> {
    return await ($fetch(
      '/api/notifications/mark-all-read',
      { method: 'POST' } as any,
    ) as unknown as Promise<{ success: boolean; updated: number }>)
  }

  return { listNotifications, markRead, markUnread, dismiss, markAllRead }
}
