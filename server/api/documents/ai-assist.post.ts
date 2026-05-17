// AI paralegal assistant â€” STRUCTURED operations only.
//
// POST /api/documents/ai-assist
// Body:
//   {
//     operation: 'explain' | 'summarize' | 'detect_missing'
//              | 'rewrite_with_clause' | 'translate_tagalog'
//              | 'compare_revisions',
//     text?: string,                  // operation-specific input
//     other_text?: string,            // 'compare_revisions' second side
//     clause_id?: string,             // 'rewrite_with_clause' anchor
//     doc_type_key?: string,          // 'detect_missing' context
//   }
//
// Why a separate endpoint from /document-drafts/generate-ai:
//   - generate-ai *creates* a freeform draft. That's risky if used
//     for legal output without review â€” we limit it to brokers who
//     opted in via the wizard's Generate mode and label outputs
//     "AI-generated, review carefully."
//   - ai-assist NEVER creates new clauses or persists the result.
//     It's a transient explanation surface. The output is text the
//     UI displays alongside the broker's own work. Nothing about the
//     legal document changes server-side.
//
// Boundaries enforced by this endpoint:
//   1. operation enum is closed â€” no escape hatch for arbitrary
//      prompts. Each branch wraps the user input in a fixed system
//      prompt that constrains the AI to its role.
//   2. 'rewrite_with_clause' is the only mode that produces draft
//      content, and it ONLY substitutes from the approved
//      clause_library â€” never invents new clause text.
//   3. AI never sees the platform API key directly; the server
//      proxies via the platform_settings.ai_generation config.
//   4. Outputs are returned as text with role: 'assistant' framing.
//      The client renders them as quotes / suggestions, not as
//      authoritative legal copy.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { serverSupabaseServiceRole } from '#supabase/server/serverSupabaseServiceRole'
import { logger } from '~~/server/utils/logger'
import { requireRole } from '~~/server/utils/rbac'

const bodySchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('explain'),
    text: z.string().trim().min(20).max(20_000),
  }),
  z.object({
    operation: z.literal('summarize'),
    text: z.string().trim().min(50).max(50_000),
  }),
  z.object({
    operation: z.literal('detect_missing'),
    text: z.string().trim().min(50).max(50_000),
    doc_type_key: z.string().min(1).max(80),
  }),
  z.object({
    operation: z.literal('rewrite_with_clause'),
    clause_id: z.string().uuid(),
    text: z.string().trim().min(20).max(20_000),
  }),
  z.object({
    operation: z.literal('translate_tagalog'),
    text: z.string().trim().min(10).max(20_000),
  }),
  z.object({
    operation: z.literal('compare_revisions'),
    text: z.string().trim().min(50).max(50_000),
    other_text: z.string().trim().min(50).max(50_000),
  }),
])

type AiConfig = {
  endpoint?: string
  api_key?: string
  model?: string
  header_style?: 'bearer' | 'anthropic'
}

// Per-operation system prompt + user-message builder. Each branch is
// intentionally narrow â€” the model is given a single job and the
// shape of expected output. Because Phase 1 doesn't yet ship a
// rich-output JSON schema, all branches return plain text framed
// as the AI's response.
const OPERATION_SYSTEMS: Record<string, string> = {
  explain:
    'You are a paralegal assistant. Explain the supplied clause or paragraph in clear, plain English to a real estate broker. Be concrete about who is bound and what they have to do. Do NOT add legal advice; if the clause is ambiguous, say so. â‰¤180 words.',
  summarize:
    'You are a paralegal assistant. Produce a tight bullet summary of the supplied document â€” parties, key obligations, dates, money amounts, terminations, signatures required. Plain English. â‰¤300 words.',
  detect_missing:
    'You are a paralegal assistant for Philippine real estate. Compare the supplied document text against what the document type typically requires (parties, dates, amounts, attachments, witnesses, notary block). List ONLY what appears MISSING or UNCLEAR, as a short bulleted list. Do NOT propose new clauses; do NOT rewrite. â‰¤200 words.',
  rewrite_with_clause:
    'You are a paralegal assistant. The user has selected a clause from the firm\'s APPROVED clause library and wants to splice it into their document. Output the user\'s document text with the approved clause inserted at the most logical location â€” preserve all other text exactly. Mark the inserted clause with â–¶ and â—€ delimiters so the broker can visually confirm placement.',
  translate_tagalog:
    'You are a paralegal assistant. Translate the supplied English document text to clear, formal Tagalog suitable for a Philippine real estate context. Preserve names, dates, and money amounts unchanged. Return ONLY the translation.',
  compare_revisions:
    'You are a paralegal assistant. Compare two versions of a document. Output a bullet list of MEANINGFUL changes only â€” added/removed parties, changed dates, changed amounts, changed obligations. Skip whitespace, formatting, and synonym swaps. â‰¤200 words.',
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'agent')
    const user = await serverSupabaseUser(event)

    // Read AI config (service role â€” bypass RLS).
    //
    // Wrapped in try/catch because serverSupabaseServiceRole() throws
    // synchronously when SUPABASE_SERVICE_KEY isn't in .env (common
    // first-run state on a fresh deploy). Surface that as the same
    // 503 ai_not_configured shape the wizard already handles, so the
    // broker sees a clean "configure now â†’" CTA instead of an opaque
    // 500.
    let cfg: AiConfig = {} as AiConfig
    try {
      const sr = serverSupabaseServiceRole(event) as any
      const { data: cfgRow, error: cfgErr } = await sr
        .from('platform_settings')
        .select('value')
        .eq('key', 'ai_generation')
        .maybeSingle()
      if (cfgErr) {
        logger.error({ err: cfgErr.message, op: 'ai_assist.config' }, 'ai_assist_config_failed')
        throw createError({ statusCode: 500, statusMessage: 'AI config read failed' })
      }
      cfg = (cfgRow?.value ?? {}) as AiConfig
    } catch (err: any) {
      const msg = err?.message || ''
      if (msg.includes('SUPABASE_SERVICE_KEY')) {
        // Treat env-misconfig as the same "not configured" branch.
        // Distinct error-code so the admin UI can surface a slightly
        // different fix hint.
        logger.warn({ op: 'ai_assist.config' }, 'ai_assist_service_key_missing')
        throw createError({
          statusCode: 503,
          statusMessage: 'AI assistant is not configured (server SUPABASE_SERVICE_KEY missing)',
          data: { code: 'ai_not_configured', admin_path: '/admin/ai-settings', missing: 'SUPABASE_SERVICE_KEY' },
        })
      }
      if (err?.statusCode) throw err
      logger.error({ err: msg, op: 'ai_assist.config' }, 'ai_assist_config_failed')
      throw createError({ statusCode: 500, statusMessage: 'AI config read failed' })
    }
    if (!cfg.endpoint || !cfg.api_key) {
      throw createError({
        statusCode: 503,
        statusMessage: 'AI assistant is not configured',
        data: { code: 'ai_not_configured', admin_path: '/admin/ai-settings' },
      })
    }

    // Build the user-side message per operation. rewrite_with_clause
    // is special: we look up the approved clause from the library and
    // hand its body to the model â€” never letting the broker pass
    // arbitrary "rewrite this with X" content.
    let userMessage: string
    const supabase = await serverSupabaseClient(event)

    if (body.operation === 'rewrite_with_clause') {
      const { data: clause, error: clauseErr } = await (supabase as any)
        .from('clause_library')
        .select('id, title, body, status')
        .eq('id', body.clause_id)
        .maybeSingle()
      if (clauseErr) {
        throw createError({ statusCode: 500, statusMessage: clauseErr.message })
      }
      if (!clause) {
        throw createError({ statusCode: 404, statusMessage: 'Clause not found' })
      }
      if (clause.status !== 'approved') {
        throw createError({
          statusCode: 422,
          statusMessage: `Clause "${clause.title}" is not approved for use yet.`,
        })
      }
      userMessage = [
        'Approved clause to insert (titled "' + clause.title + '"):',
        '---',
        clause.body,
        '---',
        '',
        'Existing document text:',
        '---',
        body.text,
        '---',
      ].join('\n')
    } else if (body.operation === 'compare_revisions') {
      userMessage = [
        'Version A:',
        '---',
        body.text,
        '---',
        '',
        'Version B:',
        '---',
        body.other_text,
        '---',
      ].join('\n')
    } else if (body.operation === 'detect_missing') {
      userMessage = [
        'Document type: ' + body.doc_type_key,
        '',
        'Document text:',
        '---',
        body.text,
        '---',
      ].join('\n')
    } else {
      userMessage = body.text
    }

    const systemPrompt = OPERATION_SYSTEMS[body.operation]
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (cfg.header_style === 'anthropic') {
      headers['x-api-key'] = cfg.api_key
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['authorization'] = `Bearer ${cfg.api_key}`
    }

    const requestBody = {
      model: cfg.model || 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }

    let aiText = ''
    try {
      const ctrl = new AbortController()
      const timeout = setTimeout(() => ctrl.abort(), 30_000)
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: ctrl.signal,
      })
      clearTimeout(timeout)
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        logger.error(
          { status: res.status, body: txt.slice(0, 500), op: 'ai_assist.upstream' },
          'ai_assist_upstream_error',
        )
        throw createError({
          statusCode: 502,
          statusMessage: `AI provider returned ${res.status}`,
        })
      }
      const json: any = await res.json()
      aiText =
        json?.content?.[0]?.text ??
        json?.choices?.[0]?.message?.content ??
        ''
    } catch (err: any) {
      if (err?.statusCode) throw err
      logger.error({ err: err?.message, op: 'ai_assist.fetch' }, 'ai_assist_fetch_failed')
      throw createError({
        statusCode: 502,
        statusMessage: err?.name === 'AbortError'
          ? 'AI provider timed out (30s)'
          : 'AI provider request failed',
      })
    }

    if (!aiText.trim()) {
      throw createError({
        statusCode: 502,
        statusMessage: 'AI provider returned an empty response',
      })
    }

    return {
      operation: body.operation,
      output: aiText.trim(),
      // Surface a clear "this is AI output" flag the UI can use to
      // render a "review carefully â€” AI-generated" banner. This is
      // the most important thing the client can do with this
      // response: never present it as authoritative legal text.
      ai_generated: true,
    }
  },
})
