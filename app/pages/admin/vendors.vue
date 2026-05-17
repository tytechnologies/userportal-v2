<script setup lang="ts">
/**
 * /admin/vendors — service-provider catalog.
 *
 * Vendors get assigned to work orders. Operators add new ones (e.g.,
 * after onboarding a new plumber), edit rates, mark archived when
 * relationships end.
 *
 * Inline create + edit modals; no separate detail page (the data is
 * shallow and editing in place is faster).
 */

import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'
import UiDrawer from '~/components/ui/UiDrawer.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Vendors | Admin' })

type VendorStatus = 'active' | 'paused' | 'suspended' | 'archived'

type Vendor = {
  id: string
  name: string
  kind: string
  email: string | null
  phone: string | null
  // Plaintext column dropped in migration 076. tax_id_encrypted is
  // presence-only (we never receive ciphertext bytes in JS — the
  // server returns it as a base64 string in some encodings, but for
  // UI purposes we only check `!= null`). Decrypted value comes from
  // GET /api/vendors/:id/tax-id when the operator opens the row.
  tax_id_encrypted: string | null
  service_areas: Record<string, unknown>
  rate_card: Record<string, unknown>
  rating: number | null
  status: VendorStatus
  notes: string | null
  withholding_rate_bps: number | null
  withholding_atc_code: string | null
  final_withholding_rate_bps: number | null
  final_withholding_atc_code: string | null
  created_at: string
  updated_at: string
}

// Curated PH BIR Alphanumeric Tax Codes (most common for property /
// services). Source: BIR ATC table. We don't ship the full list — the
// operator can type anything they need into the box if not listed.
const ATC_OPTIONS: Array<{ code: string; label: string; default_bps: number }> = [
  { code: '',      label: '— No withholding —',                          default_bps: 0 },
  { code: 'WC158', label: 'WC158 — Gross rental (real property) 5%',     default_bps: 500 },
  { code: 'WI010', label: 'WI010 — Professional fees (individual) 10%',  default_bps: 1000 },
  { code: 'WI011', label: 'WI011 — Professional fees (individual) 15%',  default_bps: 1500 },
  { code: 'WC100', label: 'WC100 — Gross sales (goods) 1%',              default_bps: 100 },
  { code: 'WC120', label: 'WC120 — Gross sales (services) 2%',           default_bps: 200 },
  { code: 'WC139', label: 'WC139 — Income payments to contractors 2%',   default_bps: 200 },
  { code: 'WC156', label: 'WC156 — Commission of brokers 10%',           default_bps: 1000 },
]

// Final-withholding ATCs are a different (smaller) set — these fully
// settle the vendor's tax obligation rather than offsetting it.
const FINAL_ATC_OPTIONS: Array<{ code: string; label: string; default_bps: number }> = [
  { code: '',      label: '— No final withholding —',                    default_bps: 0 },
  { code: 'WI100', label: 'WI100 — Cash dividends 10%',                  default_bps: 1000 },
  { code: 'WC222', label: 'WC222 — Royalties (non-resident) 25%',        default_bps: 2500 },
  { code: 'WI160', label: 'WI160 — Interest (deposit substitutes) 20%',  default_bps: 2000 },
  { code: 'WI180', label: 'WI180 — Prizes / winnings 20%',               default_bps: 2000 },
]

const KNOWN_KINDS = [
  'plumber',
  'electrician',
  'pest_control',
  'cleaning',
  'hvac',
  'painting',
  'security',
  'landscaping',
  'general',
  'appliance_repair',
] as const

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const vendors = ref<Vendor[]>([])
const loading = ref(false)
const kindFilter = ref<string>('')
const statusFilter = ref<VendorStatus | 'all'>('active')
const search = ref('')

const showCreate = ref(false)
const editingId = ref<string | null>(null)

type FormState = {
  name: string
  kind: string
  email: string
  phone: string
  tax_id: string
  status: VendorStatus
  notes: string
  withholding_atc_code: string
  withholding_rate_bps: number | null
  final_withholding_atc_code: string
  final_withholding_rate_bps: number | null
}

const blankForm = (): FormState => ({
  name: '',
  kind: 'general',
  email: '',
  phone: '',
  tax_id: '',
  status: 'active',
  notes: '',
  withholding_atc_code: '',
  withholding_rate_bps: null,
  final_withholding_atc_code: '',
  final_withholding_rate_bps: null,
})

function onAtcChange(code: string) {
  const match = ATC_OPTIONS.find((o) => o.code === code)
  if (!match) return
  if (match.default_bps > 0) form.withholding_rate_bps = match.default_bps
  else if (code === '') form.withholding_rate_bps = null
}

function onFinalAtcChange(code: string) {
  const match = FINAL_ATC_OPTIONS.find((o) => o.code === code)
  if (!match) return
  if (match.default_bps > 0) form.final_withholding_rate_bps = match.default_bps
  else if (code === '') form.final_withholding_rate_bps = null
}

const form = reactive<FormState>(blankForm())
const saving = ref(false)

async function load() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (kindFilter.value) params.kind = kindFilter.value
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    const res = await $fetch<{ items: Vendor[] }>('/api/vendors', { query: params })
    vendors.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load vendors', icon: 'error' })
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return vendors.value
  return vendors.value.filter(
    (v) =>
      v.name.toLowerCase().includes(q) ||
      (v.email ?? '').toLowerCase().includes(q) ||
      v.kind.toLowerCase().includes(q),
  )
})

function startCreate() {
  Object.assign(form, blankForm())
  editingId.value = null
  showCreate.value = true
}

// Snapshot of the TIN value the form was opened with, so save() can
// detect a change and only POST to /tax-id when needed (avoids a
// permission probe + write on every save).
const initialTaxId = ref<string>('')
const taxIdLoading = ref(false)

async function startEdit(v: Vendor) {
  editingId.value = v.id
  Object.assign(form, {
    name: v.name,
    kind: v.kind,
    email: v.email ?? '',
    phone: v.phone ?? '',
    tax_id: '',
    status: v.status,
    notes: v.notes ?? '',
    withholding_atc_code: v.withholding_atc_code ?? '',
    withholding_rate_bps: v.withholding_rate_bps ?? null,
    final_withholding_atc_code: v.final_withholding_atc_code ?? '',
    final_withholding_rate_bps: v.final_withholding_rate_bps ?? null,
  })
  initialTaxId.value = ''
  showCreate.value = true

  // Fetch decrypted TIN if the vendor has one. Permission failures
  // (operator lacks pii.vendors.tax_id.read) silently leave the field
  // blank with a placeholder — they can still edit other fields.
  if (v.tax_id_encrypted) {
    taxIdLoading.value = true
    try {
      const res = await $fetch<{ tax_id: string | null }>(`/api/vendors/${v.id}/tax-id`)
      const next = res.tax_id ?? ''
      form.tax_id = next
      initialTaxId.value = next
    } catch {
      // No permission or decrypt failure — leave blank and let the
      // operator decide whether to overwrite (which would clear the
      // existing encrypted value if they save with empty).
      form.tax_id = ''
      initialTaxId.value = ''
    } finally {
      taxIdLoading.value = false
    }
  }
}

async function save() {
  if (!form.name.trim() || !form.kind.trim()) {
    showToast({ title: 'Name and kind are required', icon: 'warning' })
    return
  }
  saving.value = true
  try {
    const body = {
      name: form.name.trim(),
      kind: form.kind.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      // tax_id is sent through the dedicated /tax-id endpoint after
      // the main save (so encryption + permission gating apply).
      status: form.status,
      notes: form.notes.trim() || null,
      withholding_atc_code: form.withholding_atc_code.trim() || null,
      withholding_rate_bps:
        form.withholding_rate_bps == null || Number.isNaN(form.withholding_rate_bps)
          ? null
          : Math.max(0, Math.min(5000, Math.round(form.withholding_rate_bps))),
      final_withholding_atc_code: form.final_withholding_atc_code.trim() || null,
      final_withholding_rate_bps:
        form.final_withholding_rate_bps == null || Number.isNaN(form.final_withholding_rate_bps)
          ? null
          : Math.max(0, Math.min(5000, Math.round(form.final_withholding_rate_bps))),
    }
    let vendorId = editingId.value
    if (vendorId) {
      await $fetch(`/api/vendors/${vendorId}`, { method: 'PATCH', body })
    } else {
      const created = await $fetch<{ id: string }>('/api/vendors', { method: 'POST', body })
      vendorId = created?.id ?? null
    }

    // Persist TIN through the dedicated encrypt-aware endpoint when
    // the field is dirty (or always on create if non-empty).
    const nextTaxId = form.tax_id.trim()
    const isCreate = !editingId.value
    const taxIdChanged = isCreate ? nextTaxId.length > 0 : nextTaxId !== initialTaxId.value.trim()
    if (vendorId && taxIdChanged) {
      try {
        await $fetch(`/api/vendors/${vendorId}/tax-id`, {
          method: 'PATCH',
          body: { tax_id: nextTaxId || null },
        })
      } catch (err: any) {
        // Vendor saved; only the TIN write failed. Surface the
        // partial success so the operator can fix permissions and retry.
        showToast({
          title: `Vendor saved, but TIN write failed: ${err?.statusMessage || err?.message || 'unknown error'}`,
          icon: 'warning',
        })
        showCreate.value = false
        await load()
        return
      }
    }

    showToast({ title: editingId.value ? 'Vendor updated' : 'Vendor added' })
    showCreate.value = false
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Save failed', icon: 'error' })
  } finally {
    saving.value = false
  }
}

function statusClass(s: VendorStatus) {
  if (s === 'active') return 'bg-success/15 text-success'
  if (s === 'paused') return 'bg-warning/15 text-warning'
  if (s === 'suspended') return 'bg-destructive/15 text-destructive'
  return 'bg-muted text-muted-foreground'
}

onMounted(async () => {
  const ok =
    (await hasPermission('vendors.manage')) || (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await load()
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
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-page-title">
            Vendors
          </h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Service-provider catalog. Vendors get assigned to work orders.
          </p>
        </div>
        <button
          type="button"
          class="inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 focus-ring"
          @click="startCreate"
        >
          + Add vendor
        </button>
      </header>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="kindFilter"
          class="rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
          @change="load"
        >
          <option value="">All kinds</option>
          <option v-for="k in KNOWN_KINDS" :key="k" :value="k">{{ k.replace('_', ' ') }}</option>
        </select>
        <div class="inline-flex rounded-lg border border-border p-1">
          <button
            v-for="opt in (['active', 'paused', 'suspended', 'archived', 'all'] as const)"
            :key="opt"
            type="button"
            :class="[
              'px-3 py-1 text-xs font-medium rounded-md transition',
              statusFilter === opt
                ? 'bg-primary text-white'
                : 'text-foreground hover:text-foreground/80',
            ]"
            @click="statusFilter = opt; load()"
          >
            {{ opt }}
          </button>
        </div>
        <input
          v-model="search"
          type="search"
          placeholder="Search name, email, kind…"
          class="ml-auto w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
        />
      </div>

      <!-- Table -->
      <section class="rounded-lg border border-border bg-card p-0 text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="filtered.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          <p>No vendors yet.</p>
          <button
            v-if="vendors.length === 0"
            type="button"
            class="mt-3 text-primary hover:underline"
            @click="startCreate"
          >
            Add your first vendor
          </button>
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Name</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Kind</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Contact</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Withholding</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Rating</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="v in filtered" :key="v.id" class="hover:bg-accent hover:text-accent-foreground">
                <td class="px-3 py-2 font-medium text-foreground">{{ v.name }}</td>
                <td class="px-3 py-2 text-xs text-muted-foreground capitalize">{{ v.kind.replace('_', ' ') }}</td>
                <td class="px-3 py-2">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(v.status)]">{{ v.status }}</span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <div v-if="v.email">{{ v.email }}</div>
                  <div v-if="v.phone" class="text-muted-foreground">{{ v.phone }}</div>
                  <div v-if="!v.email && !v.phone" class="text-muted-foreground/70">—</div>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <div v-if="v.withholding_atc_code">
                    <span class="font-mono text-success">
                      {{ v.withholding_atc_code }}
                    </span>
                    <span v-if="v.withholding_rate_bps" class="ml-1 tabular-nums">
                      ({{ (v.withholding_rate_bps / 100).toFixed(1) }}%)
                    </span>
                    <span class="ml-1 text-[10px] text-muted-foreground/70">cred.</span>
                  </div>
                  <div v-if="v.final_withholding_atc_code">
                    <span class="font-mono text-primary">
                      {{ v.final_withholding_atc_code }}
                    </span>
                    <span v-if="v.final_withholding_rate_bps" class="ml-1 tabular-nums">
                      ({{ (v.final_withholding_rate_bps / 100).toFixed(1) }}%)
                    </span>
                    <span class="ml-1 text-[10px] text-muted-foreground/70">final</span>
                  </div>
                  <div v-if="!v.withholding_atc_code && !v.final_withholding_atc_code" class="text-muted-foreground/70">
                    none
                  </div>
                </td>
                <td class="px-3 py-2 text-right tabular-nums text-foreground">
                  <span v-if="v.rating !== null">{{ Number(v.rating).toFixed(1) }} â˜…</span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    type="button"
                    class="text-xs text-primary hover:underline"
                    @click="startEdit(v)"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Create / edit drawer (slide-in from right) -->
      <UiDrawer
        :open="showCreate"
        :title="editingId ? 'Edit vendor' : 'Add vendor'"
        width="lg"
        @update:open="showCreate = $event"
      >
        <form id="vendor-form" class="space-y-3" @submit.prevent="save">
            <div class="grid grid-cols-2 gap-3">
              <label class="col-span-2 block">
                <span class="block text-xs font-medium text-muted-foreground">Name</span>
                <input
                  v-model="form.name"
                  type="text"
                  required
                  maxlength="200"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Kind</span>
                <select
                  v-model="form.kind"
                  required
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                >
                  <option v-for="k in KNOWN_KINDS" :key="k" :value="k">{{ k.replace('_', ' ') }}</option>
                </select>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Status</span>
                <select
                  v-model="form.status"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                >
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="suspended">suspended</option>
                  <option value="archived">archived</option>
                </select>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Email</span>
                <input
                  v-model="form.email"
                  type="email"
                  maxlength="254"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Phone</span>
                <input
                  v-model="form.phone"
                  type="tel"
                  maxlength="40"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
              <label class="col-span-2 block">
                <span class="block text-xs font-medium text-muted-foreground">
                  BIR TIN (encrypted)
                  <span v-if="taxIdLoading" class="ml-1 text-[10px]">decrypting…</span>
                </span>
                <input
                  v-model="form.tax_id"
                  type="text"
                  maxlength="40"
                  :disabled="taxIdLoading"
                  placeholder="000-000-000-000"
                  class="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-60"
                />
                <span class="mt-1 block text-[10px] text-muted-foreground">
                  Stored encrypted via vendor_set_tax_id; only operators with
                  pii.vendors.tax_id.read can decrypt.
                </span>
              </label>

              <!-- Withholding tax (BIR 2307) -->
              <label class="col-span-2 block">
                <span class="block text-xs font-medium text-muted-foreground">
                  Withholding ATC code (BIR 2307)
                </span>
                <select
                  v-model="form.withholding_atc_code"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                  @change="onAtcChange(form.withholding_atc_code)"
                >
                  <option v-for="o in ATC_OPTIONS" :key="o.code" :value="o.code">
                    {{ o.label }}
                  </option>
                </select>
                <span class="mt-1 block text-[10px] text-muted-foreground">
                  Picking an ATC fills the rate below; you can override.
                </span>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">
                  Withholding rate (basis points)
                </span>
                <input
                  v-model.number="form.withholding_rate_bps"
                  type="number"
                  min="0"
                  max="5000"
                  step="50"
                  placeholder="e.g. 500 = 5%"
                  :disabled="!form.withholding_atc_code"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25 disabled:opacity-50"
                />
                <span class="mt-1 block text-[10px] text-muted-foreground">
                  100 bps = 1%. Cap 5000 (50%).
                </span>
              </label>
              <div class="block">
                <span class="block text-xs font-medium text-muted-foreground">
                  Effective rate
                </span>
                <div class="mt-1 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-sm tabular-nums text-foreground">
                  <span v-if="form.withholding_rate_bps">
                    {{ (form.withholding_rate_bps / 100).toFixed(2) }}%
                  </span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </div>
              </div>

              <!-- Final withholding (BIR 2306) -->
              <label class="col-span-2 block">
                <span class="block text-xs font-medium text-muted-foreground">
                  Final-withholding ATC code (BIR 2306)
                </span>
                <select
                  v-model="form.final_withholding_atc_code"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                  @change="onFinalAtcChange(form.final_withholding_atc_code)"
                >
                  <option v-for="o in FINAL_ATC_OPTIONS" :key="o.code" :value="o.code">
                    {{ o.label }}
                  </option>
                </select>
                <span class="mt-1 block text-[10px] text-muted-foreground">
                  Final-withholding settles the vendor's tax fully (vs creditable above).
                </span>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">
                  Final-WH rate (basis points)
                </span>
                <input
                  v-model.number="form.final_withholding_rate_bps"
                  type="number"
                  min="0"
                  max="5000"
                  step="50"
                  :disabled="!form.final_withholding_atc_code"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25 disabled:opacity-50"
                />
              </label>
              <div class="block">
                <span class="block text-xs font-medium text-muted-foreground">
                  Final rate
                </span>
                <div class="mt-1 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-sm tabular-nums text-foreground">
                  <span v-if="form.final_withholding_rate_bps">
                    {{ (form.final_withholding_rate_bps / 100).toFixed(2) }}%
                  </span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </div>
              </div>

              <label class="col-span-2 block">
                <span class="block text-xs font-medium text-muted-foreground">Notes</span>
                <textarea
                  v-model="form.notes"
                  rows="2"
                  maxlength="2000"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
            </div>
        </form>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary focus-ring"
              @click="showCreate = false"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="vendor-form"
              :disabled="saving"
              class="btn-primary disabled:opacity-60 focus-ring"
            >
              <span v-if="saving">Saving…</span>
              <span v-else>{{ editingId ? 'Save changes' : 'Add vendor' }}</span>
            </button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </div>
</template>
