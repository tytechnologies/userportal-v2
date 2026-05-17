<script setup lang="ts">
/**
 * /deals/:id — deal detail page.
 *
 * Sections:
 *   1. Header (title, stage pill, listing link, value)
 *   2. Stage transition controls
 *   3. Participants list + add form
 *   4. Viewings list + schedule form
 *   5. Stage history (audit trail of transitions)
 *   6. Commissions (only rows the caller can see — own row OR
 *      commissions.view.platform)
 *
 * Reads the bundled detail via GET /api/deals/:id which joins
 * participants + viewings + stage_history + listing.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from '~/helpers/helpers'
import DealDocumentsPanel from '~/components/deals/DealDocumentsPanel.vue'
import DealDraftsSection from '~/components/deals/DealDraftsSection.vue'
import DealTasksPanel from '~/components/deals/DealTasksPanel.vue'
import NotesPanel from '~/components/crm/NotesPanel.vue'
import TimelineEntry from '~/components/timeline/TimelineEntry.vue'
import { useTimeline, type TimelineEvent } from '~/composables/useTimeline'
import SetClientModal from '~/components/deals/SetClientModal.vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import DealWorkflowPanel from '~/components/deals/DealWorkflowPanel.vue'
import DealWorkflowKickoffCard from '~/components/deals/DealWorkflowKickoffCard.vue'
import type { Workflow } from '~~/server/repositories/workflows.repo'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const supabase = useSupabaseClient()

const dealId = computed(() => String(route.params.id ?? ''))
const deal = ref<any | null>(null)
const loading = ref(true)
const errorMsg = ref<string | null>(null)

const workflowState = ref<Workflow | null>(null)
const eligibleEnvelopeId = ref<string | null>(null)
const userRole = ref<string>('agent')

async function loadWorkflowState() {
  try {
    workflowState.value = await $fetch<Workflow | null>(`/api/deals/${dealId.value}/workflow`)
  } catch { workflowState.value = null }
}

async function loadEnvelopeEligibility() {
  if (workflowState.value) { eligibleEnvelopeId.value = null; return }
  const { data } = await (supabase as any)
    .from('document_envelopes')
    .select('id')
    .eq('deal_id', dealId.value)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  eligibleEnvelopeId.value = (data?.id as string) ?? null
}

async function loadUserRole() {
  const { data } = await (supabase as any).rpc('current_user_role')
  userRole.value = (data as string) ?? 'agent'
}

const canAbandonWorkflow = computed(
  () => userRole.value === 'admin' || userRole.value === 'manager',
)

const showKickoff = computed(
  () => !workflowState.value && (eligibleEnvelopeId.value !== null || /* manual */ true),
)

const listingForSale = computed<boolean>(() => Boolean(deal.value?.listing?.for_sale))
const listingForRent = computed<boolean>(() => Boolean(deal.value?.listing?.for_rent))

const STAGES = [
  { key: 'inquiry_received',   label: 'Inquiry' },
  { key: 'contacted',          label: 'Contacted' },
  { key: 'viewing_scheduled',  label: 'Viewing scheduled' },
  { key: 'viewing_completed',  label: 'Viewing done' },
  { key: 'negotiating',        label: 'Negotiating' },
  { key: 'reservation',        label: 'Reservation' },
  { key: 'documentation',      label: 'Documentation' },
  { key: 'financing',          label: 'Financing' },
  { key: 'closing',            label: 'Closing' },
  { key: 'closed_won',         label: 'Closed (won)' },
  { key: 'closed_lost',        label: 'Closed (lost)' },
] as const

async function load() {
  if (!dealId.value) return
  loading.value = true
  errorMsg.value = null
  try {
    const data = await $fetch<any>(`/api/deals/${dealId.value}`)
    deal.value = data
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to load deal'
  } finally {
    loading.value = false
  }
}

// Unified activity timeline for the deal — RLS-scoped via the
// activities table policies. Loaded in parallel with the deal so
// the user doesn't wait twice.
const { fetchDealTimeline } = useTimeline()
const timelineEvents = ref<TimelineEvent[]>([])
const timelineLoading = ref(false)

async function loadTimeline() {
  if (!dealId.value) {
    timelineEvents.value = []
    return
  }
  timelineLoading.value = true
  try {
    timelineEvents.value = await fetchDealTimeline(dealId.value, 100)
  } catch {
    timelineEvents.value = []
  } finally {
    timelineLoading.value = false
  }
}

onMounted(async () => {
  load()
  loadTimeline()
  // Workflow state depends on deal loading first only for the `deal.listing.*`
  // flags read by the kickoff card; the workflow + envelope fetches are
  // independent and safe to start in parallel with load().
  await loadWorkflowState()
  await loadEnvelopeEligibility()
  await loadUserRole()
})
watch(dealId, () => { load(); loadTimeline() })

useHead({
  title: () =>
    deal.value?.title
      ? `${deal.value.title} | Deal | Housing Interactive`
      : 'Deal | Housing Interactive',
})

// Client (buyer contact) — set / change / unlink via SetClientModal.
// On success the modal returns the refreshed deal (same shape as
// getById) so we patch local state without a follow-up GET.
const clientModalOpen = ref(false)
function openClientModal() {
  clientModalOpen.value = true
}
function onClientUpdated(payload: { deal: any }) {
  if (payload?.deal) deal.value = payload.deal
}

// Stage transition
const targetStage = ref<string>('')
const stageNote = ref('')
const transitioning = ref(false)
async function applyStage() {
  if (!targetStage.value || !deal.value) return
  transitioning.value = true
  try {
    await $fetch(`/api/deals/${deal.value.id}/stage`, {
      method: 'PATCH',
      body: { stage_key: targetStage.value, note: stageNote.value || undefined },
    })
    showToast({ title: `Moved to ${targetStage.value}`, icon: 'success' })
    targetStage.value = ''
    stageNote.value = ''
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Stage transition failed',
      icon: 'error',
    })
  } finally {
    transitioning.value = false
  }
}

// Add participant. Was: raw uuid input + bp×100 split — unshippable
// for a brokerage owner adding a co-broker. Now: typeahead picker
// resolves a user, percent input (0-100) gets converted to bp×100
// at submit time.
type PartCandidate = {
  id: string
  full_name: string | null
  email: string | null
  avatar_url: string | null
}
const partPicked = ref<PartCandidate | null>(null)
const partSearch = ref('')
const partSearching = ref(false)
const partResults = ref<PartCandidate[]>([])
const partShowResults = ref(false)
const partRole = ref<'buyer_agent' | 'seller_agent' | 'co_broker' | 'referrer'>('co_broker')
const partSplitDisplay = ref<number | null>(null)   // 0–100, friendly percent
const addingParticipant = ref(false)
let partSearchSeq = 0
let partSearchTimer: ReturnType<typeof setTimeout> | null = null

async function runPartSearch() {
  const q = partSearch.value.trim()
  if (q.length < 2) {
    partResults.value = []
    return
  }
  partSearching.value = true
  const seq = ++partSearchSeq
  try {
    const res = await $fetch<{ items: PartCandidate[] }>(
      '/api/profiles/search',
      { query: { q, limit: 8 } },
    )
    if (seq !== partSearchSeq) return
    partResults.value = res.items ?? []
    partShowResults.value = true
  } catch {
    if (seq === partSearchSeq) partResults.value = []
  } finally {
    if (seq === partSearchSeq) partSearching.value = false
  }
}

watch(partSearch, (v) => {
  if (partSearchTimer) clearTimeout(partSearchTimer)
  if (!v.trim()) {
    partResults.value = []
    partShowResults.value = false
    partPicked.value = null
    return
  }
  // Re-typing after selection should clear selection.
  if (partPicked.value && v !== (partPicked.value.full_name || partPicked.value.email || '')) {
    partPicked.value = null
  }
  partSearchTimer = setTimeout(runPartSearch, 220)
})

function pickParticipant(c: PartCandidate) {
  partPicked.value = c
  partSearch.value = c.full_name || c.email || c.id.slice(0, 8)
  partShowResults.value = false
}

async function addParticipant() {
  if (!partPicked.value || !deal.value) return
  addingParticipant.value = true
  try {
    // Convert friendly 0–100 percent to bp×100 stored format.
    // 25.5% → 2550. Null = "no split set."
    const splitMinor =
      partSplitDisplay.value != null && Number.isFinite(partSplitDisplay.value)
        ? Math.round(partSplitDisplay.value * 100)
        : undefined

    await $fetch(`/api/deals/${deal.value.id}/participants`, {
      method: 'POST',
      body: {
        user_id: partPicked.value.id,
        role: partRole.value,
        split_pct: splitMinor,
      },
    })
    showToast({ title: 'Participant added', icon: 'success' })
    partPicked.value = null
    partSearch.value = ''
    partResults.value = []
    partSplitDisplay.value = null
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to add participant',
      icon: 'error',
    })
  } finally {
    addingParticipant.value = false
  }
}

// Schedule viewing
const viewingDate = ref('')
const viewingTime = ref('')
const viewingDuration = ref<number>(60)
const viewingNotes = ref('')
const schedulingViewing = ref(false)
async function scheduleViewing() {
  if (!viewingDate.value || !viewingTime.value || !deal.value) {
    showToast({ title: 'Pick a date and time', icon: 'warning' })
    return
  }
  schedulingViewing.value = true
  try {
    const localIso = new Date(`${viewingDate.value}T${viewingTime.value}`).toISOString()
    await $fetch(`/api/deals/${deal.value.id}/viewings`, {
      method: 'POST',
      body: {
        scheduled_at: localIso,
        duration_minutes: viewingDuration.value,
        notes: viewingNotes.value || undefined,
      },
    })
    showToast({ title: 'Viewing scheduled', icon: 'success' })
    viewingDate.value = ''
    viewingTime.value = ''
    viewingNotes.value = ''
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to schedule',
      icon: 'error',
    })
  } finally {
    schedulingViewing.value = false
  }
}

// Commissions — read directly from public.deal_commissions; RLS
// already filters to (own row OR platform-permission). The detail
// endpoint doesn't bundle commissions because the visibility
// surface is different.
const commissions = ref<any[]>([])
async function loadCommissions() {
  if (!dealId.value) return
  try {
    const { data } = await (supabase as any)
      .from('deal_commissions')
      .select(`
        id, gross_amount, net_amount, currency, status, payable_at, paid_at,
        notes, created_at, user_id,
        user:profiles!deal_commissions_user_id_fkey (id, full_name)
      `)
      .eq('deal_id', dealId.value)
      .order('created_at', { ascending: false })
    commissions.value = data || []
  } catch {
    commissions.value = []
  }
}
onMounted(loadCommissions)
watch(dealId, loadCommissions)

function stageLabel(key: string): string {
  return STAGES.find((s) => s.key === key)?.label || key
}
type StageVariant = 'success' | 'neutral' | 'primary' | 'warning'
function stageVariant(key: string): StageVariant {
  if (key === 'closed_won') return 'success'
  if (key === 'closed_lost') return 'neutral'
  if (['reservation', 'documentation', 'financing', 'closing'].includes(key)) {
    return 'primary'
  }
  if (key === 'negotiating') return 'warning'
  return 'neutral'
}

type ViewingVariant = 'success' | 'neutral' | 'destructive' | 'primary'
function viewingVariant(s: string): ViewingVariant {
  if (s === 'completed') return 'success'
  if (s === 'cancelled') return 'neutral'
  if (s === 'no_show') return 'destructive'
  return 'primary'
}

type CommissionVariant = 'success' | 'primary' | 'destructive' | 'neutral'
function commissionVariant(s: string): CommissionVariant {
  if (s === 'paid') return 'success'
  if (s === 'payable') return 'primary'
  if (s === 'clawback') return 'destructive'
  return 'neutral'
}
function formatTs(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
function formatMoney(amount: number | null, currency = 'PHP'): string {
  if (amount == null) return '—'
  return `${currency} ${Number(amount).toLocaleString()}`
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <NuxtLink
      to="/deals"
      class="inline-flex items-center gap-1 text-meta hover:text-foreground focus-ring rounded"
    >
      <span aria-hidden="true">←</span>
      All deals
    </NuxtLink>

    <UiCard
      v-if="loading"
      padding="md"
      class="text-center text-sm text-muted-foreground py-10"
    >
      Loading deal…
    </UiCard>
    <UiCard
      v-else-if="errorMsg"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-sm text-destructive"
    >
      {{ errorMsg }}
    </UiCard>
    <template v-else-if="deal">
      <!-- Header card -->
      <UiCard padding="md">
        <div class="flex flex-wrap items-baseline gap-3">
          <h1 class="text-page-title">
            {{ deal.title || `Deal ${deal.id.slice(0, 8)}` }}
          </h1>
          <UiBadge :variant="stageVariant(deal.stage_key)" size="sm">
            {{ stageLabel(deal.stage_key) }}
          </UiBadge>
          <NuxtLink
            v-if="deal.listing_id"
            :to="`/listings/${deal.listing_id}`"
            class="text-xs font-mono text-primary hover:underline focus-ring rounded"
          >
            Listing #{{ deal.listing_id }}
          </NuxtLink>
        </div>
        <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <dt class="text-muted-foreground">Listing</dt>
          <dd class="text-foreground truncate">{{ deal.listing?.title || '—' }}</dd>
          <dt class="text-muted-foreground">Buyer agent</dt>
          <dd class="text-foreground">{{ deal.buyer_agent?.full_name || '—' }}</dd>
          <dt class="text-muted-foreground">Deal value</dt>
          <dd class="text-foreground tabular-nums">{{ formatMoney(deal.deal_value, deal.currency) }}</dd>
          <dt class="text-muted-foreground">Stage entered</dt>
          <dd class="text-foreground">{{ formatTs(deal.stage_entered_at) }}</dd>
          <template v-if="deal.closed_at">
            <dt class="text-muted-foreground">Closed</dt>
            <dd class="text-foreground">
              {{ formatTs(deal.closed_at) }}
              <span class="ml-1 text-xs text-muted-foreground">
                ({{ deal.closed_won ? 'won' : 'lost' }})
              </span>
            </dd>
          </template>
        </dl>
        <p
          v-if="deal.notes"
          class="mt-3 rounded-md bg-muted/50 p-2 text-sm text-foreground whitespace-pre-line"
        >
          {{ deal.notes }}
        </p>
      </UiCard>

      <DealWorkflowPanel
        v-if="workflowState"
        :deal-id="dealId"
        :can-abandon="canAbandonWorkflow"
        @workflow-changed="() => { loadWorkflowState(); loadEnvelopeEligibility() }"
      />
      <DealWorkflowKickoffCard
        v-else-if="showKickoff && deal"
        :deal-id="dealId"
        :listing-for-sale="listingForSale"
        :listing-for-rent="listingForRent"
        :eligible-envelope-id="eligibleEnvelopeId"
        @started="() => { loadWorkflowState(); loadEnvelopeEligibility() }"
      />

      <!-- Client (buyer contact) — promotes the inquiry's lead into a
           CRM contact + makes the relationship explicit on the deal.
           When unset, this is the operator's first action; when set,
           drilldowns into /contacts/[id] live here too. -->
      <UiCard padding="md">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="text-card-title">Client</h2>
          <button
            type="button"
            class="text-xs font-medium text-primary hover:underline focus-ring rounded"
            @click="openClientModal"
          >
            {{ deal.buyer_contact ? 'Change' : 'Set client' }}
          </button>
        </div>

        <div v-if="deal.buyer_contact" class="mt-3 flex items-start gap-3">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {{ (deal.buyer_contact.full_name || '?').trim().charAt(0).toUpperCase() }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2">
              <NuxtLink
                :to="`/contacts/${deal.buyer_contact.id}`"
                class="truncate text-sm font-semibold text-foreground hover:underline focus-ring rounded"
              >
                {{ deal.buyer_contact.full_name || `Contact #${deal.buyer_contact.id}` }}
              </NuxtLink>
              <UiBadge variant="primary" size="xs">Buyer</UiBadge>
            </p>
            <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              <a
                v-if="deal.buyer_contact.email"
                :href="`mailto:${deal.buyer_contact.email}`"
                class="text-primary hover:underline"
              >
                {{ deal.buyer_contact.email }}
              </a>
              <a
                v-if="deal.buyer_contact.mobile_phone"
                :href="`tel:${deal.buyer_contact.mobile_phone}`"
                class="text-primary hover:underline"
              >
                {{ deal.buyer_contact.mobile_phone }}
              </a>
              <span
                v-if="!deal.buyer_contact.email && !deal.buyer_contact.mobile_phone"
                class="text-muted-foreground"
              >
                No contact info on file
              </span>
            </div>
          </div>
        </div>

        <div v-else class="mt-3 rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground">
          No client linked yet. Without a client, the deal exists but the buyer is invisible to the rest of the team.
          <button
            type="button"
            class="ml-1 font-medium text-primary hover:underline focus-ring rounded"
            @click="openClientModal"
          >
            Set client →
          </button>
        </div>
      </UiCard>

      <!-- Stage transition -->
      <UiCard padding="md">
        <h2 class="mb-3 text-card-title">Move to next stage</h2>
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex flex-col">
            <span class="text-xs font-semibold text-foreground">New stage</span>
            <select
              v-model="targetStage"
              class="mt-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm focus-ring"
            >
              <option value="">Pick a stage…</option>
              <option v-for="s in STAGES" :key="s.key" :value="s.key">
                {{ s.label }}
              </option>
            </select>
          </label>
          <label class="flex flex-1 flex-col min-w-[200px]">
            <span class="text-xs font-semibold text-foreground">Note (optional)</span>
            <input
              v-model="stageNote"
              type="text"
              maxlength="500"
              class="mt-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm focus-ring"
              placeholder="Why this transition?"
            />
          </label>
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:opacity-50"
            :disabled="!targetStage || transitioning"
            @click="applyStage"
          >
            {{ transitioning ? 'Moving…' : 'Apply' }}
          </button>
        </div>
      </UiCard>

      <!-- Participants -->
      <UiCard padding="md">
        <h2 class="mb-3 text-card-title">Participants</h2>
        <ul v-if="(deal.participants || []).length > 0" class="space-y-2">
          <li
            v-for="p in deal.participants"
            :key="p.id"
            class="flex flex-wrap items-baseline gap-2 rounded-md border border-border bg-muted/40 p-2"
          >
            <p class="text-sm font-semibold text-foreground">
              {{ p.user?.full_name || p.notes || '—' }}
            </p>
            <UiBadge variant="primary" size="xs">
              {{ p.role }}
            </UiBadge>
            <span
              v-if="p.split_pct != null"
              class="text-xs text-muted-foreground tabular-nums"
              :title="'Split in basis points × 100'"
            >
              {{ (p.split_pct / 100).toFixed(2) }}%
            </span>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">No participants yet.</p>

        <div class="mt-3 border-t border-border pt-3">
          <p class="mb-2 text-xs font-semibold text-foreground">Add participant</p>
          <div class="flex flex-wrap items-end gap-2">
            <!-- Typeahead search → resolves to a real profile row -->
            <div class="relative flex-1 min-w-[240px]">
              <label class="sr-only" for="part-search">Search teammates</label>
              <input
                id="part-search"
                v-model="partSearch"
                type="text"
                autocomplete="off"
                placeholder="Search teammates by name or email…"
                class="w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs focus-ring"
                @focus="partShowResults = partResults.length > 0"
              />
              <ul
                v-if="partShowResults && partResults.length > 0"
                class="absolute left-0 right-0 z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover shadow-lg"
              >
                <li v-for="r in partResults" :key="r.id">
                  <button
                    type="button"
                    class="block w-full px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
                    @click="pickParticipant(r)"
                  >
                    <span class="block truncate font-medium">{{ r.full_name || r.email || `Profile ${r.id.slice(0, 8)}…` }}</span>
                    <span v-if="r.email && r.full_name" class="block truncate text-[10px] text-muted-foreground">{{ r.email }}</span>
                  </button>
                </li>
              </ul>
              <p v-if="partSearching" class="mt-1 text-[10px] text-muted-foreground">Searching…</p>
              <p v-else-if="partPicked" class="mt-1 text-[10px] text-success">
                ✓ {{ partPicked.full_name || partPicked.email }}
              </p>
              <p v-else-if="partSearch.length >= 2 && partResults.length === 0 && !partSearching" class="mt-1 text-[10px] text-muted-foreground">
                No teammates match.
              </p>
            </div>
            <select
              v-model="partRole"
              class="rounded-md border border-border bg-card px-2 py-1.5 text-xs focus-ring"
            >
              <option value="co_broker">Co-broker</option>
              <option value="referrer">Referrer</option>
              <option value="buyer_agent">Buyer agent</option>
              <option value="seller_agent">Seller agent</option>
            </select>
            <!-- Friendly percent (0–100) — converted to bp×100 at submit. -->
            <label class="flex items-center gap-1">
              <span class="sr-only">Split percent</span>
              <input
                v-model.number="partSplitDisplay"
                type="number"
                min="0"
                max="100"
                step="0.01"
                placeholder="Split"
                class="w-24 rounded-md border border-border bg-card px-3 py-1.5 text-xs focus-ring"
              />
              <span class="text-xs text-muted-foreground">%</span>
            </label>
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:opacity-50"
              :disabled="!partPicked || addingParticipant"
              @click="addParticipant"
            >
              <span v-if="addingParticipant">Adding…</span>
              <span v-else>Add</span>
            </button>
          </div>
        </div>
      </UiCard>

      <!-- Viewings -->
      <UiCard padding="md">
        <h2 class="mb-3 text-card-title">Viewings</h2>
        <ul v-if="(deal.viewings || []).length > 0" class="space-y-2">
          <li
            v-for="v in deal.viewings"
            :key="v.id"
            class="rounded-md border border-border bg-muted/40 p-2"
          >
            <div class="flex flex-wrap items-baseline gap-2">
              <p class="text-sm font-semibold text-foreground">
                {{ formatTs(v.scheduled_at) }}
              </p>
              <span class="text-xs text-muted-foreground">
                {{ v.duration_minutes }} min
              </span>
              <UiBadge :variant="viewingVariant(v.status)" size="xs">
                {{ v.status }}
              </UiBadge>
              <span
                v-if="v.attending"
                class="ml-auto text-xs text-muted-foreground"
              >
                Attending: {{ v.attending.full_name }}
              </span>
            </div>
            <p
              v-if="v.notes"
              class="mt-1 text-xs text-foreground"
            >
              {{ v.notes }}
            </p>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">No viewings scheduled.</p>

        <div class="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <input
            v-model="viewingDate"
            type="date"
            class="rounded-md border border-border bg-card px-3 py-1.5 text-xs focus-ring"
          />
          <input
            v-model="viewingTime"
            type="time"
            class="rounded-md border border-border bg-card px-3 py-1.5 text-xs focus-ring"
          />
          <input
            v-model.number="viewingDuration"
            type="number"
            min="15"
            max="480"
            placeholder="Duration (min)"
            class="w-32 rounded-md border border-border bg-card px-3 py-1.5 text-xs focus-ring"
          />
          <input
            v-model="viewingNotes"
            type="text"
            placeholder="Notes (optional)"
            maxlength="500"
            class="flex-1 min-w-[180px] rounded-md border border-border bg-card px-3 py-1.5 text-xs focus-ring"
          />
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:opacity-50"
            :disabled="!viewingDate || !viewingTime || schedulingViewing"
            @click="scheduleViewing"
          >
            Schedule
          </button>
        </div>
      </UiCard>

      <!-- Tasks — auto-generated by stage transitions + manual
           follow-ups. Drives the daily reminder cron + dashboard
           overdue widget. -->
      <DealTasksPanel :deal-id="deal.id" />

      <!-- Document drafts — templates the broker generated against
           this deal's listing or buyer contact. Click a row to drill
           into the editor; "+ Generate document" pre-fills both ids
           on the new-draft picker. Companion to DealDocumentsPanel,
           which surfaces uploaded files from the legacy `documents`
           table (RLS-scoped to deal participants). Brokers don't
           need to know which storage shape was used; both render. -->
      <DealDraftsSection
        :deal-id="deal.id"
        :listing-id="deal.listing_id ?? null"
        :contact-id="deal.buyer_contact?.id ?? null"
      />
      <DealDocumentsPanel :deal-id="deal.id" />

      <!-- Notes about this client. Scoped by buyer_contact.id so the
           same notes show up on the contact detail page — broker writes
           "spoke with Maria, prefers BGC" once and it appears anywhere
           Maria is referenced. Hidden when no buyer is linked, since
           there's no entity to scope the notes to. -->
      <section
        v-if="deal.buyer_contact"
        class="rounded-lg border border-border bg-card p-4"
      >
        <h2 class="mb-3 text-card-title">
          Notes about
          <NuxtLink
            :to="`/contacts/${deal.buyer_contact.id}`"
            class="text-primary hover:underline focus-ring rounded"
          >
            {{ deal.buyer_contact.full_name || `Contact #${deal.buyer_contact.id}` }}
          </NuxtLink>
        </h2>
        <NotesPanel :contact-id="deal.buyer_contact.id" />
      </section>

      <!-- Unified activity timeline. Aggregates every audit event
           that stamps deal_id (or has entity = deal). Includes the
           stage transitions below it, viewings scheduled/completed,
           document drafts created, participant adds, etc. — one
           chronological feed for "what's happened on this deal." -->
      <UiCard padding="md">
        <h2 class="mb-3 text-card-title">Activity</h2>
        <div v-if="timelineLoading" class="space-y-2">
          <div
            v-for="n in 3"
            :key="n"
            class="h-3 w-2/3 animate-pulse rounded bg-muted"
          />
        </div>
        <p
          v-else-if="timelineEvents.length === 0"
          class="text-xs text-muted-foreground"
        >
          No activity logged yet. Stage transitions, viewings, and
          document changes will appear here as the deal moves.
        </p>
        <ol v-else class="relative ml-2 border-l border-border">
          <TimelineEntry
            v-for="event in timelineEvents"
            :key="event.id"
            :event="event"
          />
        </ol>
      </UiCard>

      <!-- Stage history -->
      <UiCard
        v-if="(deal.stage_history || []).length > 0"
        padding="md"
      >
        <h2 class="mb-3 text-card-title">Stage history</h2>
        <ol class="space-y-1.5">
          <li
            v-for="h in [...deal.stage_history].sort((a, b) => new Date(b.entered_at).getTime() - new Date(a.entered_at).getTime())"
            :key="h.id"
            class="flex flex-wrap items-baseline gap-2 text-xs text-foreground"
          >
            <span v-if="h.from_stage" class="text-muted-foreground">
              {{ h.from_stage }}
            </span>
            <span v-if="h.from_stage" aria-hidden="true">→</span>
            <span class="font-semibold">{{ h.to_stage }}</span>
            <span class="ml-auto text-muted-foreground">
              {{ formatTs(h.entered_at) }}
            </span>
          </li>
        </ol>
      </UiCard>

      <!-- Commissions -->
      <UiCard
        v-if="commissions.length > 0"
        padding="md"
      >
        <h2 class="mb-3 text-card-title">
          Commissions
          <span class="ml-2 text-xs font-normal text-muted-foreground">
            (only your own row visible unless you have platform-wide visibility)
          </span>
        </h2>
        <table class="w-full text-sm">
          <thead class="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th class="px-2 py-1 text-left">Recipient</th>
              <th class="px-2 py-1 text-left">Gross</th>
              <th class="px-2 py-1 text-left">Net</th>
              <th class="px-2 py-1 text-left">Status</th>
              <th class="px-2 py-1 text-left">Paid</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in commissions"
              :key="c.id"
              class="border-t border-border"
            >
              <td class="px-2 py-1.5">{{ c.user?.full_name || '—' }}</td>
              <td class="px-2 py-1.5 tabular-nums">{{ formatMoney(c.gross_amount, c.currency) }}</td>
              <td class="px-2 py-1.5 tabular-nums">{{ formatMoney(c.net_amount, c.currency) }}</td>
              <td class="px-2 py-1.5">
                <UiBadge :variant="commissionVariant(c.status)" size="xs">
                  {{ c.status }}
                </UiBadge>
              </td>
              <td class="px-2 py-1.5 text-xs text-muted-foreground">{{ formatTs(c.paid_at) }}</td>
            </tr>
          </tbody>
        </table>
      </UiCard>
    </template>

    <!-- Set / change / unlink the buyer contact (client) on the deal. -->
    <SetClientModal
      v-if="deal"
      :open="clientModalOpen"
      :deal-id="deal.id"
      :has-existing-buyer="!!deal.buyer_contact"
      @update:open="clientModalOpen = $event"
      @updated="onClientUpdated"
    />
  </AdminPageShell>
</template>
