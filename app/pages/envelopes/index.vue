<script setup lang="ts">
/**
 * /envelopes — list view of multi-party signing envelopes.
 *
 * Status tabs filter the list; "Send for signature" CTA in the header
 * routes to /envelopes/new where the user picks documents + recipients
 * before sending.
 */
import { computed, onMounted, ref, watch } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiTabBar from '~/components/ui/UiTabBar.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'
import {
  useEnvelopes,
  ENVELOPE_STATUS_LABEL,
  envelopeStatusVariant,
  type Envelope,
  type EnvelopeStatus,
} from '~/composables/useEnvelopes'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Envelopes | Housing Interactive' })

const api = useEnvelopes()

type StatusTab = EnvelopeStatus | 'all'
const STATUS_TABS = [
  { value: 'all',         label: 'All' },
  { value: 'draft',       label: 'Draft' },
  { value: 'sent',        label: 'Sent' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed',   label: 'Completed' },
  { value: 'declined',    label: 'Declined' },
  { value: 'voided',      label: 'Voided' },
] as const

const activeStatus = ref<StatusTab>('all')
const envelopes = ref<Envelope[]>([])
const isLoading = ref(true)
const errorMsg = ref<string | null>(null)

async function load() {
  isLoading.value = true
  errorMsg.value = null
  try {
    const res = await api.list({
      status: activeStatus.value === 'all' ? undefined : (activeStatus.value as EnvelopeStatus),
    })
    envelopes.value = res.items
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to load envelopes'
  } finally {
    isLoading.value = false
  }
}

onMounted(load)
watch(activeStatus, load)

function fmt(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch { return '—' }
}

const counts = computed(() => {
  const c: Record<string, number> = { all: envelopes.value.length }
  for (const e of envelopes.value) c[e.status] = (c[e.status] ?? 0) + 1
  return c
})
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <UiPageHeader
      title="Envelopes"
      description="Multi-party signing workflows. Each envelope groups one or more documents and the recipients who need to sign."
    >
      <template #actions>
        <NuxtLink
          to="/envelopes/new"
          class="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <span aria-hidden="true">+</span>
          Send for signature
        </NuxtLink>
      </template>
    </UiPageHeader>

    <UiTabBar
      v-model="activeStatus"
      :tabs="STATUS_TABS as any"
      variant="underline"
      :underline-full="true"
      aria-label="Envelope status"
    />

    <UiCard v-if="isLoading" padding="none">
      <div v-for="n in 4" :key="n" class="space-y-1.5 border-b border-border px-5 py-4 last:border-0">
        <div class="flex items-baseline justify-between gap-2">
          <UiSkeleton class="h-3 w-1/3" />
          <UiSkeleton class="h-3 w-16" />
        </div>
        <UiSkeleton class="h-2 w-2/3" />
      </div>
    </UiCard>

    <UiCard
      v-else-if="errorMsg"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-sm text-destructive"
    >
      {{ errorMsg }}
    </UiCard>

    <UiCard v-else-if="envelopes.length === 0" padding="lg">
      <div class="mx-auto max-w-md py-6 text-center">
        <h3 class="text-lg font-semibold text-foreground">
          {{ activeStatus === 'all' ? 'No envelopes yet' : `No ${ENVELOPE_STATUS_LABEL[activeStatus as EnvelopeStatus]?.toLowerCase() ?? activeStatus} envelopes` }}
        </h3>
        <p class="mt-2 text-sm text-muted-foreground">
          Send a contract or any document for signature — pick recipients, attach drafts, and we'll deliver the signing links.
        </p>
        <div class="mt-5 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
          <NuxtLink
            to="/envelopes/new"
            class="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Send for signature
            <span aria-hidden="true">→</span>
          </NuxtLink>
          <NuxtLink
            to="/document-drafts"
            class="inline-flex items-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent/40"
          >
            Browse drafts
          </NuxtLink>
        </div>
      </div>
    </UiCard>

    <UiCard v-else padding="none">
      <ul class="divide-y divide-border">
        <li
          v-for="e in envelopes"
          :key="e.id"
          class="px-5 py-4 transition-colors hover:bg-accent/30"
        >
          <NuxtLink :to="`/envelopes/${e.id}`" class="block">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-baseline gap-2">
                  <span class="truncate text-sm font-semibold text-foreground">
                    {{ e.title || 'Untitled envelope' }}
                  </span>
                  <UiBadge :variant="envelopeStatusVariant(e.status)" size="xs">
                    {{ ENVELOPE_STATUS_LABEL[e.status] }}
                  </UiBadge>
                  <span class="text-xs text-muted-foreground capitalize">
                    {{ e.routing_kind }}
                  </span>
                </p>
                <p v-if="e.message" class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {{ e.message }}
                </p>
                <p class="mt-1 text-xs text-muted-foreground">
                  Created {{ fmt(e.created_at) }}
                  <span v-if="e.sent_at"> · Sent {{ fmt(e.sent_at) }}</span>
                  <span v-if="e.completed_at"> · Completed {{ fmt(e.completed_at) }}</span>
                </p>
              </div>
              <span aria-hidden="true" class="text-meta">→</span>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </UiCard>
  </AdminPageShell>
</template>
