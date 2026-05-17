<script setup lang="ts">
// Tax computation record detail page.
//
// Read + edit the metadata (title, notes), see who saved it + when, see
// the linked contact / listing, render the saved input fields, and
// delete the record.
//
// Loading the record back into the calculator form is intentionally
// deferred — round-tripping into the legacy TaxComputationTabs flow
// touches several files; building it here would creep scope. The
// "Edit a copy" button below is a stub for that follow-up.

import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTaxComputations, type TaxComputation } from '~/composables/useTaxComputations'
import { showToast } from '~/helpers/helpers'
import { formatMoney } from '~/utils'
import { useConfirm } from '~/composables/useConfirm'

definePageMeta({ layout: 'default' })
useHead({ title: 'Tax computation | Housinginteractive' })

const route = useRoute()
const router = useRouter()
const { getTaxComputation, updateTaxComputation, deleteTaxComputation } = useTaxComputations()
const { confirm } = useConfirm()

const id = computed(() => String(route.params.id))

const record = ref<TaxComputation | null>(null)
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const isSaving = ref(false)

// Editable copies of title + notes — "Save changes" persists on click.
// Other fields are immutable post-save (taxpayer_type, computation_kind,
// inputs all define what the record IS).
const editableTitle = ref('')
const editableNotes = ref('')
const isDirty = computed(() => {
  if (!record.value) return false
  return (
    (editableTitle.value || null) !== (record.value.title || null)
    || (editableNotes.value || null) !== (record.value.notes || null)
  )
})

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const data = await getTaxComputation(id.value)
    record.value = data
    editableTitle.value = data.title ?? ''
    editableNotes.value = data.notes ?? ''
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load record'
  } finally {
    isLoading.value = false
  }
}

async function saveChanges() {
  if (!record.value || isSaving.value) return
  isSaving.value = true
  try {
    const updated = await updateTaxComputation(id.value, {
      title: editableTitle.value.trim() || null,
      notes: editableNotes.value.trim() || null,
    })
    record.value = updated
    showToast({ title: 'Saved.', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to save',
      icon: 'error',
    })
  } finally {
    isSaving.value = false
  }
}

async function onDelete() {
  if (!record.value) return
  const ok = await confirm({
    title: 'Delete this tax computation?',
    description: 'The record will be removed permanently. This cannot be undone.',
    confirmText: 'Delete',
    variant: 'destructive',
  })
  if (!ok) return

  try {
    await deleteTaxComputation(id.value)
    showToast({ title: 'Deleted.', icon: 'success' })
    router.replace('/tax-computations')
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to delete',
      icon: 'error',
    })
  }
}

// Map raw input keys → human-readable labels. Falls back to a
// title-case of the snake_case key for anything not in the map, so new
// form fields render automatically with a reasonable label.
const FIELD_LABELS: Record<string, string> = {
  type: 'Type',
  nett: 'Nett to Owner',
  zonal_value_amount: 'Zonal Value',
  gross_amount: 'Gross Amount',
  capital_gain_tax: 'Capital Gain Tax',
  ewt: 'Expanded Withholding Tax',
  vat: 'VAT',
  commission: 'Commission',
  documentary_stamp_tax: 'Documentary Stamp Tax',
  transfer_tax: 'Transfer Tax',
  registration_fee: 'Registration Fee',
  misc_fee: 'Misc Fee',
  processing_fee: 'Processing Fee',
}

function labelFor(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Render large currency-shaped values via formatMoney; tiny rate-shaped
// values (≤100, decimals) get a percent suffix. Booleans and strings
// render as-is. This is the same heuristic the legacy form previews use.
function valueFor(key: string, raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '—'
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No'
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') {
    // processing_fee is the one absolute-amount field that's small;
    // otherwise small values are rates (% interest, % tax).
    const isRate = !key.includes('amount') && !key.includes('fee') && raw <= 100
    if (isRate) return `${raw}%`
    if (raw >= 1000) return formatMoney(raw, true)
    return String(raw)
  }
  return JSON.stringify(raw)
}

const inputEntries = computed(() => {
  if (!record.value) return [] as Array<[string, unknown]>
  return Object.entries(record.value.inputs ?? {})
})

const taxpayerLabel = computed(() => {
  if (!record.value) return ''
  return record.value.taxpayer_type === 'corporate' ? 'Corporate' : 'Individual'
})

const kindLabel = computed(() => {
  if (!record.value) return ''
  switch (record.value.computation_kind) {
    case 'gross':   return 'Gross'
    case 'nett':    return 'Nett'
    case 'nett_zv': return 'Nett + ZV'
    default: return record.value.computation_kind
  }
})

function relativeDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

onMounted(load)
</script>

<template>
  <div class="mx-auto max-w-3xl p-4">
    <div class="mb-4">
      <NuxtLink to="/tax-computations" class="text-xs font-semibold text-muted-foreground hover:text-primary">
        ← All tax computations
      </NuxtLink>
    </div>

    <div
      v-if="isLoading"
      class="rounded-xl border border-border bg-background p-8 text-center text-sm text-muted-foreground/70"
    >
      Loading…
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </div>

    <template v-else-if="record">
      <!-- Header card -->
      <section class="rounded-xl border border-border bg-background p-5 shadow-sm">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
              Tax Computation · {{ taxpayerLabel }} · {{ kindLabel }}
            </p>
            <h1 class="mt-1 text-xl font-bold text-foreground">
              {{ record.title || 'Untitled tax computation' }}
            </h1>
            <p class="mt-1 text-xs text-muted-foreground">
              Saved by {{ record.owner?.full_name || 'Unknown' }}
              · {{ relativeDate(record.created_at) }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <NuxtLink
              :to="{ path: '/documents', query: { tab: 'tax-computation', record: id } }"
              class="rounded-md border border-primary/30 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10"
              title="Open the tax form pre-filled with these inputs"
            >
              Edit a copy
            </NuxtLink>
            <button
              type="button"
              class="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10"
              @click="onDelete"
            >
              Delete
            </button>
          </div>
        </div>

        <!-- Linked entities -->
        <div
          v-if="record.contact_id || record.listing_id"
          class="mt-3 flex flex-wrap gap-2 text-xs"
        >
          <NuxtLink
            v-if="record.contact_id"
            :to="`/contacts/${record.contact_id}`"
            class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-primary hover:bg-primary/15"
          >
            🔗 Contact #{{ record.contact_id }}
          </NuxtLink>
          <NuxtLink
            v-if="record.listing_id"
            :to="`/listings/${record.listing_id}`"
            class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-primary hover:bg-primary/15"
          >
            🔗 Listing #{{ record.listing_id }}
          </NuxtLink>
        </div>
      </section>

      <!-- Editable metadata -->
      <section class="mt-4 rounded-xl border border-border bg-background p-5 shadow-sm">
        <h2 class="text-sm font-semibold text-foreground">Notes</h2>
        <div class="mt-3 space-y-3">
          <div>
            <label class="block text-xs font-medium text-muted-foreground" for="rec-title">Title</label>
            <input
              id="rec-title"
              v-model="editableTitle"
              type="text"
              maxlength="200"
              placeholder="Untitled tax computation"
              class="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-muted-foreground" for="rec-notes">Notes</label>
            <textarea
              id="rec-notes"
              v-model="editableNotes"
              rows="4"
              maxlength="5000"
              placeholder="Why this computation was saved, who it was for, follow-ups…"
              class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              :disabled="!isDirty || isSaving"
              @click="saveChanges"
            >
              {{ isSaving ? 'Saving…' : 'Save changes' }}
            </button>
          </div>
        </div>
      </section>

      <!-- Saved inputs (read-only structured view) -->
      <section class="mt-4 rounded-xl border border-border bg-background p-5 shadow-sm">
        <h2 class="text-sm font-semibold text-foreground">Saved inputs</h2>
        <p class="mt-1 text-xs text-muted-foreground/70">
          Re-running the computation against these inputs will reproduce
          the original result.
        </p>
        <dl
          v-if="inputEntries.length > 0"
          class="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2"
        >
          <div
            v-for="[key, raw] in inputEntries"
            :key="key"
            class="flex items-baseline justify-between border-b border-border py-1.5"
          >
            <dt class="text-xs text-muted-foreground">{{ labelFor(key) }}</dt>
            <dd class="font-medium text-foreground">{{ valueFor(key, raw) }}</dd>
          </div>
        </dl>
        <p v-else class="mt-3 text-sm text-muted-foreground/70">
          No inputs were captured.
        </p>
      </section>
    </template>
  </div>
</template>
