// CRM notes composable. Routes through /api/notes/*.

export type CrmNote = {
  id: string
  owner_user_id: string
  contact_id: number | null
  listing_id: number | null
  body: string
  is_pinned: boolean
  created_at: string
  updated_at: string
}

export type CreateNoteInput = {
  body: string
  contact_id?: number | null
  listing_id?: number | null
  is_pinned?: boolean
}

export type UpdateNoteInput = Partial<CreateNoteInput>

export type NotesListResult = {
  data: CrmNote[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export type NotesListOptions = {
  page?: number
  pageSize?: number
  contactId?: number
  listingId?: number
  mine?: boolean
  pinned?: boolean
}

export function useNotes() {
  async function listNotes(opts: NotesListOptions = {}): Promise<NotesListResult> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('page_size', String(opts.pageSize))
    if (opts.contactId) params.set('contact_id', String(opts.contactId))
    if (opts.listingId) params.set('listing_id', String(opts.listingId))
    if (opts.mine) params.set('mine', 'true')
    if (opts.pinned) params.set('pinned', 'true')
    const qs = params.toString()
    const url = qs ? `/api/notes?${qs}` : '/api/notes'
    return await $fetch<NotesListResult>(url)
  }

  async function createNote(input: CreateNoteInput): Promise<CrmNote> {
    return await $fetch<CrmNote>('/api/notes', { method: 'POST', body: input })
  }

  async function updateNote(id: string, patch: UpdateNoteInput): Promise<CrmNote> {
    return await $fetch<CrmNote>(`/api/notes/${id}`, { method: 'PATCH', body: patch })
  }

  async function deleteNote(id: string): Promise<void> {
    await $fetch(`/api/notes/${id}`, { method: 'DELETE' })
  }

  async function togglePin(id: string, current: boolean): Promise<CrmNote> {
    return await updateNote(id, { is_pinned: !current })
  }

  return { listNotes, createNote, updateNote, deleteNote, togglePin }
}
