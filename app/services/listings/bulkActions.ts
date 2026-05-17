// Bulk operations for listings. The backend has per-row endpoints
// (/api/listings/[id]/archive, /unarchive, /soft-delete) but no bulk
// counterparts; rather than introduce a new server route, we loop the
// existing endpoints with bounded concurrency and aggregate results.
//
// Trade-off: N requests instead of 1. Acceptable at the current scale
// (typical bulk action operates on <50 rows). If/when a user routinely
// bulk-actions 1000+ rows, swap this for a dedicated POST that takes an
// id array and runs the loop server-side (single transaction, materialized
// view refresh once instead of N times).

export type BulkResult<T = unknown> = {
  ok: T[]
  failed: Array<{ id: number; error: string }>
}

const CONCURRENCY = 5

// Fan out a per-id async operation with bounded concurrency so we don't
// open 500 sockets at once on a big selection. Maintains the order of
// `ids` in the result for predictable logging.
async function runBatched<T>(
  ids: number[],
  op: (id: number) => Promise<T>,
): Promise<BulkResult<T>> {
  const ok: T[] = []
  const failed: Array<{ id: number; error: string }> = []

  let cursor = 0
  const workers: Promise<void>[] = []

  const next = async (): Promise<void> => {
    while (cursor < ids.length) {
      const i = cursor++
      const id = ids[i]
      // cursor < ids.length guarantees id is defined at runtime;
      // noUncheckedIndexedAccess can't see this so the bang is needed.
      if (id === undefined) continue
      try {
        ok.push(await op(id))
      } catch (err: any) {
        failed.push({
          id,
          error: err?.statusMessage || err?.message || String(err),
        })
      }
    }
  }

  for (let w = 0; w < Math.min(CONCURRENCY, ids.length); w++) {
    workers.push(next())
  }
  await Promise.all(workers)

  return { ok, failed }
}

export const bulkArchive = (ids: number[]) =>
  runBatched(ids, (id) =>
    $fetch(`/api/listings/${id}/archive`, { method: 'POST' }),
  )

export const bulkUnarchive = (ids: number[]) =>
  runBatched(ids, (id) =>
    $fetch(`/api/listings/${id}/unarchive`, { method: 'POST' }),
  )

export const bulkSoftDelete = (ids: number[]) =>
  runBatched(ids, (id) =>
    $fetch(`/api/listings/${id}/soft-delete`, { method: 'POST' }),
  )
