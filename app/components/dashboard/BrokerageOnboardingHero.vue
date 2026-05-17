<script setup lang="ts">
/**
 * First-run dashboard banner shown when the user hasn't created or
 * joined a brokerage yet. Replaces the standard DashboardHero on
 * the day-1 experience so the operator's first beat is "set this up,"
 * not "look at empty widgets."
 *
 * Presentational — the parent (dashboard.vue) decides when to render
 * this vs. DashboardHero based on /api/organizations response.
 *
 * Default state on page load is COLLAPSED — a single-line summary with
 * a chevron toggle. Brokers who want to set up immediately click to
 * expand and see the full description + CTAs. Brokers who're just
 * browsing aren't blocked by a tall banner above the fold.
 *
 * Emits `dismiss` when the user opts out for now. The parent stamps
 * a per-device snooze timestamp; the banner stays hidden until the
 * snooze expires (~2 weeks). If the user creates/joins a brokerage
 * in the meantime, the banner self-resolves and never returns.
 *
 * The CTA goes to /onboarding/setup-brokerage which calls the
 * create_organization_as_owner() RPC.
 */
import { ref } from 'vue'
import UiCard from '~/components/ui/UiCard.vue'

defineEmits<{
  (e: 'dismiss'): void
}>()

// Collapsed on mount per UX spec. Local state, not persisted — every
// dashboard load starts collapsed; the user re-expands on demand.
const expanded = ref(false)
</script>

<template>
  <UiCard
    variant="elevated"
    padding="none"
    class="overflow-hidden"
  >
    <!-- Collapsed header bar — always rendered. Clicking the title
         strip toggles expansion; the Skip button stays clickable
         without toggling. -->
    <div class="flex items-center gap-3 px-5 py-3">
      <button
        type="button"
        class="flex flex-1 items-center gap-3 text-left focus-ring rounded"
        :aria-expanded="expanded"
        aria-controls="brokerage-onboarding-body"
        @click="expanded = !expanded"
      >
        <span class="inline-flex shrink-0 items-center gap-1.5 rounded border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
          Get started
        </span>
        <span class="truncate text-sm font-semibold text-foreground sm:text-base">
          Set up your brokerage
        </span>
        <span
          aria-hidden="true"
          class="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-transform duration-150 ease-out"
          :class="{ 'rotate-180': expanded }"
        >
          <!-- chevron-down -->
          <svg viewBox="0 0 20 20" fill="none" class="h-4 w-4">
            <path d="M5 7.5l5 5 5-5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </button>
      <button
        type="button"
        class="shrink-0 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-ring"
        title="Hide this prompt for a couple of weeks"
        @click.stop="$emit('dismiss')"
      >
        Skip for now
      </button>
    </div>

    <!-- Expanded body — description + primary CTAs. Hidden by default.
         The chevron toggle on the header controls visibility. -->
    <div
      v-show="expanded"
      id="brokerage-onboarding-body"
      class="border-t border-border"
    >
      <div class="grid items-center gap-5 p-5 md:grid-cols-[minmax(0,1fr)_auto]">
        <p class="max-w-xl text-sm text-muted-foreground">
          A brokerage is the workspace your agents share — listings, inquiries, deals, statements,
          and reporting all roll up to it. Takes about a minute. You can change branding later.
        </p>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center md:flex-col md:items-stretch">
          <NuxtLink
            to="/onboarding/setup-brokerage"
            class="btn-primary"
          >
            Create brokerage
            <span aria-hidden="true">→</span>
          </NuxtLink>
          <a
            href="mailto:info@housinginteractive.com.ph?subject=Help%20setting%20up%20my%20brokerage"
            class="btn-secondary"
          >
            Talk to us
          </a>
        </div>
      </div>
    </div>
  </UiCard>
</template>
