<script setup lang="ts">
/**
 * Admin broadcast composer.
 *
 * Compose form + audience picker + send. Hits POST /api/admin/broadcasts.
 * Returns recipient + sent counts so the admin sees fanout coverage.
 */
import { ref, computed } from 'vue'
import { showToast } from '~/helpers/helpers'

type Audience = 'all' | 'admins' | 'managers' | 'agents'

const title = ref('')
const body = ref('')
const href = ref('')
const audience = ref<Audience>('all')
const sending = ref(false)
const lastResult = ref<null | {
  audience: Audience
  recipients: number
  sent: number
  errors: Array<{ recipient_user_id: string; reason: string }>
}>(null)

const canSend = computed(() => title.value.trim().length > 0 && !sending.value)

async function send() {
  if (!canSend.value) return
  if (
    !window.confirm(
      `Send "${title.value.trim()}" to ${audienceLabel(audience.value)}?\n\nThis fans out as an in-app notification + email to each recipient (per their preferences). Cannot be undone.`,
    )
  ) return

  sending.value = true
  lastResult.value = null
  try {
    const res = await $fetch<{
      audience: Audience
      recipients: number
      sent: number
      errors: Array<{ recipient_user_id: string; reason: string }>
    }>('/api/admin/broadcasts', {
      method: 'POST',
      body: {
        title: title.value.trim(),
        body: body.value.trim() || null,
        href: href.value.trim() || null,
        audience: audience.value,
      },
    })
    lastResult.value = res
    title.value = ''
    body.value = ''
    href.value = ''
    showToast({
      title: `Sent to ${res.sent} of ${res.recipients}`,
      icon: 'success',
    })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to send',
      icon: 'error',
    })
  } finally {
    sending.value = false
  }
}

function audienceLabel(a: Audience): string {
  switch (a) {
    case 'all': return 'all users'
    case 'admins': return 'admins'
    case 'managers': return 'managers'
    case 'agents': return 'agents'
  }
}
</script>

<template>
  <div>
    <header class="mb-4">
      <h2 class="text-section-title">Broadcast announcement</h2>
      <p class="text-sm text-muted-foreground">
        Send an in-app notification (with email fan-out) to a chosen audience.
        Respects each recipient's notification preferences.
      </p>
    </header>

    <div class="ui-card p-5 max-w-2xl">
      <label class="block text-sm mb-3">
        <span class="text-foreground/80">Title (required)</span>
        <input
          v-model="title"
          type="text"
          maxlength="200"
          placeholder="e.g. Scheduled maintenance Friday 9pm-11pm PHT"
          class="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      <label class="block text-sm mb-3">
        <span class="text-foreground/80">Body (optional)</span>
        <textarea
          v-model="body"
          rows="4"
          maxlength="10000"
          placeholder="More detail. Plain text — recipients see this in the bell + email."
          class="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      <label class="block text-sm mb-3">
        <span class="text-foreground/80">Click-through URL (optional)</span>
        <input
          v-model="href"
          type="text"
          maxlength="2048"
          placeholder="/dashboard or https://… — recipients see an Open link"
          class="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      <label class="block text-sm mb-3">
        <span class="text-foreground/80">Audience</span>
        <select
          v-model="audience"
          class="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All users</option>
          <option value="admins">Admins only</option>
          <option value="managers">Managers only</option>
          <option value="agents">Agents only</option>
        </select>
      </label>

      <div class="mt-4">
        <button
          type="button"
          class="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="!canSend"
          @click="send"
        >
          {{ sending ? 'Sending…' : `Send to ${audienceLabel(audience)}` }}
        </button>
      </div>

      <div
        v-if="lastResult"
        class="mt-4 rounded-lg bg-success/10 border border-success/30 p-3 text-sm text-success"
      >
        Last broadcast: sent to <strong>{{ lastResult.sent }}</strong>
        of <strong>{{ lastResult.recipients }}</strong>
        ({{ audienceLabel(lastResult.audience) }})
        <span v-if="lastResult.errors.length > 0">
          · <strong>{{ lastResult.errors.length }}</strong> errors
        </span>
      </div>
    </div>
  </div>
</template>
