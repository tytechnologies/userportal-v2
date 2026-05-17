<script setup lang="ts">
// All documents linked to a listing (or contact) — drafts + generated
// artifacts. Mirrors the shape of TasksPanel / NotesPanel on the
// listing detail page.
//
// Visibility is RLS-scoped server-side. Today the caller sees:
//   - their own drafts for this listing
//   - their own generated documents for this listing
//   - every viewing list for this listing (team-wide per migration
//     20260502000013)
// plus anything their team / all permissions extend to.

import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  listingId: number
}>()

type DraftItem = {
  kind: 'draft'
  id: string
  title: string | null
  status: string
  template_id: string | null
  contact_id: number | null
  created_at: string
  updated_at: string
  owner_user_id: string
  owner: { id: string; full_name: string | null } | null
}

type GeneratedItem = {
  kind: 'generated'
  id: string
  file_name: string
  document_type: string | null
  file_format: string | null
  contact_id: number | null
  created_at: string
  signed_url: string
  creator: { id: string; full_name: string | null } | null
}

type TaxItem = {
  kind: 'tax'
  id: string
  title: string | null
  taxpayer_type: string
  computation_kind: string
  contact_id: number | null
  created_at: string
  updated_at: string
  owner_user_id: string
  owner: { id: string; full_name: string | null } | null
}

type DocumentItem = DraftItem | GeneratedItem | TaxItem

type ApiResponse = {
  listing_id: number
  total: number
  data: DocumentItem[]
}

const items = ref<DocumentItem[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)

async function load() {
  if (!Number.isFinite(props.listingId) || props.listingId <= 0) {
    items.value = []
    isLoading.value = false
    return
  }
  isLoading.value = true
  errorMessage.value = null
  try {
    const res = await $fetch<ApiResponse>(`/api/listings/${props.listingId}/documents`)
    items.value = res.data ?? []
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load documents'
  } finally {
    isLoading.value = false
  }
}

onMounted(load)
watch(() => props.listingId, () => load())

// Map document_type → human-readable + color for the badge. Falls back
// to a generic gray pill for unmapped types so new doc types still
// render without a code change.
const TYPE_CONFIG: Record<string, { label: string; chip: string }> = {
  viewing_list:                { label: 'Viewing List',          chip: 'bg-primary/15 text-primary' },
  letter_of_intent:            { label: 'Letter of Intent',      chip: 'bg-primary/10 text-primary' },
  authority_to_sell:           { label: 'Authority to Sell',     chip: 'bg-warning/15 text-warning' },
  contract_to_sell:            { label: 'Contract to Sell',      chip: 'bg-success/15 text-success' },
  deed_of_absolute_sale:       { label: 'Deed of Absolute Sale', chip: 'bg-destructive/15 text-destructive' },
  residential_contract_of_lease: { label: 'Residential Lease',  chip: 'bg-primary/15 text-primary' },
  commercial_contract_of_lease:  { label: 'Commercial Lease',   chip: 'bg-primary/15 text-primary' },
  property_management_agreement: { label: 'Property Management', chip: 'bg-primary/10 text-primary' },
  other:                       { label: 'Other',                 chip: 'bg-muted text-foreground' },
}

const STATUS_CONFIG: Record<string, { label: string; chip: string }> = {
  draft:     { label: 'Draft',     chip: 'bg-muted text-foreground' },
  in_review: { label: 'In Review', chip: 'bg-warning/15 text-warning' },
  signed:    { label: 'Signed',    chip: 'bg-success/15 text-success' },
  archived:  { label: 'Archived',  chip: 'bg-slate-100 text-slate-600' },
}

function typeMeta(item: GeneratedItem) {
  const key = item.document_type ?? 'other'
  return TYPE_CONFIG[key] ?? { label: key.replace(/_/g, ' '), chip: 'bg-muted text-foreground' }
}
function statusMeta(item: DraftItem) {
  return STATUS_CONFIG[item.status] ?? { label: item.status, chip: 'bg-muted text-foreground' }
}
function taxMeta(item: TaxItem) {
  // Pill text: "Tax · Individual nett" or "Tax · Corporate"
  const kindLabel = item.computation_kind === 'nett_zv'
    ? 'nett+ZV'
    : item.computation_kind
  const taxpayer = item.taxpayer_type === 'individual' ? 'Individual' : 'Corporate'
  return {
    label: `Tax · ${taxpayer} ${kindLabel}`,
    chip: item.taxpayer_type === 'corporate'
      ? 'bg-primary/15 text-primary'
      : 'bg-success/15 text-success',
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

function authorLabel(item: DocumentItem): string {
  if (item.kind === 'generated') return item.creator?.full_name ?? 'Unknown'
  // draft + tax both carry an owner relation
  return item.owner?.full_name ?? 'Unknown'
}

const hasItems = computed(() => items.value.length > 0)
</script>

<template>
  <section class="rounded-xl border border-border bg-background shadow-sm">
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <h3 class="text-sm font-semibold text-foreground">Documents</h3>
      <NuxtLink
        :to="{ path: '/document-drafts/new', query: { listing_id: listingId } }"
        class="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground hover:text-foreground"
        title="Start a new draft pre-linked to this listing"
      >
        + New
      </NuxtLink>
    </header>

    <div v-if="isLoading" class="space-y-2 p-4">
      <div v-for="n in 3" :key="n" class="h-3 w-2/3 animate-pulse rounded bg-muted" />
    </div>

    <div
      v-else-if="errorMessage"
      class="m-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
    >
      {{ errorMessage }}
    </div>

    <div
      v-else-if="!hasItems"
      class="px-4 py-10 text-center text-sm text-muted-foreground"
    >
      <p>No documents linked to this listing yet.</p>
      <p class="mt-1 text-xs text-muted-foreground/70">
        Drafts and generated contracts attached to this property will appear here.
      </p>
    </div>

    <ul v-else class="divide-y divide-border">
      <li
        v-for="item in items"
        :key="`${item.kind}:${item.id}`"
        class="flex items-center gap-3 px-4 py-3 hover:bg-accent hover:text-accent-foreground"
      >
        <!-- Kind dot: amber = editable draft, blue = generated artifact,
             teal = saved tax computation. -->
        <span
          aria-hidden="true"
          class="h-2 w-2 shrink-0 rounded-full"
          :class="
            item.kind === 'draft' ? 'bg-warning'
            : item.kind === 'tax' ? 'bg-success'
            : 'bg-primary'
          "
          :title="
            item.kind === 'draft' ? 'Editable draft'
            : item.kind === 'tax' ? 'Saved tax computation'
            : 'Generated document'
          "
        />

        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2">
            <NuxtLink
              v-if="item.kind === 'draft'"
              :to="`/document-drafts/${item.id}`"
              class="truncate text-sm font-medium text-foreground hover:text-primary"
            >
              {{ item.title || `Untitled draft` }}
            </NuxtLink>
            <a
              v-else-if="item.kind === 'generated' && item.signed_url"
              :href="item.signed_url"
              target="_blank"
              rel="noopener noreferrer"
              class="truncate text-sm font-medium text-foreground hover:text-primary"
            >
              {{ item.file_name || `Document ${item.id.slice(0, 8)}` }}
            </a>
            <span
              v-else-if="item.kind === 'generated'"
              class="truncate text-sm font-medium text-muted-foreground/70"
            >
              {{ item.file_name || `Document ${item.id.slice(0, 8)}` }}
            </span>
            <NuxtLink
              v-else
              :to="`/tax-computations/${item.id}`"
              class="truncate text-sm font-medium text-foreground hover:text-primary"
            >
              {{ item.title || 'Untitled tax computation' }}
            </NuxtLink>
          </p>
          <p class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <!-- Type / status / tax pill — exactly one renders per row. -->
            <span
              v-if="item.kind === 'generated'"
              class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              :class="typeMeta(item).chip"
            >
              {{ typeMeta(item).label }}
            </span>
            <span
              v-else-if="item.kind === 'tax'"
              class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              :class="taxMeta(item).chip"
            >
              {{ taxMeta(item).label }}
            </span>
            <span
              v-else
              class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              :class="statusMeta(item).chip"
            >
              {{ statusMeta(item).label }}
            </span>

            <span>·</span>
            <span class="truncate">{{ authorLabel(item) }}</span>
            <span>·</span>
            <span class="shrink-0">
              {{ relativeTime(
                item.kind === 'generated' ? item.created_at : item.updated_at
              ) }}
            </span>
          </p>
        </div>
      </li>
    </ul>
  </section>
</template>
