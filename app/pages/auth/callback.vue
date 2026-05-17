<script setup lang="ts">
// Provider-agnostic OAuth landing page. Both Google and Facebook redirect
// here after the user authorizes. The @nuxtjs/supabase module is configured
// with `redirect: false` (nuxt.config.ts), so we are responsible for:
//
//   1. Waiting for the Supabase client to finish parsing the URL hash /
//      authorization-code grant and create a session.
//   2. Routing the user to ?next= (defaults to /dashboard) once a user
//      object resolves.
//   3. Surfacing OAuth errors that come back as ?error=... query params
//      (e.g. user denied consent, or the provider isn't enabled).
//
// We do NOT inspect provider-specific fields here — the auth.global.ts
// middleware + downstream pages read user.user_metadata via useDisplayUser,
// which already normalizes shape across providers.

import { computed, onMounted, ref } from 'vue'

definePageMeta({
  layout: 'auth',
})

useHead({
  title: 'Signing you in… | Housinginteractive',
})

const route = useRoute()
const router = useRouter()
const user = useSupabaseUser()
const supabase = useSupabaseClient()

const errorMessage = ref<string | null>(null)
const isExchanging = ref(true)

// Where to go once the session resolves. Capped to in-app paths so a
// crafted redirect (?next=https://evil.example) cannot bounce the user
// off-domain after sign-in.
const safeNext = computed(() => {
  const raw = (route.query.next as string) || '/dashboard'
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard'
})

// Watch user — once Supabase parses the callback and a session lands,
// `useSupabaseUser()` flips to the user. Then route them on.
watch(
  user,
  (next) => {
    if (next?.id) {
      isExchanging.value = false
      router.replace(safeNext.value)
    }
  },
  { immediate: true },
)

onMounted(async () => {
  // OAuth providers can pass an error back in the query string when the
  // user cancels, denies, or the provider isn't fully configured. Show
  // it inline rather than silently looping back to /login.
  const oauthError = route.query.error_description ?? route.query.error
  if (oauthError) {
    isExchanging.value = false
    errorMessage.value = String(oauthError)
    return
  }

  // PKCE / authorization-code flow: Supabase exposes the exchange via
  // exchangeCodeForSession when a `?code=` param is present. The implicit
  // (hash-token) flow is handled automatically by the JS client on load.
  // We try the code exchange but ignore its absence — the session may
  // already be present from the implicit flow.
  const code = (route.query.code as string) || null
  if (code) {
    try {
      await supabase.auth.exchangeCodeForSession(code)
    } catch (err: any) {
      // Stale code, bad PKCE verifier, etc. — surface it.
      isExchanging.value = false
      errorMessage.value = err?.message ?? 'Could not finish sign-in.'
      return
    }
  }

  // Fallback: if neither flow produced a user within ~6s, something is
  // wrong (provider misconfigured in the Supabase dashboard, cookie
  // domain mismatch, etc.). Bail out to /login with a hint.
  setTimeout(() => {
    if (!user.value) {
      isExchanging.value = false
      if (!errorMessage.value) {
        errorMessage.value =
          'Sign-in did not complete. Please try again or use email/password.'
      }
    }
  }, 6000)
})

const goLogin = () => router.replace('/login')
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-muted/30 px-4">
    <div
      class="w-full max-w-sm rounded-xl border border-border bg-background p-8 text-center shadow-sm"
    >
      <template v-if="isExchanging && !errorMessage">
        <div
          class="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-border border-t-blue-20"
          aria-hidden="true"
        />
        <h1 class="text-base font-semibold text-foreground">Signing you in…</h1>
        <p class="mt-1 text-xs text-muted-foreground">
          Finishing handshake with the provider.
        </p>
      </template>

      <template v-else-if="errorMessage">
        <h1 class="text-base font-semibold text-destructive">Sign-in failed</h1>
        <p class="mt-2 text-xs text-muted-foreground">{{ errorMessage }}</p>
        <button
          type="button"
          class="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
          @click="goLogin"
        >
          Back to login
        </button>
      </template>
    </div>
  </div>
</template>
