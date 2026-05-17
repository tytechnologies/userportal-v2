<script setup lang="ts">
/**
 * Admin tab — preview a saved-search digest email.
 *
 * Two modes (toggle):
 *   1. Ad-hoc — operator pastes a filters JSON object + an optional
 *      recipient name and "since N days" lookback. Useful for testing
 *      a new filter shape before any subscriber actually has it.
 *   2. Subscription — operator pastes a subscription UUID. Reads the
 *      live row's filters / name / last_digest_sent_at.
 *
 * Backed by /api/admin/saved-searches/preview which is side-effect-
 * free (no last_digest_sent_at stamp, no email queued, no audit). Safe
 * to spam.
 *
 * Email HTML renders inside a sandboxed iframe via `srcdoc` so the
 * preview is visually accurate but cannot escape the page.
 */
import { ref, nextTick } from 'vue'
import { showToast } from '~/helpers/helpers'

type Match = Record<string, unknown>
type PreviewResponse = {
  mode: 'subscription' | 'ad_hoc'
  since: string
  match_count: number
  matches: Match[]
  subject: string
  html: string
  would_skip: boolean
}

const mode = ref<'ad_hoc' | 'subscription'>('ad_hoc')
const subscriptionId = ref('')

// Default to a useful starter object so the operator has something to
// edit on first render. Picked up from the existing filter contract:
// city_slug + transaction_type are the most common filters.
const filtersJson = ref(
  JSON.stringify(
    { city_slug: 'makati', transaction_type: 'sale' },
    null,
    2,
  ),
)
const recipientName = ref('')
const sinceDays = ref(7)

const result = ref<PreviewResponse | null>(null)
const submitting = ref(false)
const errorMsg = ref<string | null>(null)
const iframeRef = ref<HTMLIFrameElement | null>(null)

async function submit() {
  errorMsg.value = null
  submitting.value = true
  result.value = null
  try {
    const body: Record<string, unknown> = {}
    if (mode.value === 'subscription') {
      const id = subscriptionId.value.trim()
      if (!id) {
        errorMsg.value = 'Subscription ID is required.'
        return
      }
      body.subscription_id = id
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(filtersJson.value)
      } catch {
        errorMsg.value = 'Filters JSON is not valid.'
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        errorMsg.value = 'Filters must be a JSON object.'
        return
      }
      body.filters = parsed
      if (recipientName.value.trim()) body.name = recipientName.value.trim()
      if (sinceDays.value > 0) {
        body.since = new Date(
          Date.now() - sinceDays.value * 86_400_000,
        ).toISOString()
      }
    }

    const res = await $fetch<PreviewResponse>(
      '/api/admin/saved-searches/preview',
      { method: 'POST', body },
    )
    result.value = res
    showToast({
      title: res.would_skip
        ? 'Preview generated — no matches in this window.'
        : `Preview generated — ${res.match_count} ${
            res.match_count === 1 ? 'match' : 'matches'
          }.`,
      icon: res.would_skip ? 'warning' : 'success',
    })
    // Refocus iframe after the next paint so its srcdoc takes.
    await nextTick()
  } catch (err: any) {
    errorMsg.value =
      err?.data?.statusMessage ||
      err?.statusMessage ||
      err?.message ||
      'Preview failed.'
    showToast({ title: errorMsg.value ?? '', icon: 'error' })
  } finally {
    submitting.value = false
  }
}

function reset() {
  result.value = null
  errorMsg.value = null
}

function copySubject() {
  if (!result.value) return
  navigator.clipboard
    .writeText(result.value.subject)
    .then(() => showToast({ title: 'Subject copied', icon: 'success' }))
    .catch(() => showToast({ title: 'Copy failed', icon: 'error' }))
}
</script>

<template>
  <div>
    <div class="mb-4">
      <h2 class="text-base font-semibold text-foreground">Saved-search digest preview</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">
        Render what a subscriber would receive on the next digest run.
        Side-effect-free — no email is sent and the
        <code class="rounded bg-muted-foreground/10 px-1">last_digest_sent_at</code>
        stamp is not touched.
      </p>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <!-- LEFT: form -->
      <section class="rounded-lg border border-border bg-card p-5">
        <!-- Mode toggle -->
        <div class="mb-4 flex gap-1 rounded-lg border border-border bg-background p-1">
          <button
            type="button"
            class="flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
            :class="
              mode === 'ad_hoc'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="mode = 'ad_hoc'; reset()"
          >
            Ad-hoc filters
          </button>
          <button
            type="button"
            class="flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
            :class="
              mode === 'subscription'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="mode = 'subscription'; reset()"
          >
            Existing subscription
          </button>
        </div>

        <!-- Subscription mode -->
        <div v-if="mode === 'subscription'" class="space-y-3">
          <label class="block">
            <span class="block text-xs font-semibold text-foreground/80">
              Subscription ID
            </span>
            <input
              v-model="subscriptionId"
              type="text"
              spellcheck="false"
              placeholder="00000000-0000-0000-0000-000000000000"
              class="mt-1 block w-full rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p class="mt-1 text-xs text-muted-foreground">
              UUID of a row in
              <code class="rounded bg-muted-foreground/10 px-1">saved_search_subscriptions</code>.
              The preview reads its filters + last_digest_sent_at directly.
            </p>
          </label>
        </div>

        <!-- Ad-hoc mode -->
        <div v-else class="space-y-3">
          <label class="block">
            <span class="flex items-baseline justify-between">
              <span class="text-xs font-semibold text-foreground/80">Filters JSON</span>
              <span class="text-[10px] text-muted-foreground">e.g. city_slug, transaction_type, min_price, max_price</span>
            </span>
            <textarea
              v-model="filtersJson"
              rows="8"
              spellcheck="false"
              class="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="block text-xs font-semibold text-foreground/80">
                Recipient name (optional)
              </span>
              <input
                v-model="recipientName"
                type="text"
                placeholder="Tyler"
                class="mt-1 block w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-semibold text-foreground/80">
                Since (days)
              </span>
              <input
                v-model.number="sinceDays"
                type="number"
                min="1"
                max="365"
                class="mt-1 block w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>
        </div>

        <p
          v-if="errorMsg"
          class="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
        >
          {{ errorMsg }}
        </p>

        <div class="mt-4 flex items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="submitting"
            @click="submit"
          >
            <span
              v-if="submitting"
              class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-r-transparent"
              aria-hidden="true"
            />
            {{ submitting ? 'Generating…' : 'Generate preview' }}
          </button>
          <button
            v-if="result"
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            @click="reset"
          >
            Clear
          </button>
        </div>
      </section>

      <!-- RIGHT: result -->
      <section class="rounded-lg border border-border bg-card p-5">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold text-foreground">Preview</h3>
          <span
            v-if="result"
            class="rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
            :class="
              result.would_skip
                ? 'bg-warning/10 text-warning'
                : 'bg-success/10 text-success'
            "
          >
            {{ result.match_count }} {{ result.match_count === 1 ? 'match' : 'matches' }}
          </span>
        </header>

        <div v-if="submitting && !result" class="space-y-2">
          <Skeleton class="h-4 w-3/4" />
          <Skeleton class="h-3 w-full" />
          <Skeleton class="h-[400px] w-full" />
        </div>

        <EmptyState
          v-else-if="!result"
          variant="neutral"
          size="cozy"
          title="No preview yet"
          description="Fill in the form on the left and click Generate to render the digest email."
        />

        <div v-else class="space-y-3">
          <div class="rounded-lg border border-border bg-background p-3">
            <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Subject
            </p>
            <div class="mt-1 flex items-baseline gap-2">
              <p class="flex-1 text-sm font-semibold text-foreground">
                {{ result.subject }}
              </p>
              <button
                type="button"
                class="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
                @click="copySubject"
              >
                Copy
              </button>
            </div>
            <p class="mt-2 text-[11px] text-muted-foreground">
              Mode: <code class="rounded bg-muted-foreground/10 px-1">{{ result.mode }}</code>
              · Since:
              <code class="rounded bg-muted-foreground/10 px-1">
                {{ new Date(result.since).toLocaleString() }}
              </code>
            </p>
          </div>

          <iframe
            ref="iframeRef"
            :srcdoc="result.html"
            sandbox="allow-same-origin"
            class="block w-full min-h-[600px] resize-y rounded-lg border border-border bg-background"
            title="Saved-search digest preview"
          />
        </div>
      </section>
    </div>
  </div>
</template>
