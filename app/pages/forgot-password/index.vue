<template>
  <div class="lg:flex bg-background text-foreground">
    <aside
      class="flex flex-col w-full px-10 py-6 bg-card lg:max-w-md lg:h-screen lg:top-0 lg:sticky"
    >
      <div class="flex px-2">
        <a href="https://housinginteractive.com.ph/" target="_blank">
          <BrandLogo class="h-[4.5rem] w-auto" />
        </a>
      </div>

      <div
        class="flex flex-col justify-center flex-1 w-full max-w-sm mx-auto mt-12 lg:mt-0"
      >
        <!-- Loading State -->
        <div v-if="isLoading" class="flex flex-col items-center justify-center gap-4">
          <div class="animate-spin">
            <svg class="w-8 h-8 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          <span class="text-muted-foreground">Verifying reset link...</span>
        </div>

        <!-- Error State -->
        <div v-else-if="tokenError" class="flex flex-col items-center justify-center gap-4">
          <div class="text-center mb-9">
            <h3 class="mb-2 text-xl font-bold whitespace-nowrap text-destructive">
              Invalid or Expired Link
            </h3>
            <p class="text-muted-foreground mb-4">{{ tokenError }}</p>
          </div>
          <div
            @click="goBackToLogin"
            class="hover:bg-muted-foreground transition-all duration-300 bg-foreground rounded-lg text-white font-bold py-2 px-4 w-40 lg:max-w-[10vw] cursor-pointer"
          >
            Back to Login
          </div>
        </div>

        <!-- Form State -->
        <div v-else-if="isSessionReady" class="flex flex-col w-full max-w-sm mx-auto mt-12 lg:mt-0">
          <div class="text-center mb-9">
            <h3 class="mb-2 text-xl font-bold whitespace-nowrap">
              Create a new password
            </h3>
          </div>

          <form class="w-full space-y-2 flex flex-col gap-4">
            <Input
              type="password"
              v-model="newPassword"
              @change="
                (value) => {
                  newPassword = value
                }
              "
              placeholder="New Password"
            />
            <Input
              type="password"
              v-model="confirmNewPassword"
              @change="
                (value) => {
                  confirmNewPassword = value
                }
              "
              placeholder="Confirm New Password"
            />
            <div class="flex justify-center h-[3vh]">
              <span
                v-if="!passwordMatch && newPassword && confirmNewPassword"
                class="text-destructive text-center flex justify-center"
              >
                Passwords do not match
              </span>
            </div>
            <div class="flex flex-col gap-4 mt-[6vw] items-center">
              <div
                class="hover:bg-green transition-all duration-300 bg-green-dark rounded-lg text-white font-bold py-2 px-4 w-40 lg:max-w-[10vw] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="
                  !passwordMatch || !newPassword || !confirmNewPassword || isSubmitting
                "
                @click="resetPassword"
              >
                {{ isSubmitting ? 'Resetting...' : 'Reset Password' }}
              </div>
              <div
                @click="goBackToLogin"
                class="hover:bg-muted-foreground transition-all duration-300 bg-foreground rounded-lg text-white font-bold py-2 px-4 w-40 lg:max-w-[10vw] cursor-pointer"
              >
                Back to Login
              </div>
            </div>
          </form>
        </div>
      </div>
    </aside>
    <Login />
  </div>
</template>

<script setup lang="ts">
import axios from 'axios'
import { ref, computed, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showSwal, showLoading, dismissLoading } from '~/helpers/helpers'

definePageMeta({
  layout: 'auth',
})

const router = useRouter()

const newPassword = ref('')
const confirmNewPassword = ref('')
const currentToken = ref('')
const isLoading = ref(true)
const isSessionReady = ref(false)
const tokenError = ref('')
const isSubmitting = ref(false)

const passwordMatch = computed(() => {
  return newPassword.value === confirmNewPassword.value
})

function goBackToLogin() {
  router.push('/login')
}

// Wait for session to be established from URL token
watchEffect(() => {
  const user = useSupabaseUser()
  
  // Session established successfully
  if (user.value) {
    isSessionReady.value = true
    isLoading.value = false
    tokenError.value = ''
  }
})

onMounted(async () => {
  // Check if there's a token in the URL
  const token = window.location.hash.split('access_token=')[1]?.split('&')[0]
  
  if (!token) {
    isLoading.value = false
    tokenError.value = 'No reset link found. Please use the link from your reset email.'
    return
  }

  currentToken.value = token

  // Wait for session detection with timeout
  const timeoutId = setTimeout(() => {
    if (!isSessionReady.value && !isLoading.value) {
      tokenError.value =
        'This reset link has expired or is invalid. Please request a new one.'
      isLoading.value = false
    }
  }, 5000)

  // Give Supabase time to detect the session from URL
  // If session isn't detected after 5 seconds, show error
  const checkSessionInterval = setInterval(() => {
    const user = useSupabaseUser()
    if (user.value) {
      clearTimeout(timeoutId)
      clearInterval(checkSessionInterval)
    }
  }, 100)
})

function validatePassword() {
  if (newPassword.value !== confirmNewPassword.value) {
    showSwal({ title: 'Passwords do not match', icon: 'error' })
    return false
  }
  if (newPassword.value.length < 6) {
    showSwal({
      title: 'Password too short',
      html: 'Password must be at least 6 characters',
      icon: 'error',
    })
    return false
  }
  return true
}

async function resetPassword() {
  if (!validatePassword()) {
    return
  }

  isSubmitting.value = true

  try {
    const { error } = await useSupabaseClient().auth.updateUser({
      password: newPassword.value,
    })

    if (error) {
      console.error('Error updating password:', error)
      showToast({ title: error.message, icon: 'error' })
      return
    }

    showToast({
      title: 'Password reset successful',
      icon: 'success',
    })
    
    // Redirect to login after successful reset
    await new Promise(resolve => setTimeout(resolve, 1500))
    router.push('/login?passwordReset=true')
  } catch (error: any) {
    console.error('Password reset error:', error)
    showToast({
      title: error?.message || 'Failed to reset password',
      icon: 'error',
    })
  } finally {
    isSubmitting.value = false
  }
}
</script>
