#!/usr/bin/env node
// scripts/check-design-tokens.mjs
//
// CI guard: fails if any Vue file in app/ uses hard-coded Tailwind
// gray-* / dark:bg-* / dark:text-* / dark:border-* patterns. The
// codebase has shadcn-vue tokens (bg-card, text-foreground, …) for
// every color decision; see memory/feedback_design_tokens_only.md
// or docs/design-tokens.md for the swap table.
//
// Usage:
//   node scripts/check-design-tokens.mjs            # scan app/
//   node scripts/check-design-tokens.mjs <path>...  # scan specific files/dirs
//
// Exit code:
//   0 if clean
//   1 if any forbidden patterns are found
//
// Allow-list:
//   * comment lines (//, /* */, <!-- -->) are skipped
//   * any line containing "// design-tokens-allow" is skipped
//
// Whitelisted files (legacy, not yet migrated):
//   See ALLOWLIST_FILES below. Add a path here only when migrating
//   would be a separate large effort and you've left a tracking note.

import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const FORBIDDEN = [
  // Hard-coded grays
  /\bgray-(50|100|200|300|400|500|600|700|800|900)\b/,
  // Paired dark variants for semantic colors
  /\bdark:bg-gray-/,
  /\bdark:text-gray-/,
  /\bdark:border-gray-/,
  /\bdark:divide-gray-/,
  // Brand-blue button/link literals (use bg-primary / text-primary)
  /\bbg-blue-(50|100|600|700)\b/,
  /\btext-blue-(600|700|800|900)\b/,
  // Semantic pill literals (use bg-success / bg-warning / bg-destructive / text-success / etc.)
  /\bbg-emerald-(50|100|800|900)\b/,
  /\btext-emerald-(700|800|900)\b/,
  /\bbg-amber-(50|100|800|900)\b/,
  /\btext-amber-(700|800|900)\b/,
  /\bbg-rose-(100|800|900)\b/,
  /\btext-rose-(700|800|900)\b/,
  // Orange / purple / indigo accents — the "rainbow UI" anti-pattern
  // the ui-ux-pro-max skill explicitly warns against. Use the four
  // semantic tokens (primary / success / warning / destructive)
  // instead. Caught the HotAreasList raw-orange regression in the
  // last enterprise SaaS pass.
  /\b(bg|text|border)-orange-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\b(bg|text|border)-purple-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\b(bg|text|border)-indigo-(50|100|200|300|400|500|600|700|800|900)\b/,
  // Raw `ring-color-N` utilities that escape token coverage. The
  // semantic tokens are ring-primary / ring-success / ring-warning /
  // ring-destructive (with /N opacity). Adding bare blue/red/etc.
  // ring colors creates dark-mode breakage and an inconsistent focus
  // story.
  /\bring-blue-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\bring-red-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\bring-amber-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\bring-rose-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\bring-emerald-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\bring-orange-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\bring-purple-(50|100|200|300|400|500|600|700|800|900)\b/,
  /\bring-indigo-(50|100|200|300|400|500|600|700|800|900)\b/,
  // Legacy HI palette (pre-shadcn). Use bg-foreground / bg-muted /
  // bg-primary / text-foreground / text-primary tokens instead.
  /\b(text|bg|border|hover:bg)-black-(2|5|10|20|30|40|50|80)\b/,
  /\b(text|bg|border|hover:bg)-blue-(10|20|401|402|403)\b/,
]

// Files that are intentionally not yet swept. Keep this list small
// and shrinking. Each entry should have a tracking note in
// memory/feedback_design_tokens_only.md.
const ALLOWLIST_FILES = new Set([
  // (none yet)
])

const ROOT = resolve(process.cwd())
const TARGETS =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['app/pages', 'app/components', 'app/layouts', 'app/composables']

async function* walk(path) {
  let s
  try {
    s = await stat(path)
  } catch {
    return
  }
  if (s.isFile()) {
    yield path
    return
  }
  if (!s.isDirectory()) return
  const entries = await readdir(path, { withFileTypes: true })
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.nuxt' || e.name === 'dist') {
      continue
    }
    yield* walk(join(path, e.name))
  }
}

function isCommentLine(line) {
  const trimmed = line.trim()
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('<!--') ||
    trimmed.startsWith('-->')
  )
}

let violations = 0
let scanned = 0

for (const target of TARGETS) {
  const abs = resolve(ROOT, target)
  for await (const file of walk(abs)) {
    if (!file.endsWith('.vue') && !file.endsWith('.ts') && !file.endsWith('.tsx')) continue
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    if (ALLOWLIST_FILES.has(rel)) continue
    scanned += 1

    let src
    try {
      src = await readFile(file, 'utf8')
    } catch {
      continue
    }

    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (isCommentLine(line)) continue
      if (line.includes('design-tokens-allow')) continue

      for (const pat of FORBIDDEN) {
        const m = line.match(pat)
        if (m) {
          console.error(
            `${rel}:${i + 1}: forbidden token "${m[0]}"\n  ${line.trim().slice(0, 120)}`,
          )
          violations += 1
        }
      }
    }
  }
}

console.error(`\nScanned ${scanned} file(s). Violations: ${violations}.`)
if (violations > 0) {
  console.error(
    '\nFix by replacing hard-coded colors with shadcn-vue design tokens. See:',
  )
  console.error('  docs/design-tokens.md')
  console.error('  memory/feedback_design_tokens_only.md (Claude Code memory)')
  console.error('Or annotate a known-bad line with "// design-tokens-allow" when intentional.')
  process.exit(1)
}
process.exit(0)
