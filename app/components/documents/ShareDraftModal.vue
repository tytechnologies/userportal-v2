<script setup lang="ts">
// Share-link manager. Lists existing links for a draft, lets the user
// create a new one with an expiration window, copy any link to the
// clipboard, and revoke. The public viewer at
// /shared/document-drafts/<token> resolves these tokens.

import { computed, onMounted, ref, watch } from 'vue'
import {
  useDocumentDrafts,
  type ShareLink,
} from '~/composables/useDocumentDrafts'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  draftId: string
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void
}>()

const { listShareLinks, createShareLink, revokeShareLink } = useDocumentDrafts()

const links = ref<ShareLink[]>([])
const isLoading = ref(false)
const isMinting = ref(false)
const expiresInDays = ref(7)

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) await load()
  },
  { immediate: true },
)

async function load() {
  if (!props.draftId) return
  isLoading.value = true
  try {
    links.value = await listShareLinks(props.draftId)
  } catch (err: any) {
    showToast({ title: err?.statusMessage || err?.message || 'Could not load share links.', icon: 'error' })
  } finally {
    isLoading.value = false
  }
}

async function mint() {
  if (!props.draftId) return
  isMinting.value = true
  try {
    const link = await createShareLink(props.draftId, expiresInDays.value)
    links.value.unshift(link)
    if (link.share_url) {
      await copy(link.share_url)
      showToast({ title: 'Share link copied to clipboard.', icon: 'success' })
    } else {
      showToast({ title: 'Share link created.', icon: 'success' })
    }
  } catch (err: any) {
    showToast({ title: err?.statusMessage || err?.message || 'Could not create share link.', icon: 'error' })
  } finally {
    isMinting.value = false
  }
}

async function revoke(link: ShareLink) {
  if (!window.confirm('Revoke this share link? Anyone holding it will lose access.')) return
  try {
    await revokeShareLink(link.id)
    const idx = links.value.findIndex((l) => l.id === link.id)
    if (idx >= 0) links.value[idx]!.revoked_at = new Date().toISOString()
    showToast({ title: 'Link revoked.', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || err?.message || 'Could not revoke.', icon: 'error' })
  }
}

async function copy(text: string) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      // Fallback for older browsers without clipboard API.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'absolute'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
  } catch (err) {
    console.warn('Clipboard write failed:', err)
  }
}

function urlForLink(link: ShareLink): string {
  if (link.share_url) return link.share_url
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/shared/document-drafts/${link.token}`
  }
  return `/shared/document-drafts/${link.token}`
}

function statusOf(link: ShareLink): { label: string; klass: string } {
  if (link.revoked_at) return { label: 'Revoked', klass: 'bg-muted text-muted-foreground' }
  if (new Date(link.expires_at).getTime() < Date.now()) {
    return { label: 'Expired', klass: 'bg-warning/15 text-warning' }
  }
  return { label: 'Active', klass: 'bg-success/15 text-success' }
}

function formatExpires(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}

const activeLinks = computed(() => links.value)

function close() {
  emit('update:open', false)
}
</script>

<template>
  <UiModal
    :open="open"
    title="Share draft"
    subtitle="Anyone with the link can view this draft until it expires or is revoked. Read-only — no edits, no comments."
    width="lg"
    @update:open="(v) => { if (!v) close() }"
  >
    <div class="mb-4 flex flex-wrap items-end gap-2">
      <label class="block text-xs">
        <span class="font-medium text-foreground">Expires in</span>
        <select
          v-model.number="expiresInDays"
          class="mt-1 h-9 rounded-md border border-input bg-card px-2.5 text-xs text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        >
          <option :value="1">1 day</option>
          <option :value="7">7 days</option>
          <option :value="30">30 days</option>
          <option :value="90">90 days</option>
        </select>
      </label>
      <button
        type="button"
        class="btn-primary disabled:opacity-60"
        :disabled="isMinting"
        @click="mint"
      >
        <span v-if="isMinting">Creating…</span>
        <span v-else>Create &amp; copy link</span>
      </button>
    </div>

    <div
      v-if="isLoading"
      class="rounded-md border border-border px-3 py-3 text-xs text-muted-foreground"
    >
      Loading existing links…
    </div>

    <ul
      v-else-if="activeLinks.length > 0"
      class="divide-y divide-border rounded-md border border-border max-h-72 overflow-y-auto"
    >
      <li
        v-for="link in activeLinks"
        :key="link.id"
        class="flex flex-col gap-1 px-3 py-2 text-xs"
      >
        <div class="flex items-center gap-2">
          <span
            class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            :class="statusOf(link).klass"
          >
            {{ statusOf(link).label }}
          </span>
          <span class="text-muted-foreground">expires {{ formatExpires(link.expires_at) }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <code class="flex-1 truncate rounded bg-surface-2 px-2 py-1 text-[10px] text-foreground">
            {{ urlForLink(link) }}
          </code>
          <button
            type="button"
            class="rounded-md border border-border bg-card px-2 py-1 text-[10px] font-medium text-foreground hover:bg-accent"
            @click="copy(urlForLink(link))"
          >
            Copy
          </button>
          <button
            v-if="!link.revoked_at"
            type="button"
            class="rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1 text-[10px] font-semibold text-destructive hover:bg-destructive/15"
            @click="revoke(link)"
          >
            Revoke
          </button>
        </div>
      </li>
    </ul>

    <div
      v-else
      class="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground"
    >
      No share links yet.
    </div>
  </UiModal>
</template>
