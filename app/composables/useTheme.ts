// Lightweight light/dark theme toggle.
//
// SCOPE: this composable exists so the brand logo can swap between
// /img/light.png and /img/dark.png on user toggle. It also adds/removes
// the `dark` class on <html> so future Tailwind dark: utilities will
// react. It is NOT a full dark-mode rollout — most surfaces still
// render with light-mode tokens until each one gets explicit dark:
// styling.
//
// Persistence: stored under `hi:theme` in localStorage. First-load
// fallback is the OS preference (`prefers-color-scheme: dark`).
//
// SSR-safe: reads / writes are gated on `typeof window`. The initial
// value during server render is always 'light' — the client hydration
// pass corrects it on mount via applyClass(). One-frame flash of the
// light logo is acceptable for an internal portal; a critical-CSS
// pre-hydration script can eliminate it later if needed.

import { ref, watch, type Ref } from 'vue'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'hi:theme'
const themeRef: Ref<Theme> = ref('light')
let initialized = false

function readStored(): Theme | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null
  }
}

function readSystem(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyClass(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
}

function init() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  themeRef.value = readStored() ?? readSystem()
  applyClass(themeRef.value)
  // Sync the html class + localStorage on every change. Module-scoped
  // so multiple useTheme() calls share the same watcher (no leak).
  watch(themeRef, (next) => {
    applyClass(next)
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* quota / private mode */ }
  })
}

export function useTheme() {
  init()

  function setTheme(next: Theme) {
    themeRef.value = next
  }

  function toggleTheme() {
    themeRef.value = themeRef.value === 'dark' ? 'light' : 'dark'
  }

  return {
    /** Reactive current theme. */
    theme: themeRef,
    setTheme,
    toggleTheme,
  }
}
