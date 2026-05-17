// Template definitions data layer + hybrid registry.
//
// Two distinct exports:
//   - useTemplateDefinitions() — admin CRUD (list/load/create/save/delete/
//     uploadBackground). Goes through /api/document-template-definitions/*.
//   - useTemplates() — UNION of the static registry (documentTemplates.ts)
//     and PUBLISHED DB templates. This is what /document-drafts/new and
//     DocumentEditor consume — non-admins see static + published only.

import {
  documentTemplates as staticTemplates,
  type DocumentTemplate,
  type DocumentTemplateField,
} from '~/utils/documentTemplates'

export type TemplateStatus = 'draft' | 'published' | 'archived'

export type TemplateDefinition = {
  id: string
  name: string
  description: string | null
  background_path: string | null
  background_name: string | null
  background_mime: string | null
  /** Signed URL for the background; populated by GET /[id]. */
  background_url: string | null
  width: number
  height: number
  fields: DocumentTemplateField[]
  status: TemplateStatus
  created_by: string | null
  created_at: string
  updated_at: string
}

export type TemplateDefinitionInput = {
  id: string
  name: string
  description?: string | null
  width?: number
  height?: number
  fields?: DocumentTemplateField[]
  status?: TemplateStatus
}

export type TemplateDefinitionPatch = {
  name?: string
  description?: string | null
  width?: number
  height?: number
  fields?: DocumentTemplateField[]
  status?: TemplateStatus
}

export function useTemplateDefinitions() {
  async function listTemplates(opts: { status?: TemplateStatus; limit?: number } = {}): Promise<TemplateDefinition[]> {
    const q: string[] = []
    if (opts.status) q.push(`status=${opts.status}`)
    if (opts.limit) q.push(`limit=${opts.limit}`)
    const url = q.length
      ? `/api/document-template-definitions?${q.join('&')}`
      : '/api/document-template-definitions'
    const res = await $fetch<{ data: TemplateDefinition[] }>(url)
    return res?.data ?? []
  }

  async function loadTemplate(id: string): Promise<TemplateDefinition> {
    if (!id) throw new Error('Missing template id')
    return await $fetch<TemplateDefinition>(`/api/document-template-definitions/${id}`)
  }

  async function createTemplate(input: TemplateDefinitionInput): Promise<TemplateDefinition> {
    return await $fetch<TemplateDefinition>('/api/document-template-definitions', {
      method: 'POST',
      body: input,
    })
  }

  async function saveTemplate(id: string, patch: TemplateDefinitionPatch): Promise<TemplateDefinition> {
    if (!id) throw new Error('Missing template id')
    return await $fetch<TemplateDefinition>(`/api/document-template-definitions/${id}`, {
      method: 'PATCH',
      body: patch,
    })
  }

  async function deleteTemplate(id: string): Promise<void> {
    if (!id) throw new Error('Missing template id')
    await $fetch(`/api/document-template-definitions/${id}`, { method: 'DELETE' })
  }

  /**
   * Upload (or replace) a template's background image. Base64 over
   * JSON, same shape as the document-drafts importer. Returns the
   * updated row (with new background_path).
   */
  async function uploadBackground(
    id: string,
    file: File,
    opts: { width?: number; height?: number } = {},
  ): Promise<TemplateDefinition> {
    if (!id) throw new Error('Missing template id')
    if (file.size === 0) throw new Error('File is empty.')
    if (file.size > 90 * 1024 * 1024) throw new Error('File is too large (max 90 MB).')

    // Chunked base64 — same trick as the document drafts uploader to
    // avoid String.fromCharCode arg-limit issues on big files.
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x10000
    let binary = ''
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[])
    }
    const file_base64 = btoa(binary)

    return await $fetch<TemplateDefinition>(
      `/api/document-template-definitions/${id}/upload-background`,
      {
        method: 'POST',
        body: {
          file_name: file.name,
          mime_type: file.type || 'image/png',
          file_base64,
          width: opts.width,
          height: opts.height,
        },
      },
    )
  }

  return {
    listTemplates,
    loadTemplate,
    createTemplate,
    saveTemplate,
    deleteTemplate,
    uploadBackground,
  }
}

// =====================================================================
// Hybrid registry — what /document-drafts consumers see
// =====================================================================
//
// Returns the union of the static registry + published DB templates.
// Static templates take precedence on id collision (they're hardcoded
// for a reason — keep the legacy behavior).
//
// Module-scoped cache so multiple components on a page share one fetch.

const dbTemplatesCache = ref<TemplateDefinition[]>([])
const dbTemplatesLoaded = ref(false)
let dbTemplatesInflight: Promise<TemplateDefinition[]> | null = null

async function fetchPublishedDbTemplates(): Promise<TemplateDefinition[]> {
  if (dbTemplatesLoaded.value) return dbTemplatesCache.value
  if (dbTemplatesInflight) return await dbTemplatesInflight
  // Skip the fetch on SSR: the API requires auth, and the server pass
  // doesn't carry the user's Supabase cookie. Without this guard the
  // SSR mount produced 401s in the server log every page load (visible
  // as "[useTemplates] failed to fetch DB templates: 401 Unauthorized").
  // The client-side mount that follows hydrates the cache normally.
  if (import.meta.server) {
    return []
  }
  dbTemplatesInflight = (async () => {
    try {
      const res = await $fetch<{ data: TemplateDefinition[] }>(
        '/api/document-template-definitions?status=published',
      )
      dbTemplatesCache.value = res?.data ?? []
      dbTemplatesLoaded.value = true
      return dbTemplatesCache.value
    } catch (err) {
      console.error('[useTemplates] failed to fetch DB templates:', err)
      dbTemplatesCache.value = []
      dbTemplatesLoaded.value = true
      return []
    } finally {
      dbTemplatesInflight = null
    }
  })()
  return await dbTemplatesInflight
}

/** Normalize a DB template row into the shape DocumentEditor expects. */
function dbToTemplate(row: TemplateDefinition): DocumentTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    // Use the signed URL when present, fall back to the storage path
    // (the editor's <img> tag will 403 in that case — caller should
    // re-fetch via /api/document-template-definitions/[id]).
    background: row.background_url ?? row.background_path ?? '',
    width: row.width,
    height: row.height,
    fields: row.fields,
  }
}

export function useTemplates() {
  const all = ref<DocumentTemplate[]>([...staticTemplates])
  const isLoading = ref(false)

  async function refresh() {
    isLoading.value = true
    try {
      const dbRows = await fetchPublishedDbTemplates()
      // Static first; DB rows fill in gaps. Static IDs win conflicts
      // because hardcoded behavior trumps user-shipped overrides.
      const staticIds = new Set(staticTemplates.map((t) => t.id))
      const merged: DocumentTemplate[] = [
        ...staticTemplates,
        ...dbRows.filter((r) => !staticIds.has(r.id)).map(dbToTemplate),
      ]
      all.value = merged
    } finally {
      isLoading.value = false
    }
  }

  // Don't auto-fetch on every component mount — call refresh() at the
  // top of pages that need DB templates.
  if (!dbTemplatesLoaded.value && !dbTemplatesInflight) refresh()
  else {
    // Already cached — sync immediately.
    const staticIds = new Set(staticTemplates.map((t) => t.id))
    all.value = [
      ...staticTemplates,
      ...dbTemplatesCache.value.filter((r) => !staticIds.has(r.id)).map(dbToTemplate),
    ]
  }

  function findById(id: string | null | undefined): DocumentTemplate | null {
    if (!id) return null
    return all.value.find((t) => t.id === id) ?? null
  }

  return {
    templates: computed(() => all.value),
    isLoading,
    refresh,
    findById,
  }
}

/** Drop the cache. Call after admin saves a template so callers see the
 *  fresh list on next refresh. */
export function clearTemplateCache() {
  dbTemplatesCache.value = []
  dbTemplatesLoaded.value = false
  dbTemplatesInflight = null
}
