// CRM tasks composable. Routes through /api/tasks/*.

export type TaskStatus = 'open' | 'in_progress' | 'completed' | 'cancelled'
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

export type CrmTask = {
  id: string
  owner_user_id: string
  contact_id: number | null
  listing_id: number | null
  assignee_user_id: string | null
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  due_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type CreateTaskInput = {
  title: string
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  due_at?: string | null
  contact_id?: number | null
  listing_id?: number | null
  assignee_user_id?: string | null
}

export type UpdateTaskInput = Partial<CreateTaskInput>

export type TasksListResult = {
  data: CrmTask[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export type TasksListOptions = {
  page?: number
  pageSize?: number
  status?: TaskStatus
  assigned?: 'me'
  mine?: boolean
  contactId?: number
  listingId?: number
  dueBefore?: string
}

export function useTasks() {
  async function listTasks(opts: TasksListOptions = {}): Promise<TasksListResult> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('page_size', String(opts.pageSize))
    if (opts.status) params.set('status', opts.status)
    if (opts.assigned) params.set('assigned', opts.assigned)
    if (opts.mine) params.set('mine', 'true')
    if (opts.contactId) params.set('contact_id', String(opts.contactId))
    if (opts.listingId) params.set('listing_id', String(opts.listingId))
    if (opts.dueBefore) params.set('due_before', opts.dueBefore)
    const qs = params.toString()
    const url = qs ? `/api/tasks?${qs}` : '/api/tasks'
    return await $fetch<TasksListResult>(url)
  }

  async function createTask(input: CreateTaskInput): Promise<CrmTask> {
    return await $fetch<CrmTask>('/api/tasks', { method: 'POST', body: input })
  }

  async function updateTask(id: string, patch: UpdateTaskInput): Promise<CrmTask> {
    return await $fetch<CrmTask>(`/api/tasks/${id}`, { method: 'PATCH', body: patch })
  }

  async function deleteTask(id: string): Promise<void> {
    await $fetch(`/api/tasks/${id}`, { method: 'DELETE' })
  }

  /** Convenience: flip a task to completed in one call. */
  async function completeTask(id: string): Promise<CrmTask> {
    return await updateTask(id, { status: 'completed' })
  }

  return { listTasks, createTask, updateTask, deleteTask, completeTask }
}
