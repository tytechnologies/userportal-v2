// Type-level + runtime smoke check on the audit module's exports.
// Catches a regression where a renamed entity / dropped action would
// silently break a call site.

import { describe, it, expect } from 'vitest'
import type { AuditEntity, AuditAction } from '~~/server/utils/audit'
import { logActivity } from '~~/server/utils/audit'

// audit.ts now lazy-imports `#supabase/server` inside getServerSupabaseClient,
// so this test can collect cleanly without resolving the Nuxt virtual at
// module-load time.

describe('audit module', () => {
  it('exports logActivity as a function', () => {
    expect(typeof logActivity).toBe('function')
  })

  it('AuditEntity union covers known entities', () => {
    // Pure compile-time check — these must be assignable.
    const entities: AuditEntity[] = [
      'listing',
      'contact',
      'document',
      'task',
      'note',
      'inquiry',
      'verification',
    ]
    expect(entities.length).toBe(7)
  })

  it('AuditAction string fallback accepts new identifiers', () => {
    // (string & {}) escape hatch lets new entities ship without a
    // type bump — we just want to confirm the pattern still compiles.
    const action: AuditAction = 'broadcast.sent'
    expect(action).toBe('broadcast.sent')
  })
})
