<script setup lang="ts">
/**
 * Broker invitation acceptance page.
 *
 * /invite/<token>
 *
 * The recipient lands here from a link the admin shares (manually
 * for v1; automated email is a follow-up turn). Three flows:
 *   1. Already signed in + email matches → big "Accept" button
 *   2. Not signed in → "Sign in to accept" → after auth, returns
 *      here authenticated
 *   3. Already-accepted / declined / expired → terminal-state UI
 *
 * The accept endpoint enforces the email match server-side; this
 * page just guides the UX.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

definePageMeta({
  layout: 'default',
})
useHead({
  title: 'Invitation | Housinginteractive',
  meta: [{ name: 'robots', content: 'noindex,nofollow' }],
})

type Preview = {
  token: string
  status: 'pending' | 'accepted' | 'declined' | 'expired'
  email: string
  full_name: string | null
  org_role: string
  expires_at: string | null
  organization: { id: string; name: string; slug: string; verified: boolean } | null
  branch: { id: string; name: string; slug: string } | null
}

const route = useRoute()
const router = useRouter()
const token = computed(() => String(route.params.token || ''))

const preview = ref<Preview | null>(null)
const previewLoading = ref(true)
const submitting = ref(false)
const finalStatus = ref<'pending' | 'accepted' | 'declined' | 'expired' | null>(null)

// Resolve current user from the @nuxtjs/supabase composable.
const supabaseUser = useSupabaseUser()
const userEmail = computed(() => (supabaseUser.value?.email || '').toLowerCase())
const isSignedIn = computed(() => !!supabaseUser.value?.id)
const emailMatches = computed(() =>
  preview.value && userEmail.value && userEmail.value === preview.value.email.toLowerCase(),
)

async function loadPreview() {
  previewLoading.value = true
  try {
    const res = await $fetch<Preview>(`/api/invitations/${token.value}`)
    preview.value = res
    finalStatus.value = res.status
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load invitation',
      icon: 'error',
    })
    preview.value = null
  } finally {
    previewLoading.value = false
  }
}

async function accept() {
  if (submitting.value) return
  submitting.value = true
  try {
    await $fetch(`/api/invitations/${token.value}/accept`, { method: 'POST' })
    finalStatus.value = 'accepted'
    showToast({ title: 'Invitation accepted', icon: 'success' })
    setTimeout(() => router.push('/organization'), 1200)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to accept',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

async function decline() {
  if (submitting.value) return
  if (!confirm('Decline this invitation? This cannot be undone.')) return
  submitting.value = true
  try {
    await $fetch(`/api/invitations/${token.value}/decline`, { method: 'POST' })
    finalStatus.value = 'declined'
    showToast({ title: 'Invitation declined', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to decline',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

function signInWithRedirect() {
  // Redirect through the existing login flow, returning to this page
  // after successful auth. Adjust to whatever your login route is.
  router.push({ path: '/login', query: { redirectTo: `/invite/${token.value}` } })
}

onMounted(loadPreview)
watch(() => route.params.token, loadPreview)

const orgLabel = computed(() => {
  if (!preview.value?.organization) return '—'
  let s = preview.value.organization.name
  if (preview.value.branch) s += ` · ${preview.value.branch.name}`
  return s
})

const roleLabel = computed(() =>
  preview.value?.org_role.replace(/_/g, ' ') || '',
)
</script>

<template>
  <div class="mx-auto max-w-xl px-4 py-8">
    <div v-if="previewLoading" class="rounded-xl border border-border bg-background p-5 text-center text-sm text-muted-foreground">
      Loading invitation…
    </div>

    <!-- Token not found / generic load failure -->
    <div
      v-else-if="!preview"
      class="rounded-xl border border-border bg-background p-5 text-center"
    >
      <h1 class="text-xl font-semibold">Invitation not found</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        The link may be invalid or the invitation may have been removed.
      </p>
    </div>

    <!-- Terminal states -->
    <div
      v-else-if="finalStatus === 'accepted'"
      class="rounded-xl border border-success/30 bg-success/10 p-5 text-center"
    >
      <h1 class="text-xl font-semibold text-success">Welcome to {{ orgLabel }}</h1>
      <p class="mt-2 text-sm text-success">
        You've joined as <span class="font-semibold">{{ roleLabel }}</span>.
        Redirecting to your organization dashboard…
      </p>
      <NuxtLink to="/organization" class="mt-4 inline-block text-sm font-semibold text-primary hover:underline">
        Go to dashboard →
      </NuxtLink>
    </div>

    <div
      v-else-if="finalStatus === 'declined'"
      class="rounded-xl border border-border bg-background p-5 text-center"
    >
      <h1 class="text-xl font-semibold">Invitation declined</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        You declined this invitation to {{ orgLabel }}. The inviter has been notified.
      </p>
    </div>

    <div
      v-else-if="finalStatus === 'expired'"
      class="rounded-xl border border-border bg-background p-5 text-center"
    >
      <h1 class="text-xl font-semibold">Invitation expired</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        Ask the inviter to send you a new invitation link.
      </p>
    </div>

    <!-- Pending: action UI -->
    <div
      v-else
      class="rounded-xl border border-border bg-background p-8"
    >
      <header class="text-center">
        <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          You're invited
        </p>
        <h1 class="mt-1 text-2xl font-semibold">
          Join {{ preview.organization?.name }}
        </h1>
        <p v-if="preview.branch" class="mt-1 text-sm text-muted-foreground">
          {{ preview.branch.name }} branch
        </p>
        <span
          v-if="preview.organization?.verified"
          class="mt-2 inline-block rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary"
        >
          verified organization
        </span>
      </header>

      <dl class="mt-6 space-y-2 rounded-md border border-border bg-muted/40 p-4 text-sm">
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Role</dt>
          <dd class="font-semibold">{{ roleLabel }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Email</dt>
          <dd class="font-mono text-xs">{{ preview.email }}</dd>
        </div>
        <div v-if="preview.full_name" class="flex justify-between">
          <dt class="text-muted-foreground">Invited as</dt>
          <dd>{{ preview.full_name }}</dd>
        </div>
        <div v-if="preview.expires_at" class="flex justify-between">
          <dt class="text-muted-foreground">Expires</dt>
          <dd class="text-xs">{{ new Date(preview.expires_at).toLocaleDateString() }}</dd>
        </div>
      </dl>

      <!-- Sign-in path -->
      <div
        v-if="!isSignedIn"
        class="mt-6 rounded-md border border-primary/30 bg-primary/10 p-4 text-sm"
      >
        <p class="text-primary">
          Sign in with <span class="font-mono">{{ preview.email }}</span> to accept this invitation.
        </p>
        <button
          type="button"
          class="mt-3 w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
          @click="signInWithRedirect"
        >
          Sign in to accept →
        </button>
        <button
          type="button"
          class="mt-2 w-full rounded-md border border-border bg-background px-4 py-2 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
          @click="decline"
        >
          Decline invitation
        </button>
      </div>

      <!-- Wrong-email path -->
      <div
        v-else-if="!emailMatches"
        class="mt-6 rounded-md border border-warning/30 bg-warning/10 p-4 text-sm"
      >
        <p class="text-warning">
          You're signed in as <span class="font-mono">{{ userEmail }}</span>,
          but this invitation is for <span class="font-mono">{{ preview.email }}</span>.
        </p>
        <p class="mt-2 text-xs text-warning">
          Sign out and sign back in with the correct email, or ask the inviter to
          re-issue the invitation to your current email.
        </p>
      </div>

      <!-- Email matches: accept/decline -->
      <div v-else class="mt-6 space-y-2">
        <button
          type="button"
          class="w-full rounded-md bg-success px-4 py-3 text-sm font-semibold text-success-foreground hover:bg-success/90 disabled:opacity-50"
          :disabled="submitting"
          @click="accept"
        >
          {{ submitting ? 'Accepting…' : `Accept &amp; join ${preview.organization?.name}` }}
        </button>
        <button
          type="button"
          class="w-full rounded-md border border-border bg-background px-4 py-2 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          :disabled="submitting"
          @click="decline"
        >
          Decline invitation
        </button>
      </div>
    </div>
  </div>
</template>
