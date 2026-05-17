import type { H3Event } from 'h3'
import { logger } from './logger'

// Lazy import of the Nuxt virtual Supabase helper so this module
// can be loaded by vitest's module graph without a hard dependency on
// the Nuxt runtime resolver. The `@vite-ignore` comment defeats Vite's
// static import-analysis (which can't resolve the virtual specifier)
// — at runtime Nuxt provides the module normally.
async function getServerSupabaseClient(event: H3Event): Promise<SupabaseLike> {
  const specifier = '#supabase/server/serverSupabaseClient'
  const mod = await import(/* @vite-ignore */ specifier)
  return mod.serverSupabaseClient(event)
}

// Loose client type — the @supabase/supabase-js types aren't visible to
// the server tsconfig (same pattern as refresh-listing-details.ts).
// `any` keeps the call sites in listings.repo.ts (which DO see the real
// SupabaseClient types) compatible without introducing a broken
// structural alias.
export type SupabaseLike = any

// Audit logger. Calls the public.log_activity() RPC, which stamps user_id
// from auth.uid() server-side — callers cannot forge actor identity.
//
// Failure policy: audit logging is best-effort. A 5xx in log_activity must
// NOT bubble up and revert the user's actual write. Any failure is logged
// to pino with a stable code so it shows up in observability.

export type AuditEntity =
  | 'listing'
  | 'contact'
  | 'document'
  | 'task'
  | 'deal'
  | 'viewing'
  | 'commission'
  | 'note'
  | 'inquiry'
  | 'verification'
  | 'review'
  | 'building'

// Dotted entity.verb format. The frontend EVENT_CONFIG keys off these
// strings; keep the prefix matching `entity` so a missing config entry
// can fall back to a generic "<entity>: <verb>" label.
export type AuditAction =
  // listings
  | 'listing.created'
  | 'listing.updated'
  | 'listing.archived'
  | 'listing.unarchived'
  | 'listing.cloned'
  | 'listing.soft_deleted'
  | 'listing.remarks_updated'
  | 'listing.ingested'
  | 'listing.legacy_reconciled'
  // Collaboration network (migration 20260507000015)
  | 'listing.shared'
  | 'listing.share_accepted'
  | 'listing.share_revoked'
  | 'listing.share_expired'
  | 'listing.share_updated'
  | 'listing.duplicated'
  | 'inquiry.forwarded'
  // contacts
  | 'contact.created'
  | 'contact.updated'
  | 'contact.deleted'
  // documents
  | 'document.uploaded'
  | 'document.deleted'
  // tasks
  | 'task.created'
  | 'task.updated'
  | 'task.deleted'
  // notes
  | 'note.created'
  | 'note.updated'
  | 'note.deleted'
  // inquiries
  | 'inquiry.updated'
  // verifications
  | 'verification.submitted'
  | 'verification.approved'
  | 'verification.rejected'
  // listing / building verification (mig 20260507000018)
  | 'verification.listing_submitted'
  | 'verification.listing_approved'
  | 'verification.listing_rejected'
  | 'verification.building_submitted'
  | 'verification.building_approved'
  | 'verification.building_rejected'
  // reviews (mig 20260507000018)
  | 'review.created'
  | 'review.updated'
  | 'review.hidden'
  | 'review.unhidden'
  | 'review.reported'
  // deals + viewings + commissions (mig 20260507000021)
  | 'deal.created'
  | 'deal.stage_changed'
  | 'deal.participant_added'
  | 'deal.participant_removed'
  | 'deal.closed_won'
  | 'deal.closed_lost'
  | 'deal.reopened'
  | 'viewing.scheduled'
  | 'viewing.completed'
  | 'viewing.cancelled'
  | 'viewing.no_show'
  | 'commission.created'
  | 'commission.updated'
  | 'commission.paid'
  // broadcasts
  | 'broadcast.sent'
  // webhooks
  | 'webhook.subscribed'
  | 'webhook.delivered'
  | 'webhook.failed'
  // open-ended; new entities can extend AuditAction without breaking callers.
  | (string & {})

type LogArgs = {
  /** Event from h3; used to derive the request-scoped supabase client. */
  event: H3Event
  /** Pre-built supabase client (skips serverSupabaseClient() cost). Optional. */
  client?: SupabaseLike
  action: AuditAction
  entity: AuditEntity
  /** UUID-shaped entity id. Pass null for bigint-keyed entities like listings. */
  entityId?: string | null
  /**
   * Free-form payload. For bigint-keyed entities, stash the key here as
   * `listing_id` (or equivalent). Avoid PII; this is queryable via GIN.
   */
  metadata?: Record<string, unknown>
}

export async function logActivity(args: LogArgs): Promise<void> {
  const { event, action, entity, entityId = null, metadata = {} } = args
  try {
    const client: SupabaseLike = args.client ?? (await getServerSupabaseClient(event))
    const { error } = await client.rpc('log_activity', {
      p_action: action,
      p_entity: entity,
      p_entity_id: entityId,
      p_metadata: metadata,
    })
    if (error) {
      // RPC error: capture but never re-throw. The user's actual write
      // already succeeded; failing the response on a logging error would
      // be worse than losing one audit row.
      logger.warn(
        { err: error.message, action, entity, entityId },
        'audit_log_rpc_failed',
      )
    }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, action, entity, entityId },
      'audit_log_threw',
    )
  }
}
