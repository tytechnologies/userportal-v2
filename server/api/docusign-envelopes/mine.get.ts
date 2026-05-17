// "Active envelopes I sent" â€” every docusign_envelopes row where
// sent_by = caller and status is still in-flight (sent / delivered).
//
// Excludes terminal statuses (completed / voided / expired / declined)
// because the dashboard surface is for "what am I waiting on"; closed
// envelopes live in the per-draft EsignEnvelopesPanel for history.
//
// GET /api/docusign-envelopes/mine?limit=50

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (supabase as any)
      .from('docusign_envelopes')
      .select(`
        id, draft_id, envelope_id, status, recipients,
        sent_at, webhook_received_at,
        draft:document_drafts (id, title, doc_type_key)
      `)
      .eq('sent_by', user.id)
      .in('status', ['sent', 'delivered'])
      .order('sent_at', { ascending: false })
      .limit(q.limit)
    if (error) {
      logger.error({ err: error.message, op: 'docusign.envelopes.mine' }, 'docusign_mine_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    // Project-out envelopes whose parent draft the caller can't see
    // (RLS returned null). Defends against orphaned envelopes from
    // a deleted draft.
    const visible = (data ?? []).filter((r: any) => r.draft)
    return { data: visible }
  },
})
