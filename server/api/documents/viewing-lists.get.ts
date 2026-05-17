import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedUrlForS3Key } from '~~/server/utils/s3-signed-url'
import { logger } from '~~/server/utils/logger'

/**
 * List viewing lists across the team.
 *
 * Viewing lists are an institutional historical record — every broker
 * should be able to look up what's been shown to which client by which
 * colleague. RLS gates this via the new `documents_viewing_list_select_open`
 * policy + `viewing_lists.read.all` permission (default-on for every role,
 * see migration 20260502000013). Other document types (LOI, contracts,
 * tax reports) remain creator-scoped via the original "Users can view
 * own documents" policy.
 *
 * Creator lookup runs as a second batched query, NOT a PostgREST embed.
 * `documents.created_by` FKs to `auth.users(id)` (mig 20250129000000),
 * not `public.profiles(id)`, so `creator:profiles!created_by(...)`
 * 500s the whole endpoint with "relationship not found". profiles.id
 * mirrors auth.users.id 1:1, so the manual .in() lookup produces the
 * same payload the UI expects.
 *
 * Returns:
 *   { id, documentName, documentUrl, created_at, listing_id,
 *     contact_id, creator: { id, full_name, avatar_url } }[]
 */
type Creator = { id: string; full_name: string | null; avatar_url: string | null }

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const supabase = await serverSupabaseClient(event)
    const { data: rows, error } = await supabase
      .from('documents')
      .select('id, s3_key, file_name, created_at, listing_id, contact_id, created_by')
      .eq('document_type', 'viewing_list')
      .order('created_at', { ascending: false })

    if (error) {
      logger.error({ err: error.message, op: 'documents.viewing-lists' }, 'viewing_lists_failed')
      throw createError({ statusCode: 500, statusMessage: 'Failed to list viewing lists' })
    }

    const list = (rows ?? []) as Array<{
      id: string
      s3_key: string | null
      file_name: string | null
      created_at: string
      listing_id: number | null
      contact_id: number | null
      created_by: string | null
    }>

    const creatorIds = Array.from(
      new Set(list.map((r) => r.created_by).filter((id): id is string => !!id)),
    )
    const creatorById = new Map<string, Creator>()
    if (creatorIds.length > 0) {
      const { data: profiles } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', creatorIds)
      for (const p of (profiles ?? []) as Creator[]) {
        if (p?.id) creatorById.set(p.id, p)
      }
    }

    return Promise.all(
      list.map(async (row) => ({
        id: row.id,
        documentName: row.file_name ?? '',
        documentUrl: row.s3_key ? await getSignedUrlForS3Key(row.s3_key).catch(() => '') : '',
        created_at: row.created_at,
        listing_id: row.listing_id ?? null,
        contact_id: row.contact_id ?? null,
        creator: row.created_by ? creatorById.get(row.created_by) ?? null : null,
      })),
    )
  },
})
