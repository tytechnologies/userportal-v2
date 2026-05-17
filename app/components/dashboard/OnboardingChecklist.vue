<script setup lang="ts">
/**
 * Day-1 onboarding checklist — sits between the dashboard hero and
 * NeedsAttentionPanel. Auto-hides once all milestones are clear (and
 * stays hidden permanently after the user dismisses it).
 *
 * Milestones:
 *   1. Set up brokerage      (handled by BrokerageOnboardingHero
 *                              when missing — we render this only AFTER
 *                              the brokerage exists, so step 1 is
 *                              effectively always ✓ when this shows)
 *   2. Invite an agent       → /organization (#TeamInvitations)
 *   3. Add a listing         → /listings/new
 *
 * Dismissal is local-only (localStorage). The user can re-trigger by
 * clearing the key — intentional, since this is meant to disappear
 * once the operator is past day-1.
 */
import { ref, computed, onMounted } from 'vue'
import UiCard from '~/components/ui/UiCard.vue'

type Progress = {
  has_org: boolean
  team_size: number
  listings_count: number
  primary_org_id: string | null
  primary_org_role: string | null
  is_complete: boolean
}

const STORAGE_KEY = 'dashboard.onboarding_dismissed_v1'

const progress = ref<Progress | null>(null)
const loaded = ref(false)
const errored = ref(false)
const dismissed = ref(false)

async function load() {
  errored.value = false
  try {
    const res = await $fetch<Progress>('/api/dashboard/onboarding-progress')
    progress.value = res
  } catch {
    // Silent-self-hide was the prior behavior; surfacing an inline
    // error makes a transient failure visible without spawning a toast.
    progress.value = null
    errored.value = true
  } finally {
    loaded.value = true
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    dismissed.value = window.localStorage.getItem(STORAGE_KEY) === '1'
  }
  if (!dismissed.value) load()
})

function dismiss() {
  dismissed.value = true
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, '1')
  }
}

const visible = computed(() => {
  if (!loaded.value || !progress.value) return false
  if (dismissed.value) return false
  // Don't render if there's no brokerage yet — BrokerageOnboardingHero
  // owns that case.
  if (!progress.value.has_org) return false
  return !progress.value.is_complete
})

const errorVisible = computed(() => loaded.value && errored.value && !dismissed.value)

type Step = {
  key: 'org' | 'team' | 'listing'
  label: string
  description: string
  done: boolean
  ctaLabel: string | null
  ctaTo: string | null
}

const steps = computed<Step[]>(() => {
  const p = progress.value
  if (!p) return []
  return [
    {
      key: 'org',
      label: 'Set up your brokerage',
      description: 'Your workspace is live.',
      done: p.has_org,
      ctaLabel: null,
      ctaTo: null,
    },
    {
      key: 'team',
      label: 'Invite your first agent',
      description:
        p.team_size >= 1
          ? `${p.team_size} teammate${p.team_size === 1 ? '' : 's'} joined.`
          : 'Send an invite from the organization page.',
      done: p.team_size >= 1,
      ctaLabel: p.team_size >= 1 ? 'Manage team' : 'Invite agent',
      ctaTo: '/organization',
    },
    {
      key: 'listing',
      label: 'Add your first listing',
      description:
        p.listings_count >= 1
          ? 'Your listing is live.'
          : 'Get a listing online so inquiries can come in.',
      done: p.listings_count >= 1,
      ctaLabel: p.listings_count >= 1 ? 'View listings' : 'Add listing',
      ctaTo: p.listings_count >= 1 ? '/listings' : '/listings/new',
    },
  ]
})

const completedCount = computed(() => steps.value.filter((s) => s.done).length)
</script>

<template>
  <!-- Error: progress fetch failed. Tiny inline card with retry —
       doesn't hijack the dashboard, but the broker isn't left wondering
       whether their setup actually went through. -->
  <div
    v-if="errorVisible"
    class="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs"
  >
    <span class="text-destructive">⚠</span>
    <span class="flex-1 text-muted-foreground">
      Couldn't load your setup checklist. Refresh or try again.
    </span>
    <button
      type="button"
      class="rounded border border-border bg-card px-2 py-0.5 text-[11px] font-semibold text-foreground hover:bg-accent focus-ring"
      @click="load"
    >
      Retry
    </button>
  </div>

  <UiCard
    v-else-if="visible"
    variant="surface"
    padding="lg"
  >
    <header class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p class="text-eyebrow">Get started</p>
        <h2 class="mt-0.5 text-section-title">Finish setting up your brokerage</h2>
        <p class="mt-1 text-meta">
          {{ completedCount }} of {{ steps.length }} complete — a few more steps and you're operational.
        </p>
      </div>
      <button
        type="button"
        class="self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
        @click="dismiss"
      >
        Dismiss
      </button>
    </header>

    <ol class="space-y-2">
      <li
        v-for="step in steps"
        :key="step.key"
        :class="[
          'flex items-start gap-3 rounded-lg border p-3 transition-colors',
          step.done
            ? 'border-success/30 bg-success/5'
            : 'border-border bg-background',
        ]"
      >
        <span
          :class="[
            'mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
            step.done
              ? 'bg-success text-success-foreground'
              : 'border border-border bg-card text-muted-foreground',
          ]"
          aria-hidden="true"
        >
          {{ step.done ? '✓' : '' }}
        </span>
        <div class="min-w-0 flex-1">
          <p
            :class="[
              'text-sm font-medium',
              step.done ? 'text-foreground' : 'text-foreground',
            ]"
          >
            {{ step.label }}
          </p>
          <p class="mt-0.5 text-meta">{{ step.description }}</p>
        </div>
        <NuxtLink
          v-if="step.ctaTo && step.ctaLabel"
          :to="step.ctaTo"
          :class="[
            'flex-shrink-0 self-center rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
            step.done
              ? 'border border-border bg-card text-foreground hover:bg-accent/40'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          ]"
        >
          {{ step.ctaLabel }}
        </NuxtLink>
      </li>
    </ol>
  </UiCard>
</template>
