/**
 * Word-level diff via the standard LCS dynamic-programming algorithm.
 *
 * Output: an array of `DiffSegment`s — `{kind: 'eq'|'add'|'rem', text}`
 * — that the UI maps to span colors. Whitespace between words is
 * preserved in the segment text so re-rendering reproduces the
 * original spacing.
 *
 * Performance characteristics:
 *   - O(M*N) time, O(M*N) memory in the LCS table.
 *   - For typical legal documents (~1k-5k words per side), that's
 *     a few MB of int8 — fine in a browser, sub-100ms.
 *   - Above ~10k words per side, switch to the Myers diff (O((N+M)D))
 *     algorithm. Not worth the implementation complexity yet.
 *
 * Tokenization: split on whitespace, but keep each whitespace run as
 * its own token so newlines + indentation render in the output.
 * Punctuation rides with its adjacent word — "tenant," is a single
 * token, not "tenant" + "," — which keeps the diff readable.
 */

export type DiffSegment = {
  kind: 'eq' | 'add' | 'rem'
  text: string
}

/** Tokenize "alpha\n\nbeta gamma" → ['alpha', '\n\n', 'beta', ' ', 'gamma'].
 *  Each token is either entirely whitespace or entirely non-whitespace.
 *  This is what lets us preserve formatting on output. */
function tokenize(s: string): string[] {
  if (!s) return []
  const out: string[] = []
  let buf = ''
  let isWs = /\s/.test(s.charAt(0))
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    const chIsWs = /\s/.test(ch)
    if (chIsWs === isWs) {
      buf += ch
    } else {
      if (buf) out.push(buf)
      buf = ch
      isWs = chIsWs
    }
  }
  if (buf) out.push(buf)
  return out
}

/** Compute the LCS table. Cell [i][j] = length of LCS of a[0..i) and
 *  b[0..j). Returned as a flat Int32Array indexed (i * (M+1) + j). */
function lcsTable(a: string[], b: string[]): Int32Array {
  const N = a.length
  const M = b.length
  const t = new Int32Array((N + 1) * (M + 1))
  for (let i = 1; i <= N; i++) {
    const ai = a[i - 1]
    const rowBase = i * (M + 1)
    const prevBase = (i - 1) * (M + 1)
    for (let j = 1; j <= M; j++) {
      if (ai === b[j - 1]) {
        // Diagonal: matched word, length grows by 1.
        t[rowBase + j] = (t[prevBase + (j - 1)] ?? 0) + 1
      } else {
        const up = t[prevBase + j] ?? 0
        const left = t[rowBase + (j - 1)] ?? 0
        t[rowBase + j] = up >= left ? up : left
      }
    }
  }
  return t
}

/** Walk the LCS table back-to-front to produce diff segments. Adjacent
 *  segments of the same kind are merged so the consumer renders fewer
 *  spans. */
export function diffWords(oldText: string, newText: string): DiffSegment[] {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const N = a.length
  const M = b.length
  if (N === 0 && M === 0) return []
  if (N === 0) return [{ kind: 'add', text: newText }]
  if (M === 0) return [{ kind: 'rem', text: oldText }]

  const t = lcsTable(a, b)
  const out: DiffSegment[] = []
  let i = N
  let j = M
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ kind: 'eq', text: a[i - 1] ?? '' })
      i--; j--
    } else {
      const up = t[(i - 1) * (M + 1) + j] ?? 0
      const left = t[i * (M + 1) + (j - 1)] ?? 0
      if (up >= left) {
        out.push({ kind: 'rem', text: a[i - 1] ?? '' })
        i--
      } else {
        out.push({ kind: 'add', text: b[j - 1] ?? '' })
        j--
      }
    }
  }
  while (i > 0) { out.push({ kind: 'rem', text: a[i - 1] ?? '' }); i-- }
  while (j > 0) { out.push({ kind: 'add', text: b[j - 1] ?? '' }); j-- }
  out.reverse()

  // Merge adjacent same-kind segments — the segment-per-token output
  // would explode the DOM otherwise.
  const merged: DiffSegment[] = []
  for (const seg of out) {
    const last = merged[merged.length - 1]
    if (last && last.kind === seg.kind) {
      last.text += seg.text
    } else {
      merged.push({ ...seg })
    }
  }
  return merged
}
