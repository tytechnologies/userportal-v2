// Deal-scoped documents.
//
// GET /api/deals/:id/documents
// Auth: required. RLS on `documents` already gates by the via-deal
// branch (mig 20260507000022) — caller must participate in the deal
// to read.
//
// NOTE on the creator lookup:
//   `documents.created_by` is FK'd to auth.users(id) (mig 20250129000000),
//   not public.profiles(id). PostgREST embedding via
//   `creator:profiles!created_by(...)` therefore can't resolve the
//   relationship and 500s the whole endpoint. We do the join in two
//   queries instead — cheap because the per-deal document count is
//   typically <50, and the second query is a single .in() on a UUID
//   primary key. profiles.id == auth.users.id (1:1 mirror), so this
//   produces the same {id, full_name} payload the UI expected.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedUrlForS3Key } from '~~/server/utils/s3-signed-url'

type Creator = { id: string; full_name: string | null }

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const dealId = getRouterParam(event, 'id')
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('documents')
      .select(
        'id, file_name, document_type, file_format, s3_key, created_at, created_by',
      )
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const rows = (data ?? []) as Array<{
      id: string
      file_name: string | null
      document_type: string | null
      file_format: string | null
      s3_key: string | null
      created_at: string
      created_by: string | null
    }>

    // Resolve creator names via a single batched lookup against
    // public.profiles. RLS on profiles already gates by visibility;
    // anything the caller can't see comes back missing and we render
    // the row with creator=null.
    const creatorIds = Array.from(
      new Set(rows.map((r) => r.created_by).filter((id): id is string => !!id)),
    )
    const creatorById = new Map<string, Creator>()
    if (creatorIds.length > 0) {
      const { data: profiles } = await (supabase as any)
        .from('profiles')
        .select('id, full_name')
        .in('id', creatorIds)
      for (const p of (profiles ?? []) as Creator[]) {
        if (p?.id) creatorById.set(p.id, p)
      }
    }

    // Sign URLs server-side; failure falls back to empty string so
    // the row still renders without a download link.
    const docs = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        file_name: row.file_name ?? '',
        document_type: row.document_type ?? null,
        file_format: row.file_format ?? null,
        created_at: row.created_at,
        creator: row.created_by ? creatorById.get(row.created_by) ?? null : null,
        signed_url: row.s3_key
          ? await getSignedUrlForS3Key(row.s3_key).catch(() => '')
          : '',
      })),
    )

    return { deal_id: dealId, total: docs.length, data: docs }
  },
})
