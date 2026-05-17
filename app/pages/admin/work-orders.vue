<script setup lang="ts">
/**
 * /admin/work-orders — work order queue.
 *
 * Shows all work orders with status filter. Per-row actions:
 *   - Assign vendor (draft / pending_assignment / assigned → assigned)
 *   - Mark in progress (assigned → in_progress)
 *   - Complete (in_progress → completed) with cost actuals + completion notes
 *
 * Vendor picker pulls active vendors from /api/vendors.
 */

import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Work Orders | Admin' })

type WOStatus =
  | 'draft'
  | 'pending_assignment'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'cancelled'

type WorkOrder = {
  id: string
  work_order_no: string
  maintenance_request_id: string | null
  unit_id: string
  vendor_id: string | null
  assigned_user_id: string | null
  title: string
  description: string | null
  scope: string | null
  cost_estimate_minor: number | null
  cost_actual_minor: number | null
  currency: string
  billing_target: 'owner' | 'tenant' | 'platform'
  scheduled_at: string | null
  started_at: string | null
  completed_at: string | null
  status: WOStatus
  completion_notes: string | null
  created_at: string
}

type Vendor = {
  id: string
  name: string
  kind: string
  status: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const workOrders = ref<WorkOrder[]>([])
const vendors = ref<Vendor[]>([])
const loading = ref(false)
const statusFilter = ref<WOStatus | 'all'>('assigned')

// Per-row action state
const actingId = ref<string | null>(null)

// Assign modal
const assignModal = ref<WorkOrder | null>(null)
const assignVendorId = ref<string>('')

// Complete modal
const completeModal = ref<WorkOrder | null>(null)
const completeForm = reactive({
  cost_actual_minor: 0,
  completion_notes: '',
})

async function load() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    const res = await $fetch<{ items: WorkOrder[] }>('/api/work-orders', { query: params })
    workOrders.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load work orders', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function loadVendors() {
  try {
    const res = await $fetch<{ items: Vendor[] }>('/api/vendors', {
      query: { status: 'active' },
    })
    vendors.value = res.items ?? []
  } catch {
    // non-fatal — picker just shows empty
  }
}

async function startInProgress(wo: WorkOrder) {
  actingId.value = wo.id
  try {
    await $fetch(`/api/work-orders/${wo.id}`, {
      method: 'PATCH',
      body: { status: 'in_progress' },
    })
    showToast({ title: 'Work order in progress' })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not update', icon: 'error' })
  } finally {
    actingId.value = null
  }
}

function openAssign(wo: WorkOrder) {
  assignModal.value = wo
  assignVendorId.value = wo.vendor_id ?? ''
}

async function confirmAssign() {
  if (!assignModal.value) return
  if (!assignVendorId.value) {
    showToast({ title: 'Pick a vendor', icon: 'warning' })
    return
  }
  actingId.value = assignModal.value.id
  try {
    await $fetch(`/api/work-orders/${assignModal.value.id}/assign`, {
      method: 'POST',
      body: { vendor_id: assignVendorId.value },
    })
    showToast({ title: 'Vendor assigned' })
    assignModal.value = null
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Assignment failed', icon: 'error' })
  } finally {
    actingId.value = null
  }
}

function openComplete(wo: WorkOrder) {
  completeModal.value = wo
  completeForm.cost_actual_minor = wo.cost_actual_minor ?? wo.cost_estimate_minor ?? 0
  completeForm.completion_notes = ''
}

async function confirmComplete() {
  if (!completeModal.value) return
  actingId.value = completeModal.value.id
  try {
    await $fetch(`/api/work-orders/${completeModal.value.id}`, {
      method: 'PATCH',
      body: {
        status: 'completed',
        cost_actual_minor: completeForm.cost_actual_minor,
        completion_notes: completeForm.completion_notes.trim() || null,
      },
    })
    showToast({ title: 'Work order completed' })
    completeModal.value = null
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Completion failed', icon: 'error' })
  } finally {
    actingId.value = null
  }
}

const counts = computed(() => {
  const c: Record<string, number> = {
    all: workOrders.value.length,
    draft: 0,
    pending_assignment: 0,
    assigned: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  }
  for (const wo of workOrders.value) c[wo.status] = (c[wo.status] ?? 0) + 1
  return c
})

const vendorById = computed(() => {
  const m: Record<string, Vendor> = {}
  for (const v of vendors.value) m[v.id] = v
  return m
})

function statusClass(s: WOStatus) {
  if (s === 'assigned') return 'bg-primary/15 text-primary'
  if (s === 'in_progress') return 'bg-primary/15 text-primary'
  if (s === 'completed') return 'bg-success/15 text-success'
  if (s === 'cancelled') return 'bg-destructive/15 text-destructive'
  if (s === 'pending_assignment') return 'bg-warning/15 text-warning'
  return 'bg-muted text-muted-foreground'
}

function formatPHP(minor: number | null, currency = 'PHP') {
  if (minor === null) return '—'
  return (minor / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })
}

onMounted(async () => {
  const ok =
    (await hasPermission('maintenance.manage')) || (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await Promise.all([load(), loadVendors()])
})
</script>

<template>
  <div class="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <header>
        <h1 class="text-page-title">
          Work Orders
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Track vendor and in-house work assignments. Assign → in progress → complete with cost actuals.
        </p>
      </header>

      <!-- Status filter -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="opt in (
            ['draft', 'pending_assignment', 'assigned', 'in_progress', 'completed', 'cancelled', 'all'] as const
          )"
          :key="opt"
          type="button"
          :class="[
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
            statusFilter === opt
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
          ]"
          @click="statusFilter = opt; load()"
        >
          <span class="capitalize">{{ opt.replace('_', ' ') }}</span>
          <span
            :class="[
              'rounded-full px-1.5 text-[10px] font-semibold',
              statusFilter === opt ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground',
            ]"
          >{{ counts[opt] }}</span>
        </button>
      </div>

      <!-- Table -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="workOrders.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No work orders match the current filter.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">WO #</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Title</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Vendor</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Estimate</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Actual</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Scheduled</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="wo in workOrders" :key="wo.id" class="hover:bg-accent hover:text-accent-foreground">
                <td class="px-3 py-2 font-mono text-xs">{{ wo.work_order_no }}</td>
                <td class="px-3 py-2">
                  <p class="font-medium text-foreground">{{ wo.title }}</p>
                  <p v-if="wo.scope" class="line-clamp-1 text-xs text-muted-foreground">{{ wo.scope }}</p>
                </td>
                <td class="px-3 py-2">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(wo.status)]">
                    {{ wo.status.replace('_', ' ') }}
                  </span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <span v-if="wo.vendor_id && vendorById[wo.vendor_id]">
                    {{ vendorById[wo.vendor_id]!.name }}
                  </span>
                  <span v-else-if="wo.assigned_user_id" class="text-muted-foreground">In-house staff</span>
                  <span v-else class="text-muted-foreground/70">Unassigned</span>
                </td>
                <td class="px-3 py-2 text-right tabular-nums text-foreground">
                  {{ formatPHP(wo.cost_estimate_minor, wo.currency) }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums">
                  <span
                    :class="
                      wo.cost_actual_minor !== null && wo.cost_estimate_minor !== null && wo.cost_actual_minor > wo.cost_estimate_minor
                        ? 'text-warning font-medium'
                        : 'text-foreground'
                    "
                  >
                    {{ formatPHP(wo.cost_actual_minor, wo.currency) }}
                  </span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ wo.scheduled_at ? new Date(wo.scheduled_at).toLocaleDateString() : '—' }}
                </td>
                <td class="px-3 py-2 text-right">
                  <div class="flex justify-end gap-2">
                    <button
                      v-if="wo.status === 'draft' || wo.status === 'pending_assignment' || wo.status === 'assigned'"
                      type="button"
                      class="text-xs text-primary hover:underline"
                      @click="openAssign(wo)"
                    >
                      Assign
                    </button>
                    <button
                      v-if="wo.status === 'assigned'"
                      type="button"
                      :disabled="actingId === wo.id"
                      class="text-xs text-primary hover:underline"
                      @click="startInProgress(wo)"
                    >
                      Start
                    </button>
                    <button
                      v-if="wo.status === 'in_progress'"
                      type="button"
                      class="text-xs text-success hover:underline"
                      @click="openComplete(wo)"
                    >
                      Complete
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Assign vendor — Phase 5 Operations primitive -->
      <UiModal
        :open="!!assignModal"
        title="Assign vendor"
        :subtitle="assignModal?.title"
        width="md"
        @update:open="(v) => { if (!v) assignModal = null }"
      >
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Vendor</span>
          <select
            v-model="assignVendorId"
            required
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          >
            <option value="">— Choose an active vendor —</option>
            <option v-for="v in vendors" :key="v.id" :value="v.id">
              {{ v.name }} ({{ v.kind.replace('_', ' ') }})
            </option>
          </select>
        </label>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="assignModal = null"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="actingId !== null"
              class="btn-primary disabled:opacity-60"
              @click="confirmAssign"
            >
              <span v-if="actingId !== null">Assigning…</span>
              <span v-else>Confirm</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Complete work order — Phase 5 Operations primitive -->
      <UiModal
        :open="!!completeModal"
        title="Complete work order"
        :subtitle="completeModal?.title"
        width="md"
        @update:open="(v) => { if (!v) completeModal = null }"
      >
        <div class="space-y-3" v-if="completeModal">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Actual cost (centavos · {{ formatPHP(completeForm.cost_actual_minor, completeModal.currency) }})
              </span>
              <input
                v-model.number="completeForm.cost_actual_minor"
                type="number"
                min="0"
                step="100"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
              <p
                v-if="completeModal.cost_estimate_minor !== null && completeForm.cost_actual_minor > completeModal.cost_estimate_minor"
                class="mt-1 text-xs text-warning"
              >
                ⚠ Above estimate of
                {{ formatPHP(completeModal.cost_estimate_minor, completeModal.currency) }}
              </p>
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Completion notes</span>
              <textarea
                v-model="completeForm.completion_notes"
                rows="3"
                maxlength="10000"
                placeholder="What was done, parts used, any follow-up…"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="completeModal = null"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="actingId !== null"
              class="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-success px-3.5 text-sm font-medium text-success-foreground transition-colors hover:bg-success/90 disabled:opacity-60 focus-ring"
              @click="confirmComplete"
            >
              <span v-if="actingId !== null">Completing…</span>
              <span v-else>Mark completed</span>
            </button>
          </div>
        </template>
      </UiModal>
    </template>
  </div>
</template>
