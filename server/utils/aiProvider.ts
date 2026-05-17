// AI provider abstraction.
//
// Phase D foundation. Centralises model calls so the rest of the app
// never reaches OpenAI / Anthropic directly. The worker
// (api/internal/ai-suggestion-worker-tick.post.ts) is the only
// caller; everything else reads from ai_suggestions.
//
// Provider is chosen by AI_SUGGESTION_PROVIDER env var:
//   'anthropic' (default) | 'openai' | 'noop'
//
// Required env per provider:
//   anthropic: ANTHROPIC_API_KEY, optional ANTHROPIC_MODEL (defaults to claude-sonnet-4-6)
//   openai:    OPENAI_API_KEY,    optional OPENAI_MODEL    (defaults to gpt-4o-mini)
//
// 'noop' is the safe default when no key is configured: returns a
// canned suggestion that the human can clearly see is a placeholder.
// This way the queue still writes rows in dev, and we never silently
// send live PII to a provider just because someone forgot to set
// AI_SUGGESTION_PROVIDER.

import { logger } from './logger'

export type CompletionInput = {
  system: string
  user: string
  // Schema hint for the model — currently free-form text. The worker
  // post-processes the response into a typed payload.
  expected_format: string
  // Caller's own version tag, written into ai_suggestions.prompt_version.
  prompt_version: string
}

export type CompletionResult = {
  text: string
  model_provider: string
  model_name: string
  model_run_id: string | null
  // 0..1 if the provider returns a meaningful score; otherwise null.
  confidence: number | null
}

function pickProvider(): 'anthropic' | 'openai' | 'noop' {
  const envChoice = (process.env.AI_SUGGESTION_PROVIDER ?? '').toLowerCase().trim()
  if (envChoice === 'openai') return 'openai'
  if (envChoice === 'anthropic') return 'anthropic'
  if (envChoice === 'noop') return 'noop'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.OPENAI_API_KEY) return 'openai'
  return 'noop'
}

export async function runCompletion(input: CompletionInput): Promise<CompletionResult> {
  const provider = pickProvider()

  if (provider === 'noop') {
    return {
      text: `[noop provider] No AI provider configured. This is a placeholder suggestion. Set AI_SUGGESTION_PROVIDER and the corresponding API key to enable real generations.\n\nExpected format: ${input.expected_format}`,
      model_provider: 'noop',
      model_name: 'noop',
      model_run_id: null,
      confidence: null,
    }
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY!
    const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: input.system,
        messages: [{ role: 'user', content: input.user }],
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>')
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`)
    }
    const json = (await res.json()) as {
      id: string
      content: Array<{ type: string; text?: string }>
      model: string
    }
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('')
    return {
      text,
      model_provider: 'anthropic',
      model_name: json.model ?? model,
      model_run_id: json.id ?? null,
      confidence: null,
    }
  }

  // openai
  const apiKey = process.env.OPENAI_API_KEY!
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>')
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    id: string
    model: string
    choices: Array<{ message: { content: string }; finish_reason: string }>
  }
  const text = json.choices?.[0]?.message?.content ?? ''
  return {
    text,
    model_provider: 'openai',
    model_name: json.model ?? model,
    model_run_id: json.id ?? null,
    confidence: null,
  }
}

// Try to extract a JSON object from a model's text response. Models
// often wrap JSON in ```json ... ``` fences or add prose around it.
// Returns null if no parseable object is found.
export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? text
  // Find first '{' and matching final '}'.
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first < 0 || last < 0 || last <= first) return null
  const sliced = candidate.slice(first, last + 1)
  try {
    return JSON.parse(sliced) as T
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, op: 'aiProvider.extractJson' },
      'ai_provider_json_parse_failed',
    )
    return null
  }
}
