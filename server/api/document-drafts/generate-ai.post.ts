// AI-assisted document generation. Powers the "Generate" option on
// the New Document wizard.
//
// POST /api/document-drafts/generate-ai
// Body:
//   {
//     prompt: string                  // broker-supplied free text
//     doc_type: 'lease'|'rental'|'sale'
//     listing_id?: number             // for context hydration
//     contact_id?: number             // for context hydration
//   }
//
// Reads the platform-wide AI config from platform_settings.ai_generation
// (set by a platform admin via /admin/ai-settings). The config carries
// `endpoint`, `api_key`, `model`, and an optional `provider` hint.
// Returns 503 with a clear "configure-it-first" payload when missing â€”
// the wizard surfaces that to the broker as a CTA, not a crash.
//
// Defense-in-depth:
//   1. Auth required + agent+ role gate.
//   2. Config read uses the service-role client to bypass RLS â€” brokers
//      can call this without read access to platform_settings.
//   3. Outbound request times out at 30s so a wedged provider doesn't
//      pin the function.
//   4. Returned content is wrapped, not echoed raw â€” the AI's text
//      lives in `data.ai_body` on the new draft, never injected into
//      a template's structured fields.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { serverSupabaseServiceRole } from '#supabase/server/serverSupabaseServiceRole'
import { logger } from '~~/server/utils/logger'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z.object({
  prompt: z.string().trim().min(10).max(4000),
  doc_type: z.enum(['lease', 'rental', 'sale']),
  listing_id: z.number().int().positive().nullable().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
})

type AiConfig = {
  /** Free-text label so the admin can spot which row this is in the UI. */
  provider?: string
  /** Required. Full URL the server posts to. */
  endpoint?: string
  /** Optional. Sent as the Bearer token (or x-api-key â€” see header_style).
   *  Local LLM gateways like Ollama don't require auth; leave blank. */
  api_key?: string
  /** Optional. Model name passed in the body. Defaults to a sensible
   *  value per body_style (claude-sonnet-4-6 for anthropic/openai;
   *  llama3 for ollama). */
  model?: string
  /**
   * Optional auth-header shape. Defaults to 'bearer'
   * (Authorization: Bearer â€¦). 'anthropic' sends the key as
   * `x-api-key` + `anthropic-version`. 'none' sends no auth header
   * at all (Ollama / local gateways).
   */
  header_style?: 'bearer' | 'anthropic' | 'none'
  /**
   * Optional request-body shape. Defaults to 'anthropic' which
   * mirrors Anthropic's /v1/messages and is also accepted by
   * OpenAI-compat shims (LiteLLM, OpenRouter). 'ollama' uses
   * Ollama's native /api/chat shape: { model, messages, stream:
   * false }.
   */
  body_style?: 'anthropic' | 'ollama'
  /** Optional system prompt prefix the admin can tune. */
  system_prompt?: string
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'agent')

    // ---- Resolve AI config -------------------------------------------
    // Two sources, in priority order:
    //
    //   1. Server env vars (AI_GENERATION_ENDPOINT, AI_GENERATION_API_KEY,
    //      AI_GENERATION_MODEL, AI_GENERATION_PROVIDER, AI_GENERATION_HEADER_STYLE,
    //      AI_GENERATION_SYSTEM_PROMPT). Fast path â€” no DB roundtrip,
    //      no service-role plumbing. The right answer for self-hosted
    //      setups where the operator manages config through `.env`.
    //
    //   2. platform_settings.ai_generation (admin UI on /admin/ai-settings).
    //      Only consulted when env vars are unset. Read via the
    //      service-role client because RLS gates platform_settings to
    //      admins; brokers don't have direct read access.
    //
    // Result: a broker calling the wizard's Generate option works as
    // long as EITHER the server admin set the env vars OR a platform
    // admin filled the admin form. The 503 only fires when both are
    // empty.
    let cfg: AiConfig = {
      provider:      process.env.AI_GENERATION_PROVIDER || undefined,
      endpoint:      process.env.AI_GENERATION_ENDPOINT || undefined,
      api_key:       process.env.AI_GENERATION_API_KEY  || undefined,
      model:         process.env.AI_GENERATION_MODEL    || undefined,
      header_style:  (process.env.AI_GENERATION_HEADER_STYLE as AiConfig['header_style']) || undefined,
      body_style:    (process.env.AI_GENERATION_BODY_STYLE as AiConfig['body_style']) || undefined,
      system_prompt: process.env.AI_GENERATION_SYSTEM_PROMPT || undefined,
    }

    // Env not enough? Try the admin-saved row in platform_settings.
    // This requires the service-role Supabase client (RLS gate).
    // Local-LLM setups (Ollama, LM Studio) don't have an api_key, so
    // we only fall back when the *endpoint* is missing â€” having
    // endpoint + no api_key is a valid Ollama config.
    if (!cfg.endpoint) {
      try {
        const sr = serverSupabaseServiceRole(event) as any
        const { data: cfgRow, error: cfgErr } = await sr
          .from('platform_settings')
          .select('value')
          .eq('key', 'ai_generation')
          .maybeSingle()
        if (cfgErr) {
          logger.error({ err: cfgErr.message, op: 'generate_ai.config_read' }, 'ai_config_read_failed')
          throw createError({ statusCode: 500, statusMessage: 'AI config read failed' })
        }
        const dbCfg = (cfgRow?.value ?? {}) as AiConfig
        // Merge: env wins for any field it provided, DB fills the rest.
        cfg = {
          provider:      cfg.provider      || dbCfg.provider,
          endpoint:      cfg.endpoint      || dbCfg.endpoint,
          api_key:       cfg.api_key       || dbCfg.api_key,
          model:         cfg.model         || dbCfg.model,
          header_style:  cfg.header_style  || dbCfg.header_style,
          body_style:    cfg.body_style    || dbCfg.body_style,
          system_prompt: cfg.system_prompt || dbCfg.system_prompt,
        }
      } catch (err: any) {
        const msg = err?.message || ''
        if (msg.includes('SUPABASE_SERVICE_KEY')) {
          // Both env-var-driven config AND service-role-driven DB read
          // are missing. Log a diagnostic so the operator knows BOTH
          // paths are unconfigured.
          logger.warn(
            {
              op: 'generate_ai.config_read',
              env_AI_GENERATION_ENDPOINT: process.env.AI_GENERATION_ENDPOINT ? 'present' : 'MISSING',
              env_AI_GENERATION_API_KEY:  process.env.AI_GENERATION_API_KEY ? `present (${process.env.AI_GENERATION_API_KEY.length} chars)` : 'MISSING',
              env_SUPABASE_SERVICE_KEY:   process.env.SUPABASE_SERVICE_KEY ? `present (${process.env.SUPABASE_SERVICE_KEY.length} chars)` : 'MISSING',
              env_SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? `present (${process.env.SUPABASE_SERVICE_ROLE_KEY.length} chars)` : 'MISSING',
              hint: 'Either set AI_GENERATION_ENDPOINT + AI_GENERATION_API_KEY in `.env` (recommended for self-hosted), or set SUPABASE_SERVICE_KEY so the server can read the admin-saved settings from the platform_settings table. Restart `pnpm dev` after editing.',
            },
            'ai_config_service_key_missing',
          )
          throw createError({
            statusCode: 503,
            statusMessage: 'AI generation is not configured. Set AI_GENERATION_ENDPOINT + AI_GENERATION_API_KEY in .env, or set SUPABASE_SERVICE_KEY to load admin-saved settings.',
            data: { code: 'ai_not_configured', admin_path: '/admin/ai-settings', missing: 'AI_GENERATION_ENDPOINT or SUPABASE_SERVICE_KEY' },
          })
        }
        if (err?.statusCode) throw err
        logger.error({ err: msg, op: 'generate_ai.config_read' }, 'ai_config_read_failed')
        throw createError({ statusCode: 500, statusMessage: 'AI config read failed' })
      }
    }

    if (!cfg.endpoint) {
      // No endpoint at all â€” neither env nor DB. Distinct 503 +
      // structured body so the wizard can render a "Configure AI"
      // CTA. (api_key is optional for local LLMs, so its absence
      // alone is not a config error.)
      throw createError({
        statusCode: 503,
        statusMessage: 'AI generation is not configured',
        data: { code: 'ai_not_configured', admin_path: '/admin/ai-settings' },
      })
    }

    // ---- Hydrate context (listing/contact) for the prompt ------------
    // The AI generation works much better when it sees the actual
    // names + addresses + prices it should weave into the document.
    // We pull a minimal slice through the user's session client so RLS
    // applies: a broker can only ground generation on entities they
    // can read.
    const supabase = await serverSupabaseClient(event)
    let listingCtx: Record<string, unknown> | null = null
    let contactCtx: Record<string, unknown> | null = null
    if (body.listing_id) {
      // Read from listing_details (the view that joins properties +
      // barangay names back onto the listing) so the AI prompt sees
      // the actual address strings â€” not just FK ids. The base
      // `listings` table doesn't have street_address/barangay columns
      // (they live on properties); selecting them off `listings`
      // silently returned undefined for the address lines and the
      // generation degraded.
      const { data } = await (supabase as any)
        .from('listing_details')
        .select('listing_id, title, sale_price, rent_price, street_address, barangay, bedrooms, bathrooms, floor_area, lot_area')
        .eq('listing_id', body.listing_id)
        .maybeSingle()
      listingCtx = data ?? null
    }
    if (body.contact_id) {
      const { data } = await (supabase as any)
        .from('contacts')
        .select('id, full_name, email, mobile_phone')
        .eq('id', body.contact_id)
        .maybeSingle()
      contactCtx = data ?? null
    }

    // ---- Build the request to the AI provider ------------------------
    // We tell the model to produce structured Markdown, not a wall of
    // plain text. The editor preview, the DOCX renderer, and the PDF
    // renderer all parse the same markdown shape (see app/utils/
    // aiMarkdown.ts) so the broker sees a properly formatted contract
    // â€” bold party labels, numbered clauses, signature block â€” rather
    // than a Notepad dump.
    const userPrompt = [
      `Generate a draft ${body.doc_type} document for a Philippine real estate transaction.`,
      '',
      'Output requirements (STRICT â€” the renderer parses this format):',
      '- Use Markdown structure throughout. NO code fences, NO ``` blocks, NO `[brackets]` placeholders.',
      '- Document title at the top as `# TITLE IN UPPERCASE` centered (the renderer centers H1 automatically).',
      '- Numbered legal sections as `## I. SECTION NAME` then prose paragraphs underneath (or `## 1. NAME` â€” pick one numbering style and stay consistent).',
      '- Sub-sections as `### Sub-section title`.',
      '- Use **bold** for party labels (BUYER:, SELLER:, LESSOR:, LESSEE:), defined terms on first appearance, and dollar/peso amounts when first introduced.',
      '- Use *italic* sparingly for legal terms of art (e.g. *force majeure*).',
      '- Use numbered lists (`1.`, `2.`) for enumerated obligations or itemized fees. Use bulleted lists (`- `) only for non-enumerated items.',
      '- Leave clear blanks for missing data using the format `__________` (underscores, ~10 chars wide). DO NOT make up names, amounts, dates, or addresses you weren\'t given.',
      '- End with a `## SIGNATURE PAGE` section listing each party on its own line: party label in **bold**, then a blank signature line, then printed name + role + date underneath. Example:',
      '  ```',
      '  **LESSOR**',
      '  __________________________',
      '  Name: __________',
      '  Date: __________',
      '  ```',
      '- After the signature block, append a `## WITNESSES` section with TWO witness slots (Witness 1, Witness 2), each with a blank signature line and a Printed name slot. Witnesses are required for every notarized PH instrument.',
      '- For documents requiring notarization, append `## ACKNOWLEDGMENT` on its own page after witnesses. Use the standard PH 2004 Rules on Notarial Practice block:',
      '  ```',
      '  REPUBLIC OF THE PHILIPPINES )',
      '  CITY/PROVINCE OF __________ ) S.S.',
      '  ',
      '  BEFORE ME, a Notary Public ... personally appeared ... acknowledged that the foregoing instrument is their free and voluntary act and deed.',
      '  ',
      '  This instrument, consisting of ____ page(s), refers to a real-estate transaction and has been signed by the parties and their witnesses on each and every page hereof.',
      '  ',
      '  WITNESS MY HAND AND SEAL on this ____ day of __________, 20____ at __________, Philippines.',
      '  ',
      '                                          __________________________',
      '                                                NOTARY PUBLIC',
      '  ',
      '  Doc. No. _____;',
      '  Page No. _____;',
      '  Book No. _____;',
      '  Series of 20___.',
      '  ```',
      '- Use formal Philippine legal English. Reference applicable PH laws when relevant (Civil Code articles, RA 9646 for real estate brokers, etc.).',
      '',
      `Broker instructions: ${body.prompt}`,
      listingCtx ? `\nListing context (JSON): ${JSON.stringify(listingCtx)}` : '',
      contactCtx ? `\nBuyer/tenant context (JSON): ${JSON.stringify(contactCtx)}` : '',
    ].filter(Boolean).join('\n')

    const systemPrompt = (cfg.system_prompt ?? '').trim() ||
      [
        'You are a paralegal assistant for a real estate brokerage in the Philippines.',
        'Produce complete, ready-to-edit legal document bodies in Markdown that follow Philippine real-estate practice.',
        'Never invent specific names, amounts, dates, or addresses â€” leave blanks (__________) where data was not provided.',
        'Never wrap your output in markdown code fences. Never explain what you generated. Output only the document body.',
        'Use formal but readable Philippine legal English; reference applicable laws (Civil Code, RA 9646, Maceda Law, Tenant Act) when material.',
      ].join(' ')

    // Header style:
    //   - anthropic â†’ x-api-key + anthropic-version (Anthropic API)
    //   - none      â†’ no auth header (local LLMs: Ollama, LM Studio)
    //   - bearer    â†’ Authorization: Bearer (default; OpenAI shims)
    // If api_key is empty we drop the auth header entirely regardless,
    // because sending `Bearer ` with no token would 401 the upstream.
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    const hasKey = !!(cfg.api_key && cfg.api_key.length > 0)
    if (cfg.header_style === 'anthropic' && hasKey) {
      headers['x-api-key'] = cfg.api_key as string
      headers['anthropic-version'] = '2023-06-01'
    } else if (cfg.header_style === 'none' || !hasKey) {
      // No auth header â€” the local LLM gateway accepts unauthenticated
      // requests, or the admin chose to put auth in the URL path.
    } else {
      headers['authorization'] = `Bearer ${cfg.api_key}`
    }

    // Body style:
    //   - 'ollama'    â†’ { model, messages, stream:false } against
    //                   Ollama's /api/chat. Response: { message: { content } }.
    //   - 'anthropic' â†’ { model, max_tokens, system, messages } â€”
    //                   Anthropic /v1/messages or any OpenAI-compat
    //                   shim. Response: { content:[{text}] } or
    //                   { choices:[{message:{content}}] }.
    //
    // We auto-detect Ollama from the endpoint URL when body_style
    // wasn't set explicitly: a URL ending in /api/chat or /api/generate
    // is the Ollama-native API. Anything else falls back to anthropic
    // shape (the broadest compatibility).
    const isOllamaShape =
      cfg.body_style === 'ollama'
      || (!cfg.body_style && /\/api\/(chat|generate)\/?$/i.test(cfg.endpoint))

    const requestBody: Record<string, unknown> = isOllamaShape
      ? {
          model: cfg.model || 'llama3',
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
        }
      : {
          model: cfg.model || 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }

    let aiText = ''
    try {
      const ctrl = new AbortController()
      // Local LLMs (Ollama llama3 on a remote machine via cloudflared)
      // can take 30-60s for the first generation while the model warms
      // up and the tunnel negotiates. Allow override via env var; cap
      // at 5 min so a wedged provider never pins the function.
      const timeoutMs = Math.min(
        Number(process.env.AI_GENERATION_TIMEOUT_MS) || 90_000,
        300_000,
      )
      const timeout = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: ctrl.signal,
      })
      clearTimeout(timeout)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        logger.error(
          {
            status: res.status,
            body: text.slice(0, 1000),
            endpoint: cfg.endpoint,
            body_style: isOllamaShape ? 'ollama' : 'anthropic',
            model: (requestBody as any).model,
            op: 'generate_ai.upstream',
          },
          'ai_upstream_error',
        )
        // Surface the upstream's own body in the response (clipped) so
        // the wizard's toast / dev console actually shows what Ollama
        // (or whichever provider) said. Otherwise debugging a 502 means
        // tailing the server log just to find the body.
        throw createError({
          statusCode: 502,
          statusMessage: `AI provider returned ${res.status}: ${text.slice(0, 300) || '(empty body)'}`,
          data: {
            upstream_status: res.status,
            upstream_body: text.slice(0, 1000),
            endpoint: cfg.endpoint,
            body_style: isOllamaShape ? 'ollama' : 'anthropic',
          },
        })
      }
      // Read body text once so a JSON parse failure can also surface
      // the actual content (some Ollama versions emit text/event-stream
      // when stream:false isn't honored, which trips res.json()).
      const rawText = await res.text()
      let json: any
      try {
        json = JSON.parse(rawText)
      } catch (parseErr: any) {
        logger.error(
          { err: parseErr?.message, body: rawText.slice(0, 1000), op: 'generate_ai.parse' },
          'ai_parse_failed',
        )
        throw createError({
          statusCode: 502,
          statusMessage: `AI provider returned non-JSON: ${rawText.slice(0, 200) || '(empty)'}`,
          data: { upstream_body: rawText.slice(0, 1000), endpoint: cfg.endpoint },
        })
      }
      // Three response shapes:
      //   Anthropic /v1/messages â†’ { content: [{ text }] }
      //   OpenAI-compat          â†’ { choices: [{ message: { content } }] }
      //   Ollama /api/chat       â†’ { message: { content } }
      //   Ollama /api/generate   â†’ { response }
      aiText =
        json?.content?.[0]?.text ??
        json?.choices?.[0]?.message?.content ??
        json?.message?.content ??
        json?.response ??
        ''
    } catch (err: any) {
      if (err?.statusCode) throw err
      logger.error({ err: err?.message, op: 'generate_ai.fetch' }, 'ai_fetch_failed')
      throw createError({
        statusCode: 502,
        statusMessage: err?.name === 'AbortError'
          ? `AI provider timed out â€” local LLMs over a tunnel may need more time. Override AI_GENERATION_TIMEOUT_MS in .env (current default 90s).`
          : `AI provider request failed: ${err?.message ?? 'unknown'}`,
      })
    }

    if (!aiText.trim()) {
      // 200 OK but no extractable text. Most likely cause: response
      // shape didn't match any of the four parsers (Anthropic /
      // OpenAI-compat / Ollama /api/chat / Ollama /api/generate). Log
      // the raw JSON keys so the operator can see which shape the
      // upstream actually returned.
      logger.error(
        {
          op: 'generate_ai.empty',
          endpoint: cfg.endpoint,
          body_style: isOllamaShape ? 'ollama' : 'anthropic',
        },
        'ai_empty_response',
      )
      throw createError({
        statusCode: 502,
        statusMessage: 'AI provider returned 200 but no extractable text. Likely a response-shape mismatch â€” set AI_GENERATION_BODY_STYLE in .env (ollama|anthropic) and try again.',
      })
    }

    // ---- Persist as a new draft -------------------------------------
    // template_id is null â€” this is a freeform AI-authored draft. The
    // generated text lives in data.ai_body and the editor renders it
    // as a long-form text section. tags carry the doc_type so the list
    // panel can chip-color it consistently with the upload + template
    // flows.
    const insert: Record<string, unknown> = {
      template_id: null,
      contact_id: body.contact_id ?? null,
      listing_id: body.listing_id ?? null,
      data: { ai_body: aiText, ai_prompt: body.prompt, ai_doc_type: body.doc_type },
      title: `AI draft â€” ${body.doc_type}`,
      tags: [body.doc_type, 'ai-generated'],
    }
    const { data: draft, error: insErr } = await (supabase as any)
      .from('document_drafts')
      .insert(insert)
      .select('*')
      .single()
    if (insErr) {
      logger.error({ err: insErr.message, op: 'generate_ai.draft_insert' }, 'ai_draft_insert_failed')
      throw createError({ statusCode: 500, statusMessage: insErr.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'document_draft.created' as any,
      entity: 'document',
      metadata: {
        draft_id: draft?.id,
        doc_type: body.doc_type,
        listing_id: body.listing_id ?? null,
        contact_id: body.contact_id ?? null,
        source: 'ai_generated',
      },
    })

    setResponseStatus(event, 201)
    return draft
  },
})
