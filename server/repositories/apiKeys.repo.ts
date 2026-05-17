// API keys repository â€” owner-scoped CRUD for /api/organizations/:id/api-keys.
//
// Reads: SELECT through RLS (brokerage_owner of the org or
// api_keys.manage.platform).
// Writes: via SECURITY DEFINER RPCs (api_key_generate, api_key_revoke).
// Rotate = generate new + revoke old, both atomic at the API layer.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export type ApiKeyCreateInput = {
  name: string
  scopes: string[]
  kind?: 'live' | 'test' | 'restricted'
  expires_at?: string | null
  rate_limit_per_minute?: number
}

const KEY_SELECT =
  'id, organization_id, name, prefix, last4, kind, scopes, status, ' +
  'last_used_at, expires_at, rate_limit_per_minute, created_by, ' +
  'revoked_at, revoked_by, revoke_reason, metadata, created_at, updated_at'

export const apiKeysRepo = {
  async list({
    event,
    organizationId,
  }: {
    event: H3Event
    organizationId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('api_keys')
      .select(KEY_SELECT)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
    if (error) {
      logger.error(
        { err: error.message, op: 'apiKeys.list', organizationId },
        'api_keys_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async create({
    event,
    organizationId,
    input,
  }: {
    event: H3Event
    organizationId: string
    input: ApiKeyCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any).rpc('api_key_generate', {
      p_name: input.name,
      p_organization_id: organizationId,
      p_scopes: input.scopes,
      p_kind: input.kind ?? 'live',
      p_expires_at: input.expires_at ?? null,
      p_rate_limit_per_minute: input.rate_limit_per_minute ?? 60,
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'apiKeys.create', organizationId },
        'api_keys_create_failed',
      )
      const code = (error as any).code
      const msg = error.message ?? ''
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: msg || 'Permission denied' })
      }
      if (msg.includes('invalid') || msg.includes('disabled')) {
        throw createError({ statusCode: 400, statusMessage: msg })
      }
      throw createError({ statusCode: 500, statusMessage: msg || 'Create failed' })
    }

    logActivity({
      event,
      action: 'api_key.created',
      entity: 'document',
      entityId: null,
      metadata: {
        organization_id: organizationId,
        api_key_id: data?.id,
        kind: data?.kind,
        scope_count: input.scopes.length,
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'api_keys_create_activity_log_failed',
      )
    })

    // data shape: { id, key_value, prefix, last4, kind }
    // The key_value is returned ONCE â€” caller must capture.
    return data
  },

  async revoke({
    event,
    organizationId,
    keyId,
    reason,
  }: {
    event: H3Event
    organizationId: string
    keyId: string
    reason: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('api_key_revoke', {
      p_key_id: keyId,
      p_reason: reason,
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'apiKeys.revoke', keyId },
        'api_keys_revoke_failed',
      )
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      if (code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: 'API key not found' })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'api_key.revoked',
      entity: 'document',
      entityId: null,
      metadata: { organization_id: organizationId, api_key_id: keyId, reason },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'api_keys_revoke_activity_log_failed',
      )
    })

    return { ok: true, api_key_id: data }
  },

  async rotate({
    event,
    organizationId,
    keyId,
  }: {
    event: H3Event
    organizationId: string
    keyId: string
  }) {
    const client = await serverSupabaseClient(event)

    // Look up the existing key (need name + scopes + kind to clone).
    const { data: existing, error: lookupErr } = await (client as any)
      .from('api_keys')
      .select('id, name, organization_id, scopes, kind, expires_at, rate_limit_per_minute')
      .eq('id', keyId)
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (lookupErr) {
      throw createError({ statusCode: 500, statusMessage: lookupErr.message })
    }
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'API key not found' })
    }

    // Generate the new key with the same shape.
    const created = await this.create({
      event,
      organizationId,
      input: {
        name: existing.name + ' (rotated)',
        scopes: existing.scopes,
        kind: existing.kind,
        expires_at: existing.expires_at,
        rate_limit_per_minute: existing.rate_limit_per_minute,
      },
    })

    // Revoke the old one.
    await this.revoke({
      event,
      organizationId,
      keyId,
      reason: `rotated to ${created.id}`,
    })

    // Stamp 'rotated' on the audit log of the new key for traceability.
    await (client as any)
      .from('api_key_audit_events')
      .insert({
        api_key_id: created.id,
        event_kind: 'rotated',
        actor_user_id: (await serverSupabaseUser(event))?.id ?? null,
        metadata: { rotated_from: keyId },
      })
      .then(() => undefined)
      .catch((err: any) => {
        logger.warn(
          { err: err?.message, op: 'apiKeys.rotate.audit' },
          'api_keys_rotate_audit_failed',
        )
      })

    return created
  },
}
