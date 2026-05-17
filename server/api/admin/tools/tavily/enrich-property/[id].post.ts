// Admin — Tavily: enrich a property record with neighborhood / building info.
//
// POST /api/admin/tools/tavily/enrich-property/:id
// Body: {}  (no body — property id resolves from the route)
//
// Runs a Tavily search keyed on the property's name + city. Stores
// the result into properties.attributes.tavily_enrichment (jsonb).
// Does NOT modify any other property field — admin curation
// reviews the enrichment and decides what to backfill explicitly.

import { z as _z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { isTavilyEnabled, tavilySearch, consumeTavilyBudget } from '~~/server/utils/tavily'

const DAILY_MAX = 100

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const propertyId = Number(getRouterParam(event, 'id') || '0')
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid property id' })
    }

    if (!isTavilyEnabled()) {
      throw createError({
        statusCode: 503,
        statusMessage: 'Tavily not configured — set TAVILY_API_KEY env var',
      })
    }

    const supabase = await serverSupabaseClient(event)

    const { data: prop, error: pErr } = await (supabase as any)
      .from('properties')
      .select('id, name, street_address, city_id, attributes')
      .eq('id', propertyId)
      .maybeSingle()
    if (pErr) throw createError({ statusCode: 500, statusMessage: pErr.message })
    if (!prop) throw createError({ statusCode: 404, statusMessage: 'Property not found' })

    const { data: city } = prop.city_id
      ? await (supabase as any)
          .from('cities')
          .select('name')
          .eq('id', prop.city_id)
          .maybeSingle()
      : { data: null }

    const query = [prop.name, prop.street_address, city?.name, 'real estate']
      .filter(Boolean)
      .join(' ')
    if (query.length < 4) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Property has insufficient identifying info for a Tavily query',
      })
    }

    const allowed = await consumeTavilyBudget(supabase, 'enrichment', DAILY_MAX)
    if (!allowed) {
      throw createError({
        statusCode: 429,
        statusMessage: `Daily Tavily enrichment budget exhausted (${DAILY_MAX}/day).`,
      })
    }

    let enrichment: unknown
    try {
      enrichment = await tavilySearch({ query, max_results: 5, search_depth: 'basic' })
    } catch (err: any) {
      throw createError({ statusCode: 502, statusMessage: err?.message || 'tavily error' })
    }

    // Merge into attributes.tavily_enrichment — never overwrite typed
    // columns. The whole result lands as a sub-object for review.
    const attrs = (prop.attributes && typeof prop.attributes === 'object') ? prop.attributes : {}
    const newAttrs = {
      ...attrs,
      tavily_enrichment: {
        query,
        fetched_at: new Date().toISOString(),
        response: enrichment,
      },
    }

    const { error: updErr } = await (supabase as any)
      .from('properties')
      .update({ attributes: newAttrs, updated_at: new Date().toISOString() })
      .eq('id', propertyId)
    if (updErr) throw createError({ statusCode: 500, statusMessage: updErr.message })

    return { ok: true, property_id: propertyId, query }
  },
})
