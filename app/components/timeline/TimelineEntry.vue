<script setup lang="ts">
// One row in the unified CRM activity timeline. Pure-presentational —
// the parent owns fetching + slicing. Render decisions (label, color,
// metadata subtitle) all come from EVENT_CONFIG so a new action only
// requires a row in the config map, not template changes here.

import { computed } from 'vue'
import type { TimelineEvent } from '~/composables/useTimeline'
import { configFor, COLOR_DOT } from './eventConfig'

const props = defineProps<{
  event: TimelineEvent
  /**
   * Prepend the entity tag (e.g. "Contact · Created") so a feed that
   * mixes types stays readable at a glance. Default true.
   */
  showEntityTag?: boolean
}>()

const config = computed(() => configFor(props.event.action))
const dotClass = computed(() => COLOR_DOT[config.value.color] ?? COLOR_DOT.gray)

const subtitle = computed<string | null>(() => {
  if (!config.value.meta) return null
  try {
    return config.value.meta(props.event.metadata ?? {})
  } catch {
    return null
  }
})

const actorName = computed(() =>
  props.event.actor?.full_name || props.event.actor?.email || null,
)

const entityTag = computed(() => {
  if (props.showEntityTag === false) return null
  const e = props.event.entity
  if (!e) return null
  return e.charAt(0).toUpperCase() + e.slice(1)
})

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}
</script>

<template>
  <li class="relative ml-4 mb-4 last:mb-0">
    <span
      class="absolute -left-[1.4rem] mt-1.5 h-3 w-3 rounded-full ring-4 ring-white"
      :class="dotClass"
      aria-hidden="true"
    />
    <div class="flex items-center gap-2">
      <span v-if="config.icon" aria-hidden="true">{{ config.icon }}</span>
      <p class="text-sm font-medium text-foreground">{{ config.label }}</p>
      <span
        v-if="entityTag"
        class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {{ entityTag }}
      </span>
    </div>
    <p v-if="subtitle" class="mt-0.5 truncate text-xs text-muted-foreground">{{ subtitle }}</p>
    <p class="mt-0.5 text-xs text-muted-foreground">
      {{ formatTimestamp(event.created_at) }}
      <span v-if="actorName" class="text-muted-foreground/70"> · {{ actorName }}</span>
    </p>
  </li>
</template>
