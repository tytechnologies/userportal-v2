// First-sign-in product tour state.
//
// Lifecycle:
//   1. Layout calls `maybeAutoStart()` after `useSupabaseUser()` resolves.
//   2. Store fetches `profiles.onboarding_completed_at` for the user.
//   3. If NULL, sets isActive=true at step 0.
//   4. User clicks Next / Back / Skip. The overlay component navigates
//      to the step's route as needed.
//   5. complete() OR skip() calls the RPC, sets isActive=false, and
//      sets a localStorage flag as a fast-path so subsequent loads
//      skip the DB lookup.

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  ONBOARDING_STEPS,
  type OnboardingStep,
} from '~/composables/onboardingSteps'

const LOCAL_STORAGE_KEY = 'onboarding:v1:done'

export const useOnboardingTourStore = defineStore('onboardingTour', () => {
  const isActive = ref(false)
  const currentIndex = ref(0)
  const checked = ref(false) // have we run the auto-start check this session?

  const steps = computed<OnboardingStep[]>(() => ONBOARDING_STEPS)
  const currentStep = computed<OnboardingStep | null>(
    () => steps.value[currentIndex.value] ?? null,
  )
  const totalSteps = computed(() => steps.value.length)
  const isFirstStep = computed(() => currentIndex.value <= 0)
  const isLastStep = computed(
    () => currentIndex.value >= steps.value.length - 1,
  )

  function hasLocalCompletion(): boolean {
    if (typeof window === 'undefined') return false
    try {
      return localStorage.getItem(LOCAL_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  }

  function setLocalCompletion() {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, '1')
    } catch {
      // localStorage disabled — DB row is still the truth.
    }
  }

  async function maybeAutoStart(userId: string | null | undefined) {
    if (checked.value) return
    checked.value = true
    if (!userId) return
    if (hasLocalCompletion()) return

    // Resolve from the DB. RLS allows the user to self-read.
    const supabase = useSupabaseClient()
    const { data, error } = await supabase
      .from('profiles')
      .select('onboarding_completed_at')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      // Best-effort — don't surface tour if we can't be sure of state.
      // Logging keeps the visibility loss spottable.
      console.warn('[onboarding] profile fetch failed:', error.message)
      return
    }
    if (data?.onboarding_completed_at) {
      setLocalCompletion()
      return
    }
    isActive.value = true
    currentIndex.value = 0
  }

  function start() {
    isActive.value = true
    currentIndex.value = 0
  }

  function next() {
    if (currentIndex.value < steps.value.length - 1) {
      currentIndex.value += 1
    }
  }

  function back() {
    if (currentIndex.value > 0) {
      currentIndex.value -= 1
    }
  }

  function gotoStep(idx: number) {
    if (idx >= 0 && idx < steps.value.length) {
      currentIndex.value = idx
    }
  }

  async function finish(skipped: boolean) {
    isActive.value = false
    setLocalCompletion()
    const supabase = useSupabaseClient()
    try {
      await (supabase as any).rpc('complete_onboarding_tour', {
        p_skipped: skipped,
      })
    } catch (err) {
      console.warn('[onboarding] complete_onboarding_tour failed:', err)
    }
  }

  function skip() {
    return finish(true)
  }

  function complete() {
    return finish(false)
  }

  return {
    isActive,
    currentIndex,
    currentStep,
    totalSteps,
    isFirstStep,
    isLastStep,
    steps,
    maybeAutoStart,
    start,
    next,
    back,
    gotoStep,
    skip,
    complete,
  }
})
