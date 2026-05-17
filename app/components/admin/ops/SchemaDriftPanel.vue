<script setup lang="ts">
/**
 * Schema governance panel for /admin/operations.
 *
 * Two read-only surfaces:
 *   1. Drift report — calls /api/admin/schema/drift; reports per-
 *      contract status (healthy / drift / missing) with findings.
 *   2. Contract registry — calls /api/admin/schema/contracts; lists
 *      registered cross-repo contracts with active drift counts.
 *
 * The drift check is user-triggered (button), not polled. Running it
 * iterates information_schema for every contract — cheap on this
 * DB, but no point running it every 30s for an admin dashboard.
 */
import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'

type DriftFinding = {
  drift_type: string
  severity: 'critical' | 'warning' | 'info'
  column_name: string | null
  expected: string | null
  actual: string | null
  details: Record<string, unknown>
}
type DriftRow = {
  contract_name: string
  contract_type: string
  owner_repo: string
  status: 'healthy' | 'drift' | 'missing'
  critical_count: number
  warning_count: number
  findings: DriftFinding[]
}
type DriftSummary = { total: number; healthy: number; drift: number; missing: number }

type ContractRow = {
  id: string
  contract_name: string
  contract_type: string
  owner_repo: string
  consumers: string[]
  is_public: boolean
  deprecated_at: string | null
  description: string | null
  health: { last_drift_at: string | null; active_drift_count: number }
}

const driftRows = ref<DriftRow[]>([])
const driftSummary = ref<DriftSummary | null>(null)
const lastChecked = ref<string | null>(null)
const driftLoading = ref(false)

const contracts = ref<ContractRow[]>([])
const contractsLoading = ref(true)
const expanded = ref<Record<string, boolean>>({})

async function runDriftCheck() {
  if (driftLoading.value) return
  driftLoading.value = true
  try {
    const res = await $fetch<{
      summary: DriftSummary
      contracts: DriftRow[]
      checked_at: string
    }>('/api/admin/schema/drift')
    driftRows.value = res.contracts ?? []
    driftSummary.value = res.summary ?? null
    lastChecked.value = res.checked_at
    showToast({
      title:
        res.summary.missing + res.summary.drift === 0
          ? 'All contracts healthy'
          : `${res.summary.missing} missing, ${res.summary.drift} with drift`,
      icon: res.summary.missing > 0 ? 'error' : res.summary.drift > 0 ? 'warning' : 'success',
    })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Drift check failed',
      icon: 'error',
    })
  } finally {
    driftLoading.value = false
  }
}

async function loadContracts() {
  try {
    const res = await $fetch<{ contracts: ContractRow[] }>('/api/admin/schema/contracts')
    contracts.value = res.contracts ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load registry',
      icon: 'error',
    })
  } finally {
    contractsLoading.value = false
  }
}

onMounted(loadContracts)

function statusClass(s: DriftRow['status']): string {
  if (s === 'missing') return 'bg-destructive/15 text-destructive'
  if (s === 'drift') return 'bg-warning/15 text-warning'
  return 'bg-success/15 text-success'
}

function rowsWithIssues(): DriftRow[] {
  return driftRows.value.filter((r) => r.status !== 'healthy')
}

const issueRows = computed(rowsWithIssues)
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Schema governance</h3>
        <p class="text-xs text-muted-foreground">
          Cross-repo contracts validated against live schema.
          Read-only — drift detection never auto-fixes.
        </p>
      </div>
      <button
        type="button"
        class="rounded-md border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
        :disabled="driftLoading"
        @click="runDriftCheck"
      >
        {{ driftLoading ? 'Checking…' : 'Run drift check' }}
      </button>
    </header>

    <!-- Drift summary chips -->
    <div
      v-if="driftSummary"
      class="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]"
    >
      <span class="rounded-full bg-success/15 px-2 py-0.5 font-semibold text-success">
        {{ driftSummary.healthy }} healthy
      </span>
      <span
        v-if="driftSummary.drift > 0"
        class="rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-warning"
      >
        {{ driftSummary.drift }} drift
      </span>
      <span
        v-if="driftSummary.missing > 0"
        class="rounded-full bg-destructive/15 px-2 py-0.5 font-semibold text-destructive"
      >
        {{ driftSummary.missing }} missing
      </span>
      <span class="ml-auto text-[10px] text-muted-foreground">
        Checked {{ lastChecked ? new Date(lastChecked).toLocaleTimeString() : '—' }}
      </span>
    </div>

    <!-- Issue list (only when drift check has found problems) -->
    <div
      v-if="issueRows.length > 0"
      class="mb-4 space-y-2"
    >
      <p class="text-xs font-semibold text-foreground">Issues</p>
      <div
        v-for="row in issueRows"
        :key="row.contract_name"
        class="rounded-md border border-border bg-muted/40 p-2"
      >
        <div class="flex items-baseline gap-2">
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            :class="statusClass(row.status)"
          >{{ row.status }}</span>
          <p class="text-xs font-mono text-foreground">{{ row.contract_name }}</p>
          <span class="text-[10px] text-muted-foreground">{{ row.contract_type }}</span>
          <button
            type="button"
            class="ml-auto text-[10px] font-semibold text-primary hover:underline"
            @click="expanded[row.contract_name] = !expanded[row.contract_name]"
          >
            {{ expanded[row.contract_name] ? 'Hide' : 'Show' }} {{ row.findings.length }}
          </button>
        </div>
        <div
          v-if="expanded[row.contract_name]"
          class="mt-2 space-y-1 border-t border-border pt-2"
        >
          <div
            v-for="(f, idx) in row.findings"
            :key="idx"
            class="text-[11px] text-foreground"
          >
            <span
              class="inline-block rounded px-1 text-[10px] font-semibold"
              :class="f.severity === 'critical' ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning'"
            >{{ f.drift_type }}</span>
            <span v-if="f.column_name" class="ml-1 font-mono">{{ f.column_name }}</span>
            <span v-if="f.expected || f.actual" class="ml-1 text-muted-foreground">
              expected <code>{{ f.expected || '—' }}</code>, actual <code>{{ f.actual || '—' }}</code>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Contract registry -->
    <div>
      <p class="mb-1 text-xs font-semibold text-foreground">
        Registered contracts ({{ contracts.length }})
      </p>
      <div
        v-if="contractsLoading"
        class="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground"
      >
        Loading…
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th class="py-1 pr-2 font-semibold">Contract</th>
              <th class="py-1 pr-2 font-semibold">Type</th>
              <th class="py-1 pr-2 font-semibold">Owner</th>
              <th class="py-1 pr-2 font-semibold">Consumers</th>
              <th class="py-1 pr-2 font-semibold">Public?</th>
              <th class="py-1 font-semibold">Active drift</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="c in contracts"
              :key="c.id"
              :class="c.health.active_drift_count > 0 ? 'bg-warning/10' : ''"
            >
              <td class="py-1.5 pr-2 font-mono text-[11px]">{{ c.contract_name }}</td>
              <td class="py-1.5 pr-2 text-foreground">{{ c.contract_type }}</td>
              <td class="py-1.5 pr-2 text-foreground">{{ c.owner_repo }}</td>
              <td class="py-1.5 pr-2 text-foreground">
                {{ (c.consumers || []).join(', ') }}
              </td>
              <td class="py-1.5 pr-2">
                <span v-if="c.is_public" class="rounded bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">public</span>
                <span v-else class="text-muted-foreground/70">—</span>
              </td>
              <td class="py-1.5">
                <span
                  v-if="c.health.active_drift_count > 0"
                  class="rounded bg-warning/15 px-1.5 text-[10px] font-semibold text-warning"
                >
                  {{ c.health.active_drift_count }}
                </span>
                <span v-else class="text-success text-[10px]">ok</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
