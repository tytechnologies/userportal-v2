<script setup lang="ts">
// Topbar notification bell. Reads from /api/notifications via the
// useNotifications composable; backed by RLS so it always shows the
// caller's own (recipient_user_id = auth.uid()).
//
// Realtime: subscribes to the `notifications` table via the
// supabase_realtime publication (enabled in
// 20260502000012_notifications_realtime.sql). New rows for the current
// user surface within ~100ms — no polling needed.
//
// Defense-in-depth: a slow 5-minute poll still runs as a safety net
// for environments where Realtime isn't reachable (websocket blocked,
// proxy stripping upgrade headers). At 5 min it's not perceptible
// battery cost and guarantees the bell never goes silently stale.

import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useNotifications, type Notification } from '~/composables/useNotifications'
import { showToast } from '~/helpers/helpers'

const { listNotifications, markRead, dismiss, markAllRead } = useNotifications()

const supabase = useSupabaseClient()
const user = useSupabaseUser()

const isOpen = ref(false)
const notifications = ref<Notification[]>([])
const unreadCount = ref(0)
const isLoading = ref(false)
let pollHandle: ReturnType<typeof setInterval> | null = null
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null

async function load() {
  isLoading.value = true
  try {
    const res = await listNotifications({ pageSize: 20 })
    notifications.value = res.data
    unreadCount.value = res.unread_count
  } finally {
    isLoading.value = false
  }
}

function toggle() {
  isOpen.value = !isOpen.value
  if (isOpen.value) load()
}

function close() {
  isOpen.value = false
}

async function onClickItem(n: Notification) {
  // Mark read on click; navigate if we have an href. Errors are silent —
  // a failed mark-read shouldn't block the click-through.
  if (!n.read_at) {
    try {
      const updated = await markRead(n.id)
      const idx = notifications.value.findIndex(x => x.id === n.id)
      if (idx >= 0) notifications.value[idx] = updated
      unreadCount.value = Math.max(0, unreadCount.value - 1)
    } catch { /* ignore */ }
  }
  if (n.href) {
    isOpen.value = false
    await navigateTo(n.href)
  }
}

async function onDismiss(n: Notification, ev: Event) {
  ev.stopPropagation()
  try {
    await dismiss(n.id)
    notifications.value = notifications.value.filter(x => x.id !== n.id)
    if (!n.read_at) unreadCount.value = Math.max(0, unreadCount.value - 1)
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to dismiss', icon: 'error' })
  }
}

async function onMarkAllRead() {
  try {
    const res = await markAllRead()
    notifications.value = notifications.value.map(n => ({
      ...n,
      read_at: n.read_at ?? new Date().toISOString(),
    }))
    unreadCount.value = 0
    showToast({ title: `Marked ${res.updated} read`, icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to mark all read', icon: 'error' })
  }
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30)  return `${d}d`
  return new Date(iso).toLocaleDateString()
}

// Click-away handler — bound at body level so we close when the user
// clicks anywhere outside the dropdown.
function onDocClick(e: MouseEvent) {
  if (!isOpen.value) return
  const target = e.target as HTMLElement
  if (!target.closest('[data-notification-bell]')) close()
}

onMounted(() => {
  load()

  // Realtime subscription. Filtered to the current recipient at the
  // server side so the channel only receives rows we'd be allowed to
  // SELECT anyway (RLS still enforces — Realtime delivery does NOT
  // bypass policies). Filter syntax: `column=eq.value` per Realtime v2.
  if (user.value?.id) {
    realtimeChannel = supabase
      .channel(`notifications:recipient=${user.value.id}`)
      .on(
        // PostgresChangesEvent type lives in supabase-js; importing it
        // pulls in a chunky type tree, so we cast inline.
        'postgres_changes' as any,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `recipient_user_id=eq.${user.value.id}`,
        },
        (payload: any) => {
          const row = payload?.new as Notification | undefined
          if (!row) return
          // Prepend if we don't already have it (a refresh + realtime
          // race could otherwise show duplicates).
          if (!notifications.value.some((n) => n.id === row.id)) {
            notifications.value = [row, ...notifications.value].slice(0, 20)
          }
          if (!row.read_at && !row.dismissed_at) {
            unreadCount.value = unreadCount.value + 1
          }
        },
      )
      .subscribe()
  }

  // Safety-net poll: very slow refresh in case Realtime is unreachable
  // (corporate proxies sometimes strip the websocket upgrade). At 5 min
  // this is imperceptible battery cost and guarantees eventual
  // consistency without depending on the channel.
  pollHandle = setInterval(() => {
    if (!isOpen.value) load()
  }, 5 * 60_000)

  document.addEventListener('click', onDocClick)
})

onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle)
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel)
    realtimeChannel = null
  }
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div data-notification-bell class="relative">
    <button
      type="button"
      class="relative w-8 h-8 my-auto text-center rounded-full bg-muted hover:bg-muted"
      :title="`${unreadCount} unread`"
      @click="toggle"
    >
      <span class="text-base">🔔</span>
      <span
        v-if="unreadCount > 0"
        class="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white"
      >
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </span>
    </button>

    <transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="transform scale-95 opacity-0"
      enter-to-class="transform scale-100 opacity-100"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="transform scale-100 opacity-100"
      leave-to-class="transform scale-95 opacity-0"
    >
      <div
        v-if="isOpen"
        class="absolute right-0 z-50 mt-2 w-80 origin-top-right rounded-md border border-border bg-background shadow-lg focus:outline-none"
      >
        <header class="flex items-center justify-between border-b border-border px-3 py-2">
          <span class="text-sm font-semibold text-foreground">Notifications</span>
          <div class="flex items-center gap-3">
            <button
              v-if="unreadCount > 0"
              class="text-xs text-primary hover:underline"
              @click="onMarkAllRead"
            >
              Mark all read
            </button>
            <NuxtLink
              to="/notification-settings"
              class="text-xs text-muted-foreground/70 hover:text-foreground"
              title="Notification settings"
              @click="close"
            >
              ⚙
            </NuxtLink>
          </div>
        </header>

        <div v-if="isLoading" class="py-6 text-center text-xs text-muted-foreground/70">
          Loading…
        </div>
        <div
          v-else-if="notifications.length === 0"
          class="py-8 text-center text-xs text-muted-foreground/70"
        >
          You're all caught up.
        </div>

        <ul v-else class="max-h-80 divide-y divide-border overflow-y-auto">
          <li
            v-for="n in notifications"
            :key="n.id"
            class="cursor-pointer px-3 py-2 hover:bg-accent hover:text-accent-foreground"
            :class="!n.read_at ? 'bg-primary/10' : ''"
            @click="onClickItem(n)"
          >
            <div class="flex items-start gap-2">
              <span
                class="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                :class="!n.read_at ? 'bg-primary' : 'bg-transparent'"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold text-foreground">{{ n.title }}</p>
                <p v-if="n.body" class="truncate text-xs text-muted-foreground">{{ n.body }}</p>
                <p class="mt-0.5 text-[10px] text-muted-foreground/70">{{ relativeTime(n.created_at) }}</p>
              </div>
              <button
                class="rounded p-1 text-xs text-foreground hover:bg-muted hover:text-muted-foreground"
                title="Dismiss"
                @click="onDismiss(n, $event)"
              >
                ✕
              </button>
            </div>
          </li>
        </ul>

        <!-- Footer link to the full inbox. Always rendered (even on
             empty state) so users can browse historical notifications. -->
        <footer class="border-t border-border px-3 py-2 text-center">
          <NuxtLink
            to="/notifications"
            class="text-xs font-semibold text-primary hover:underline"
            @click="close"
          >
            View all notifications →
          </NuxtLink>
        </footer>
      </div>
    </transition>
  </div>
</template>
