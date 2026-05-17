<script setup lang="ts">
// One-click "new anything" strip for the dashboard. Each card links to
// the corresponding entity's create surface; query params trigger the
// in-page modal pattern that those pages already support so users
// don't bounce through an intermediate index.
//
// Permission gating is light — the portal's RBAC checks happen on the
// destination pages, so a user who can't create a listing still sees
// the link but gets the gated UI on /listings. Hiding the cards by
// permission is a Phase E refinement.

const actions = [
  {
    label: 'New listing',
    sub: 'Add a property',
    icon: '🏠',
    to: { path: '/listings/new' },
    accent: 'from-blue-500 to-blue-600',
    chip: 'bg-primary/10 text-primary',
  },
  {
    label: 'New contact',
    sub: 'Capture a lead',
    icon: '👤',
    to: { path: '/contacts', query: { new: '1' } },
    accent: 'from-emerald-500 to-emerald-600',
    chip: 'bg-success/15 text-success',
  },
  {
    label: 'New document',
    sub: 'Pick a template',
    icon: '📄',
    to: { path: '/document-drafts/new' },
    accent: 'from-purple-500 to-purple-600',
    chip: 'bg-primary/10 text-primary',
  },
  {
    label: 'View tasks',
    sub: 'Triage your queue',
    icon: '✅',
    to: { path: '/tasks', query: { assigned: 'me' } },
    accent: 'from-amber-500 to-amber-600',
    chip: 'bg-warning/15 text-warning',
  },
]
</script>

<template>
  <section class="grid gap-3 px-6 py-2 sm:grid-cols-2 lg:grid-cols-4">
    <NuxtLink
      v-for="a in actions"
      :key="a.label"
      :to="a.to"
      class="group relative flex items-center gap-3 overflow-hidden rounded-xl border border-border bg-background p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div :class="['absolute inset-y-0 left-0 w-1 bg-gradient-to-b', a.accent]" />
      <span :class="['flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl', a.chip]">
        {{ a.icon }}
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-foreground">{{ a.label }}</p>
        <p class="text-xs text-muted-foreground">{{ a.sub }}</p>
      </div>
      <span class="text-xs text-foreground transition-colors group-hover:text-muted-foreground">→</span>
    </NuxtLink>
  </section>
</template>
