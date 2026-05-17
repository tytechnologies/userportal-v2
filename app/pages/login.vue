<template>
  <div class="lg:flex bg-background text-foreground">
    <aside class="flex flex-col w-full px-10 py-6 bg-card lg:max-w-md lg:h-screen lg:top-0 lg:sticky">
      <div class="flex px-2">
        <a href="https://housinginteractive.com.ph/" target="_blank">
          <BrandLogo class="h-[4.5rem] w-auto" />
        </a>
      </div>

      <div v-if="!resetPasswordFlow" class="flex flex-col justify-center flex-1 w-full max-w-sm mx-auto mt-12 lg:mt-0">
        <div class="text-center mb-9">
          <h3 class="mb-2 text-page-title whitespace-nowrap">
            Login to Housinginteractive
          </h3>
          <span class="text-muted-foreground">Welcome Back</span>
        </div>

        <form @submit.prevent="login" class="w-full space-y-2">
          <div>
            <Input id="email" type="text" v-model="form.email" @change="
              (value) => {
                form.email = value
              }
            " required :error="errors.email" placeholder="Email" class="text-left">
            Email
            </Input>
          </div>

          <div class="relative">
            <div>
              <Input id="password" :type="!showPassword ? 'password' : 'text'" v-model="form.password" @change="
                (value) => {
                  form.password = value
                }
              " required :error="errors.password" placeholder="Password" class="text-left">
              Password
              </Input>
            </div>
            <div class="absolute inset-y-0 right-0 flex items-center pr-2 cursor-pointer" @click="togglePassword">
              <Eye v-if="!showPassword" class="absolute w-6 h-6 right-3 top-8 text-gray-3" />
              <EyeOff v-if="showPassword" class="absolute w-6 h-6 right-3 top-8 text-gray-3" />
            </div>
          </div>

          <div class="flex items-center justify-between">
            <div class="flex items-start">
              <div class="flex items-center h-5 space-x-2">
                <Checkbox id="remember" v-model:checked="form.rememberMe" aria-describedby="remember" />
                <!-- v-model="rememberMe" -->
                <label for="remember"
                  class="text-sm font-medium leading-none text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  Remember me
                </label>
              </div>
            </div>

            <span @click="resetPasswordFlow = true" class="text-sm font-medium cursor-pointer hover:underline">
              Forgot password?
            </span>
          </div>

          <Button class="w-full h-12 mb-3"> Login </Button>

          <p>
            Not yet a member?
            <NuxtLink to="/register" class="font-medium">Sign Up</NuxtLink>
          </p>
        </form>

        <!-- OAuth providers. Sits below the email/password form so existing
             muscle memory is preserved; pressing Enter still submits the
             form above. Buttons are visually distinct (white background,
             provider mark) to avoid being confused with the primary CTA. -->
        <div class="my-6 flex items-center gap-3" aria-hidden="true">
          <div class="h-px flex-1 bg-muted" />
          <span class="text-xs uppercase tracking-wide text-muted-foreground/70">or</span>
          <div class="h-px flex-1 bg-muted" />
        </div>

        <div class="space-y-2">
          <button
            type="button"
            class="flex h-12 w-full items-center justify-center gap-3 rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60 disabled:cursor-not-allowed"
            :disabled="oauthBusy !== null"
            @click="signInWith('google')"
          >
            <!-- Inline SVG so the button renders even with strict CSP /
                 ad-blockers that strip third-party SVG hosts. -->
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.7-1.57 2.69-3.88 2.69-6.62z"
              />
              <path
                fill="#34A853"
                d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.34A9 9 0 0 0 9 18z"
              />
              <path
                fill="#FBBC05"
                d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.16.29-1.7V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.99-2.34z"
              />
              <path
                fill="#EA4335"
                d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l2.99 2.34C4.66 5.17 6.65 3.58 9 3.58z"
              />
            </svg>
            <span v-if="oauthBusy === 'google'">Redirecting…</span>
            <span v-else>Continue with Google</span>
          </button>

          <button
            type="button"
            class="flex h-12 w-full items-center justify-center gap-3 rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60 disabled:cursor-not-allowed"
            :disabled="oauthBusy !== null"
            @click="signInWith('facebook')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#1877F2"
                d="M24 12a12 12 0 1 0-13.88 11.85v-8.38h-3.05V12h3.05V9.36c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.23 2.69.23v2.95h-1.51c-1.49 0-1.96.93-1.96 1.88V12h3.33l-.53 3.47h-2.8v8.38A12 12 0 0 0 24 12z"
              />
            </svg>
            <span v-if="oauthBusy === 'facebook'">Redirecting…</span>
            <span v-else>Continue with Facebook</span>
          </button>
        </div>
      </div>
      <!-- Reset Password Step 1 -->
      <div v-if="resetPasswordFlow" class="flex flex-col justify-center flex-1 w-full max-w-sm mx-auto mt-12 lg:mt-0">
        <div class="text-center mb-9">
          <h3 class="mb-2 text-page-title whitespace-nowrap">
            Reset your password
          </h3>
          <span class="text-muted-foreground">Enter your email to reset your password</span>
        </div>
        <form>
          <Input type="text" placeholder="Email" v-model="form.email" @change="
            (value) => {
              form.email = value
            }
          " />
        </form>
        <div class="flex flex-col gap-4 mt-5 lg:mt-[2vw] items-center">
          <Button class="w-40 lg:w-[10vw]" @click="resetPassword">Reset Password</Button>
          <Button @click="resetPasswordFlow = false" class="hover:bg-muted-foreground bg-foreground w-40 lg:max-w-[10vw]">
            Back to Login
          </Button>
        </div>
      </div>
    </aside>
    <Login />
  </div>
</template>

<script setup lang="ts">
// icons
import Eye from 'vue-material-design-icons/Eye.vue'
import EyeOff from 'vue-material-design-icons/EyeOff.vue'
import axios from 'axios'

import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import { useRoute } from 'vue-router'
import { loginWithProvider, type OAuthProvider } from '~/composables/useOAuth'

const { auth } = useSupabaseClient()
const user = useSupabaseUser()
const resetPasswordFlow = ref(false)

// Meta tags for the page
useHead({
  title: 'Partner Login | Housinginteractive.com.ph',
})

definePageMeta({
  layout: 'auth',
})

watchEffect(() => {
  if (user.value) {
    return navigateTo('/dashboard')
  }
})

onMounted(() => {
  const passwordReset = useRoute().query.passwordReset
  if (passwordReset) {
    showToast({
      title: 'Password reset successful',
      icon: 'success',
    })
  }
})

const form = reactive({
  email: '',
  password: '',
  rememberMe: false,
})

// State for showing/hiding password
const showPassword = ref(false)

// State for form errors
const errors = ref({
  email: '',
  password: '',
})

// Function to toggle password visibility
const togglePassword = () => {
  showPassword.value = !showPassword.value
}

// OAuth click guard: stays non-null while a redirect is in flight so the
// user can't fire two providers back-to-back. Reset on failure; on success
// we never get to read it because window.location is gone.
const oauthBusy = ref<OAuthProvider | null>(null)

const signInWith = async (provider: OAuthProvider) => {
  if (oauthBusy.value) return
  oauthBusy.value = provider
  try {
    const { error } = await loginWithProvider(provider)
    if (error) throw error
    // Success: Supabase replaces window.location. Nothing more to do here.
  } catch (err: any) {
    oauthBusy.value = null
    showToast({
      title: err?.message || `Could not start ${provider} sign-in.`,
      icon: 'error',
    })
  }
}

// Function to handle login
const login = async () => {
  try {
    showLoading()
    const { data, error } = await auth.signInWithPassword({
      email: form.email.trim(),
      password: form.password,
    })

    if (error) throw error
  } catch (error: any) {
    showToast({ title: error.message, icon: 'error' })
    // console.error('Login error', error)
  } finally {
    dismissLoading()
  }
}

const resetPassword = async () => {
  showToast({ title: 'Sending email...', icon: 'info' })

  const origin = window.location.origin
  const nuxtApp = useNuxtApp()

  // Use the current origin so the redirect works regardless of which
  // port the dev server is on (3000, 3002, 3005, etc.) AND when the
  // portal is reached via a Cloudflare tunnel URL during testing.
  // The hardcoded 'localhost:3002' branch used to break any time
  // someone ran the app on a different port.
  const emailRedirectTo = origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('trycloudflare')
    ? `${origin}/forgot-password`
    : origin.includes('staging')
      ? 'https://hi-user-portal-staging.housinginteractive.com.ph/forgot-password'
      : 'https://userportal.housinginteractive.com.ph/forgot-password'

  const { error } = await useSupabaseClient().auth.resetPasswordForEmail(form.email.trim(), {
    redirectTo: emailRedirectTo,
  })

  if (!error) {
    showToast({ title: 'Email sent successfully', icon: 'success' })
  } else {
    showToast({ title: 'Error sending email', icon: 'error' })
  }
}
</script>
