// Unit tests for clientIp() — rate-limit identifier extraction.
//
// Pure function with branching IP resolution; we hit each path:
//   - cf-connecting-ip wins
//   - x-forwarded-for first hop wins when no CF
//   - socket remoteAddress fallback
//   - bracketed IPv6
//   - port-stripped IPv4
//   - IPv4-mapped IPv6 → v4 portion
//   - IPv6 truncated to /64

import { describe, it, expect } from 'vitest'
import { clientIp } from '~~/server/utils/rate-limit'

function fakeEvent(headers: Record<string, string>, remote?: string) {
  return {
    node: {
      req: {
        headers,
        socket: { remoteAddress: remote },
      },
    },
  } as any
}

describe('clientIp', () => {
  it('prefers cf-connecting-ip over x-forwarded-for', () => {
    const ev = fakeEvent({
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '5.6.7.8',
    })
    expect(clientIp(ev)).toBe('1.2.3.4')
  })

  it('uses x-forwarded-for first hop when CF absent', () => {
    const ev = fakeEvent({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    expect(clientIp(ev)).toBe('1.2.3.4')
  })

  it('falls back to socket remoteAddress', () => {
    const ev = fakeEvent({}, '9.9.9.9')
    expect(clientIp(ev)).toBe('9.9.9.9')
  })

  it('returns empty string when nothing is identifiable', () => {
    const ev = fakeEvent({})
    expect(clientIp(ev)).toBe('')
  })

  it('strips brackets from IPv6', () => {
    const ev = fakeEvent({ 'cf-connecting-ip': '[::1]' })
    expect(clientIp(ev)).toBe('::1')
  })

  it('strips port from IPv4 with port', () => {
    const ev = fakeEvent({ 'cf-connecting-ip': '1.2.3.4:5678' })
    expect(clientIp(ev)).toBe('1.2.3.4')
  })

  it('extracts v4 from IPv4-mapped IPv6', () => {
    const ev = fakeEvent({ 'cf-connecting-ip': '::ffff:1.2.3.4' })
    expect(clientIp(ev)).toBe('1.2.3.4')
  })

  it('truncates IPv6 to /64 prefix', () => {
    const ev = fakeEvent({
      'cf-connecting-ip': '2001:db8:abcd:1234:5678:9abc:def0:1234',
    })
    expect(clientIp(ev)).toBe('2001:db8:abcd:1234::/64')
  })

  it('leaves short IPv6 untruncated', () => {
    // 4 or fewer groups → no /64 suffix.
    const ev = fakeEvent({ 'cf-connecting-ip': '2001:db8::1' })
    expect(clientIp(ev)).toBe('2001:db8::1')
  })
})
