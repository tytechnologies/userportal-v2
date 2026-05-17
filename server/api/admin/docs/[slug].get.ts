// GET /api/admin/docs/:slug
//
// Reads docs/<slug>.md from disk and returns it as text. Lets the
// admin UI render operator runbooks inline without bundling them
// into the client. Restricted to a documented allow-list so the
// endpoint can't be used to slurp arbitrary repo files.
//
// Auth: admin.access (RLS doesn't apply to file reads, so we gate here).

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { serverSupabaseUser } from '../../../utils/sbUser'

// Allow-listed slugs map to a docs/*.md path. Only files in this map
// are readable. Add new ones explicitly.
const DOC_PATHS: Record<string, string> = {
  'eis-submitter-runbook': 'docs/eis-submitter-runbook.md',
  'design-tokens': 'docs/design-tokens.md',
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event).catch(() => null)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  }

  const slug = getRouterParam(event, 'slug')
  if (!slug || !SLUG_RE.test(slug)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid doc slug' })
  }
  const relPath = DOC_PATHS[slug]
  if (!relPath) {
    throw createError({ statusCode: 404, statusMessage: 'Doc not found' })
  }

  // process.cwd() at runtime is the project root for Nuxt; read the
  // file relative to that. If the file moves or is missing, surface
  // a 500 with a clear message rather than leaking fs internals.
  try {
    const abs = resolve(process.cwd(), relPath)
    const text = await readFile(abs, 'utf8')
    return { slug, markdown: text }
  } catch (err: any) {
    throw createError({
      statusCode: 500,
      statusMessage: `Could not read doc ${slug}: ${err?.message ?? 'unknown'}`,
    })
  }
})
