<script setup lang="ts">
/**
 * Review-submission modal.
 *
 * POSTs /api/reviews. Idempotent on the (reviewer × target) key, so
 * a user re-opening the modal on a target they've already reviewed
 * receives an UPSERT — the form pre-loads their existing review
 * via a GET-then-prefill pattern (the parent passes an existing
 * review prop when relevant).
 *
 * Star rating: overall 1.0–5.0 in 0.5 increments. Per-dimension
 * sliders for the five allowlisted axes; user can leave dimensions
 * empty (overall rating still required).
 *
 * Self-review is blocked DB-side (reviews_validate trigger).
 * The form layer adds a softer client-side hint when target_id
 * matches the current user's id, but the trigger is the real gate.
 */
import { ref, computed, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import { useDisplayUser } from '~/composables/useDisplayUser'

type TargetType = 'agent' | 'building' | 'developer' | 'listing' | 'owner'

const props = defineProps<{
  open: boolean
  targetType: TargetType
  targetId: string
  targetLabel?: string | null   // e.g. agent's name, building name
  existingReview?: {
    rating: number
    title: string | null
    body: string
    dimensions: Record<string, number>
    reviewer_display: 'full_name' | 'initials_only' | 'hidden'
  } | null
}>()

const emit = defineEmits<{
  close: []
  submitted: [reviewId: string]
}>()

const me = useDisplayUser()

// Allowlist mirrors the server-side ALLOWED_DIMENSION_KEYS set.
const DIMENSIONS: { key: string; label: string }[] = [
  { key: 'responsiveness', label: 'Responsiveness' },
  { key: 'professionalism', label: 'Professionalism' },
  { key: 'accuracy', label: 'Accuracy' },
  { key: 'transparency', label: 'Transparency' },
  { key: 'property_condition', label: 'Property condition' },
]

const rating = ref<number>(0)
const title = ref('')
const body = ref('')
const dimensions = ref<Record<string, number>>({})
const reviewerDisplay = ref<'full_name' | 'initials_only' | 'hidden'>('full_name')
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

watch(
  () => [props.open, props.existingReview] as const,
  ([open, existing]) => {
    if (!open) return
    errorMsg.value = null
    if (existing) {
      rating.value = existing.rating
      title.value = existing.title ?? ''
      body.value = existing.body
      dimensions.value = { ...existing.dimensions }
      reviewerDisplay.value = existing.reviewer_display
    } else {
      rating.value = 0
      title.value = ''
      body.value = ''
      dimensions.value = {}
      reviewerDisplay.value = 'full_name'
    }
  },
  { immediate: true },
)

const isSelfReview = computed(() => {
  if (!me.value?.id) return false
  if (props.targetType !== 'agent' && props.targetType !== 'owner') return false
  return props.targetId === me.value.id
})

const canSubmit = computed(() =>
  !submitting.value
  && !isSelfReview.value
  && rating.value >= 1.0
  && body.value.trim().length > 0,
)

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  errorMsg.value = null
  try {
    const res = await $fetch<{ id: string }>(
      '/api/reviews',
      {
        method: 'POST',
        body: {
          target_type: props.targetType,
          target_id: props.targetId,
          rating: rating.value,
          title: title.value.trim() || null,
          body: body.value.trim(),
          dimensions: dimensions.value,
          reviewer_display: reviewerDisplay.value,
        },
      },
    )
    showToast({
      title: props.existingReview ? 'Review updated' : 'Review posted',
      icon: 'success',
    })
    emit('submitted', res.id)
    emit('close')
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to submit review'
  } finally {
    submitting.value = false
  }
}

function setRating(value: number) {
  rating.value = value
}
function setDimension(key: string, value: number) {
  dimensions.value = { ...dimensions.value, [key]: value }
}
function clearDimension(key: string) {
  const next = { ...dimensions.value }
  delete next[key]
  dimensions.value = next
}

const STAR_VALUES = [1, 2, 3, 4, 5]
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[60]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-modal-title"
    >
      <div class="absolute inset-0 bg-foreground/50" @click="emit('close')" />
      <div
        class="absolute left-1/2 top-1/2 w-[min(560px,95vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-card shadow-2xl"
      >
        <header class="flex items-center justify-between border-b border-border px-5 py-4">
          <div class="min-w-0">
            <h2 id="review-modal-title" class="text-base font-semibold text-foreground">
              {{ existingReview ? 'Edit your review' : 'Write a review' }}
            </h2>
            <p
              v-if="targetLabel"
              class="mt-0.5 truncate text-xs text-muted-foreground"
              :title="targetLabel ?? ''"
            >
              {{ targetType }}: {{ targetLabel }}
            </p>
          </div>
          <button
            type="button"
            class="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Close"
            @click="emit('close')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div class="space-y-4 px-5 py-4">
          <p
            v-if="isSelfReview"
            class="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
          >
            You can't review yourself.
          </p>

          <!-- Overall rating -->
          <div>
            <label class="block text-xs font-semibold text-foreground">
              Overall rating <span class="text-destructive">*</span>
            </label>
            <div class="mt-1 flex items-center gap-1">
              <template v-for="v in STAR_VALUES" :key="v">
                <button
                  type="button"
                  class="text-2xl leading-none"
                  :class="rating >= v ? 'text-warning' : 'text-foreground hover:text-warning/70'"
                  :aria-label="`${v} stars`"
                  @click="setRating(v)"
                >
                  â˜…
                </button>
              </template>
              <span class="ml-2 text-xs text-muted-foreground">
                {{ rating ? rating.toFixed(1) : '—' }} / 5.0
              </span>
            </div>
          </div>

          <!-- Title (optional) -->
          <div>
            <label class="block text-xs font-semibold text-foreground">
              Title <span class="text-muted-foreground/70">(optional)</span>
            </label>
            <input
              v-model="title"
              type="text"
              maxlength="200"
              placeholder="Quick summary of your experience"
              class="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </div>

          <!-- Body (required) -->
          <div>
            <label class="block text-xs font-semibold text-foreground">
              Your review <span class="text-destructive">*</span>
            </label>
            <textarea
              v-model="body"
              rows="5"
              maxlength="5000"
              placeholder="What was the experience like? Concrete details help others."
              class="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            <p class="mt-0.5 text-xs text-muted-foreground">
              {{ body.length }} / 5000
            </p>
          </div>

          <!-- Per-dimension breakdown (optional) -->
          <details class="rounded-md border border-border bg-muted/50 p-2">
            <summary class="cursor-pointer text-xs font-semibold text-foreground">
              Rate specific aspects (optional)
            </summary>
            <div class="mt-3 space-y-2">
              <div
                v-for="d in DIMENSIONS"
                :key="d.key"
                class="flex items-center gap-2"
              >
                <span class="w-32 text-xs text-foreground">{{ d.label }}</span>
                <div class="flex items-center gap-1">
                  <button
                    v-for="v in STAR_VALUES"
                    :key="v"
                    type="button"
                    class="text-base leading-none"
                    :class="(dimensions[d.key] ?? 0) >= v ? 'text-warning' : 'text-foreground hover:text-warning/70'"
                    @click="setDimension(d.key, v)"
                  >
                    â˜…
                  </button>
                </div>
                <button
                  v-if="dimensions[d.key] !== undefined"
                  type="button"
                  class="ml-auto text-[10px] text-muted-foreground hover:underline"
                  @click="clearDimension(d.key)"
                >
                  clear
                </button>
              </div>
            </div>
          </details>

          <!-- Privacy -->
          <div>
            <label class="block text-xs font-semibold text-foreground">
              How should your name appear?
            </label>
            <select
              v-model="reviewerDisplay"
              class="mt-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            >
              <option value="full_name">Full name</option>
              <option value="initials_only">Initials only</option>
              <option value="hidden">Hidden (anonymous)</option>
            </select>
          </div>

          <p
            v-if="errorMsg"
            class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {{ errorMsg }}
          </p>
        </div>

        <footer class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            class="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:opacity-50"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ submitting ? 'Posting…' : (existingReview ? 'Update review' : 'Post review') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
