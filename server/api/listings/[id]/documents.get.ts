// All documents linked to a listing — drafts + generated artifacts +
// saved tax computations.
//
// Returns a unified list sorted newest-first. Each row is one of three
// flavors, distinguished by `kind`:
//
//   { kind: 'draft', id, title, status, template_id, contact_id,
//     created_at, updated_at, owner_user_id, owner }
//   { kind: 'generated', id, file_name, document_type, file_format,
//     created_at, contact_id, signed_url, creator }
//   { kind: 'tax', id, title, taxpayer_type, computation_kind,
//     contact_id, created_at, updated_at, owner }
//
// Visibility: enforced by RLS on each underlying table. The caller
// gets:
//   - their own document_drafts for this listing
//   - their own `documents` rows for this listing
//   - every viewing_list `documents` row for this listing (the new
//     team-wide policy from migration 20260502000013)
//   - their own tax_computations for this listing (own/team/all per
//     their tax_computations.read.* permissions)
// plus any rows their permissions extend to (manager.team / admin.all).
//
// The signed-URL minting for generated docs uses the canonical 1-hour
// helper. Drafts and tax records don't get a signed URL here — the
// editor opens via /document-drafts/[id] / a future tax viewer.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedUrlForS3Key } from '~~/server/utils/s3-signed-url'
import { assertCanReadListing } from '~~/server/utils/images-auth'
import { logger } from '~~/server/utils/logger'

type DraftRow = {
  id: string
  title: string | null
  status: string | null
  template_id: string | null
  contact_id: number | null
  created_at: string
  updated_at: string
  owner_user_id: string
  owner: { id: string; full_name: string | null } | null
}

type GeneratedRow = {
  id: string
  file_name: string | null
  document_type: string | null
  file_format: string | null
  s3_key: string | null
  contact_id: number | null
  created_at: string
  created_by: string | null
}

type Creator = { id: string; full_name: string | null }

type TaxRow = {
  id: string
  title: string | null
  taxpayer_type: string
  computation_kind: string
  contact_id: number | null
  created_at: string
  updated_at: string
  owner_user_id: string
  owner: { id: string; full_name: string | null } | null
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    // Path-traversal-safe: returns the validated bigint; throws 404 if
    // the caller can't see the listing (RLS) or it doesn't exist.
    const listingId = await assertCanReadListing(event, getRouterParam(event, 'id'))

    const supabase = await serverSupabaseClient(event)

    // All three reads run in parallel — independent tables.
    const [draftsRes, generatedRes, taxRes] = await Promise.all([
      (supabase as any)
        .from('document_drafts')
        .select(
          'id, title, status, template_id, contact_id, created_at, updated_at, owner_user_id, ' +
          'owner:profiles!owner_user_id (id, full_name)',
        )
        .eq('listing_id', listingId)
        .order('updated_at', { ascending: false }),
      // Creator embed has to be a manual join — documents.created_by
      // FKs to auth.users(id), not profiles(id), so the PostgREST
      // `creator:profiles!created_by(...)` embed 500s with "relationship
      // not found". Same fix as /api/deals/:id/documents and
      // /api/documents/viewing-lists.
      (supabase as any)
        .from('documents')
        .select('id, file_name, document_type, file_format, s3_key, contact_id, created_at, created_by')
        .eq('listing_id', listingId)
        .order('created_at', { ascending: false }),
      (supabase as any)
        .from('tax_computations')
        .select(
          'id, title, taxpayer_type, computation_kind, contact_id, created_at, updated_at, owner_user_id, ' +
          'owner:profiles!owner_user_id (id, full_name)',
        )
        .eq('listing_id', listingId)
        .order('created_at', { ascending: false }),
    ])

    if (draftsRes.error) {
      logger.error(
        { err: draftsRes.error.message, listingId, op: 'listings.documents.drafts' },
        'listing_documents_drafts_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Failed to load drafts' })
    }
    if (generatedRes.error) {
      logger.error(
        { err: generatedRes.error.message, listingId, op: 'listings.documents.generated' },
        'listing_documents_generated_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Failed to load generated documents' })
    }
    // Tax read is non-fatal — if the table doesn't exist yet (migration
    // not applied) or RLS blocks, surface the rest without crashing.
    if (taxRes.error) {
      logger.warn(
        { err: taxRes.error.message, listingId, op: 'listings.documents.tax' },
        'listing_documents_tax_failed',
      )
    }

    // Batched creator lookup. See note above the generatedRes query —
    // we collect created_by uuids and resolve profiles in one shot
    // rather than embedding (the embed targets the wrong FK and 500s).
    const generatedRows = (generatedRes.data ?? []) as GeneratedRow[]
    const creatorIds = Array.from(
      new Set(generatedRows.map((r) => r.created_by).filter((id): id is string => !!id)),
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

    // Sign generated-doc URLs server-side. Failures fall back to empty
    // string — the row still surfaces, just without a download link.
    const generated = await Promise.all(
      generatedRows.map(async (row) => ({
        kind: 'generated' as const,
        id: row.id,
        file_name: row.file_name ?? '',
        document_type: row.document_type ?? null,
        file_format: row.file_format ?? null,
        contact_id: row.contact_id ?? null,
        created_at: row.created_at,
        signed_url: row.s3_key
          ? await getSignedUrlForS3Key(row.s3_key).catch(() => '')
          : '',
        creator: row.created_by ? creatorById.get(row.created_by) ?? null : null,
      })),
    )

    const drafts = ((draftsRes.data ?? []) as DraftRow[]).map((row) => ({
      kind: 'draft' as const,
      id: row.id,
      title: row.title ?? null,
      status: row.status ?? 'draft',
      template_id: row.template_id ?? null,
      contact_id: row.contact_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      owner_user_id: row.owner_user_id,
      owner: row.owner ?? null,
    }))

    const taxRecords = ((taxRes.error ? [] : taxRes.data ?? []) as TaxRow[]).map((row) => ({
      kind: 'tax' as const,
      id: row.id,
      title: row.title ?? null,
      taxpayer_type: row.taxpayer_type,
      computation_kind: row.computation_kind,
      contact_id: row.contact_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      owner_user_id: row.owner_user_id,
      owner: row.owner ?? null,
    }))

    // Single timeline-style merge, newest first. Drafts + tax records
    // sort by updated_at (in-progress / editable); generated docs sort
    // by created_at (immutable artifacts).
    const merged = [
      ...drafts.map((d) => ({ ...d, _sort: d.updated_at })),
      ...generated.map((g) => ({ ...g, _sort: g.created_at })),
      ...taxRecords.map((t) => ({ ...t, _sort: t.updated_at })),
    ]
      .sort((a, b) => (a._sort < b._sort ? 1 : a._sort > b._sort ? -1 : 0))
      .map(({ _sort, ...rest }) => rest)

    return {
      listing_id: listingId,
      total: merged.length,
      data: merged,
    }
  },
})
