<script setup lang="ts">
/**
 * Verifications parent tab — sub-router across the three verification
 * subjects (brokers / listings / buildings).
 *
 * Each sub-tab is the existing or new queue component. Lazy mount via
 * <KeepAlive> so switching back doesn't re-fetch.
 *
 * The parent /admin shell still mounts this single component for
 * the "verifications" tab — no changes to the tab strip there.
 */
import { ref } from 'vue'
import VerificationsQueue from '~/components/admin/VerificationsQueue.vue'
import ListingVerificationsQueue from '~/components/admin/ListingVerificationsQueue.vue'
import BuildingVerificationsQueue from '~/components/admin/BuildingVerificationsQueue.vue'

type SubTab = 'brokers' | 'listings' | 'buildings'

const subtab = ref<SubTab>('brokers')

// Allow deep-linking via /admin?tab=verifications&sub=listings.
const route = useRoute()
const initialSub = (route.query.sub as SubTab | undefined) ?? 'brokers'
if (initialSub === 'brokers' || initialSub === 'listings' || initialSub === 'buildings') {
  subtab.value = initialSub
}
</script>

<template>
  <section class="space-y-4">
    <header>
      <h2 class="text-base font-semibold text-foreground">Verifications</h2>
      <p class="mt-0.5 max-w-3xl text-xs text-muted-foreground">
        Brokers, listings, and buildings each carry their own verified
        badge on the public marketplace. Reviewing here flips the flag on
        <code class="rounded bg-muted-foreground/10 px-1">profile_verifications</code>,
        <code class="rounded bg-muted-foreground/10 px-1">listing_verifications</code>,
        or
        <code class="rounded bg-muted-foreground/10 px-1">building_verifications</code>
        respectively.
      </p>
    </header>

    <!-- Sub-tab strip -->
    <div class="flex gap-1.5 rounded-lg border border-border bg-card p-2">
      <button
        v-for="t in (['brokers', 'listings', 'buildings'] as const)"
        :key="t"
        type="button"
        class="flex-1 rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition-colors"
        :class="
          subtab === t
            ? 'bg-foreground text-background'
            : 'bg-muted-foreground/10 text-foreground/80 hover:bg-muted-foreground/20'
        "
        @click="subtab = t"
      >
        {{ t }}
      </button>
    </div>

    <KeepAlive>
      <VerificationsQueue v-if="subtab === 'brokers'" key="brokers" />
      <ListingVerificationsQueue v-else-if="subtab === 'listings'" key="listings" />
      <BuildingVerificationsQueue v-else key="buildings" />
    </KeepAlive>
  </section>
</template>
