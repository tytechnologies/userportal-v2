<script setup lang="ts">
/**
 * Dashboard hero — compact greeting + operational summary + CTAs
 * (Operations palette).
 *
 * Replaces the editorial-era brass-rule hero with a tight enterprise
 * banner: name on the left, attention status pill, primary CTAs on
 * the right. No serif display moment, no decorative rules. Reads as
 * a workspace header, not a magazine cover.
 *
 * Reads the attention count via prop (parent page already fetches
 * it for the panel below); no second round-trip.
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useDisplayUser } from '~/composables/useDisplayUser'
import Plus from 'vue-material-design-icons/Plus.vue'
import ContentCopy from 'vue-material-design-icons/ContentCopy.vue'
import Bell from 'vue-material-design-icons/Bell.vue'

const props = defineProps<{
  /** Total operational items needing review across all attention buckets. */
  attentionCount: number
  /** True until the attention endpoint resolves. Suppresses count rendering. */
  loading?: boolean
}>()

const router = useRouter()
const display = useDisplayUser()

// First word of the resolved display name.
const firstName = computed(() => {
  const name = display.value?.name
  if (!name || name === 'Guest') return null
  const first = name.split(' ')[0]?.trim()
  return first && first.length > 0 ? first : name
})

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
})

const todayLabel = computed(() =>
  new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }),
)

const summaryTone = computed<'warning' | 'success' | 'neutral'>(() => {
  if (props.loading) return 'neutral'
  return props.attentionCount > 0 ? 'warning' : 'success'
})

function gotoImport() {
  router.push({ path: '/admin', query: { tab: 'listing-import' } })
}
function gotoDuplicates() {
  router.push({ path: '/admin', query: { tab: 'duplicates' } })
}
function gotoOps() {
  router.push('/admin/operations')
}
</script>

<template>
  <section
    class="ui-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
    aria-label="Dashboard hero"
  >
    <div class="min-w-0">
      <p class="text-eyebrow">{{ todayLabel }}</p>
      <h1 class="mt-1 text-page-title">
        {{ greeting }}<span v-if="firstName">, {{ firstName }}</span>
      </h1>
      <div class="mt-2 flex items-center gap-2">
        <span
          v-if="!loading"
          :class="[
            'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium',
            summaryTone === 'warning'
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-success/25 bg-success/10 text-success',
          ]"
        >
          <span
            :class="[
              'h-1.5 w-1.5 rounded-full',
              summaryTone === 'warning' ? 'bg-warning' : 'bg-success',
            ]"
            aria-hidden="true"
          />
          <template v-if="summaryTone === 'warning'">
            {{ attentionCount.toLocaleString() }} need{{ attentionCount === 1 ? 's' : '' }} attention
          </template>
          <template v-else>All clear</template>
        </span>
        <span v-else class="text-meta">Loading status…</span>
      </div>
    </div>

    <!-- Primary CTAs. Single-accent palette: one solid primary
         button + two outline buttons. No brass moment. -->
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <button
        type="button"
        class="btn-primary"
        @click="gotoImport"
      >
        <Plus :size="16" />
        Import listings
      </button>
      <button
        type="button"
        class="btn-secondary"
        @click="gotoDuplicates"
      >
        <ContentCopy :size="16" />
        Review duplicates
      </button>
      <button
        type="button"
        class="btn-secondary"
        @click="gotoOps"
      >
        <Bell :size="16" />
        View alerts
      </button>
    </div>
  </section>
</template>
