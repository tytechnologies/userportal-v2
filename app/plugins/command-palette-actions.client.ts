// Global command-palette actions registered once at app boot.
//
// Page-scoped commands stay in their respective components (and use
// useScopedCommands so they auto-unregister). This plugin adds
// app-wide actions that are always available — toggle theme, jump
// to ops, jump to BIR forms, etc.
//
// Why .client.ts: useTheme() reads localStorage and the toggle calls
// browser APIs; safe to skip on the server.

export default defineNuxtPlugin(() => {
  const { register, setActiveRole } = useCommandPalette()
  const router = useRouter()
  const { toggleTheme, setTheme } = useTheme()

  // Mirror the resolved user role into the palette so commands tagged
  // `requiresRole: 'admin'` stay hidden from agents/managers. The role
  // composable defers to /api/me on first read; the watcher fires once
  // the profile resolves.
  const userRole = useUserRole()
  watch(
    userRole,
    (r) => {
      if (r) setActiveRole(r)
    },
    { immediate: true },
  )

  // ⌘⇧D / Ctrl+Shift+D toggles dark/light. Mac uses ⌘, Windows/Linux
  // uses Ctrl. The shortcut is shown in the palette hint so it's
  // discoverable AND reachable via the hotkey directly.
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const themeChord = isMac ? '⌘⇧D' : 'Ctrl+Shift+D'

  // Two-key "g X" chord (Linear / GitHub pattern). Press `g` then a
  // second key within 1.5s to navigate: g d → dashboard, g o → ops,
  // g e → eis, g l → listings, g i → inquiries.
  //
  // Skipped when:
  //   - User is typing in an input/textarea/contenteditable (so `g`
  //     doesn't get hijacked while writing)
  //   - A modifier (cmd/ctrl/alt/shift) is held (those chords are for
  //     OS / browser actions)
  //   - Command palette is currently open (it owns its own keymap)
  //
  // Each chord destination + key is also registered as a palette
  // command with the chord shown in `hint` for discoverability.
  const navChords: Record<string, { path: string; label: string }> = {
    d: { path: '/dashboard', label: 'Dashboard' },
    o: { path: '/admin/operations', label: 'Operations' },
    e: { path: '/admin/eis-submissions', label: 'EIS submissions' },
    l: { path: '/listings', label: 'Listings' },
    i: { path: '/inquiries', label: 'Inquiries' },
    t: { path: '/tasks', label: 'Tasks' },
  }

  let chordPrimed = false
  let chordTimer: ReturnType<typeof setTimeout> | null = null
  function clearChord() {
    chordPrimed = false
    if (chordTimer) {
      clearTimeout(chordTimer)
      chordTimer = null
    }
  }

  function isTypingTarget(t: EventTarget | null): boolean {
    if (!t || !(t instanceof HTMLElement)) return false
    const tag = t.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (t.isContentEditable) return true
    return false
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      // Match the Mac chord (metaKey) OR the Win/Linux chord (ctrlKey).
      // Always require shiftKey to disambiguate from Ctrl+D (browser
      // bookmark) and Cmd+D (browser bookmark on Mac).
      if (
        e.shiftKey &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'd'
      ) {
        e.preventDefault()
        toggleTheme()
        clearChord()
        return
      }

      // Two-key chord — `g` primes, the next letter navigates.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        clearChord()
        return
      }
      if (isTypingTarget(e.target)) {
        clearChord()
        return
      }
      // Don't fight the command palette while it's owning the keyboard.
      const { isOpen } = useCommandPalette()
      if (isOpen.value) {
        clearChord()
        return
      }
      const k = e.key.toLowerCase()
      if (chordPrimed) {
        const dest = navChords[k]
        clearChord()
        if (dest) {
          e.preventDefault()
          router.push(dest.path)
        }
        return
      }
      if (k === 'g') {
        chordPrimed = true
        chordTimer = setTimeout(clearChord, 1500)
        // Don't preventDefault — `g` typed alone is harmless and we
        // want it to reach inputs in case the user starts typing
        // immediately after.
      }
    })
  }

  register(
    {
      id: 'theme.toggle',
      label: 'Toggle theme (light / dark)',
      hint: themeChord,
      kind: 'action',
      group: 'Appearance',
      keywords: ['dark mode', 'light mode', 'appearance', 'color scheme'],
      perform: () => toggleTheme(),
    },
    {
      id: 'theme.dark',
      label: 'Switch to dark mode',
      hint: 'Theme',
      kind: 'action',
      group: 'Appearance',
      keywords: ['dark', 'night'],
      perform: () => setTheme('dark'),
    },
    {
      id: 'theme.light',
      label: 'Switch to light mode',
      hint: 'Theme',
      kind: 'action',
      group: 'Appearance',
      keywords: ['light', 'day'],
      perform: () => setTheme('light'),
    },
    {
      id: 'nav.dashboard',
      label: 'Go to Dashboard',
      hint: 'g d',
      kind: 'navigate',
      group: 'Navigation',
      keywords: ['home', 'overview', 'main'],
      perform: () => { router.push('/dashboard').catch(() => {}) },
    },
    {
      id: 'nav.listings',
      label: 'Go to Listings',
      hint: 'g l',
      kind: 'navigate',
      group: 'Navigation',
      keywords: ['properties', 'mls', 'inventory'],
      perform: () => { router.push('/listings').catch(() => {}) },
    },
    {
      id: 'nav.inquiries',
      label: 'Go to Inquiries',
      hint: 'g i',
      kind: 'navigate',
      group: 'Navigation',
      keywords: ['leads', 'requests', 'crm'],
      perform: () => { router.push('/inquiries').catch(() => {}) },
    },
    {
      id: 'nav.tasks',
      label: 'Go to Tasks',
      hint: 'g t',
      kind: 'navigate',
      group: 'Navigation',
      keywords: ['todos', 'workflow'],
      perform: () => { router.push('/tasks').catch(() => {}) },
    },
    {
      id: 'admin.operations',
      label: 'Open Operations dashboard',
      hint: 'g o',
      kind: 'navigate',
      group: 'Admin · Infrastructure',
      keywords: ['ops', 'health', 'status', 'monitoring', 'alerts'],
      requiresRole: 'admin',
      perform: () => { router.push('/admin/operations').catch(() => {}) },
    },
    {
      id: 'admin.eis-submissions',
      label: 'Open EIS submissions',
      hint: 'g e',
      kind: 'navigate',
      group: 'Admin · Billing & Revenue',
      keywords: ['bir', 'invoice', 'submit', 'e-invoicing'],
      requiresRole: 'admin',
      perform: () => { router.push('/admin/eis-submissions').catch(() => {}) },
    },
    {
      id: 'admin.bir-2307',
      label: 'Open BIR Form 2307',
      hint: 'Admin · /admin/bir-2307',
      kind: 'navigate',
      group: 'Admin · Billing & Revenue',
      keywords: ['withholding', 'creditable', 'tax', 'bir'],
      requiresRole: 'admin',
      perform: () => { router.push('/admin/bir-2307').catch(() => {}) },
    },
    {
      id: 'admin.bir-2306',
      label: 'Open BIR Form 2306',
      hint: 'Admin · /admin/bir-2306',
      kind: 'navigate',
      group: 'Admin · Billing & Revenue',
      keywords: ['final withholding', 'tax', 'bir', 'cert'],
      requiresRole: 'admin',
      perform: () => { router.push('/admin/bir-2306').catch(() => {}) },
    },
    {
      id: 'admin.platform-settings',
      label: 'Open Platform settings',
      hint: 'Admin · /admin/platform-settings',
      kind: 'navigate',
      group: 'Admin · Infrastructure',
      keywords: ['eis provider', 'config', 'settings', 'tenant'],
      requiresRole: 'admin',
      perform: () => { router.push('/admin/platform-settings').catch(() => {}) },
    },
    {
      id: 'admin.live-search',
      label: 'Open Live search dashboard',
      hint: 'Admin · /admin/live-search',
      kind: 'navigate',
      group: 'Admin · Infrastructure',
      keywords: ['hybrid', 'tavily', 'external', 'connectors', 'cache', 'orchestrator'],
      requiresRole: 'admin',
      perform: () => { router.push('/admin/live-search').catch(() => {}) },
    },
    {
      id: 'admin.external-candidates',
      label: 'Review external candidates',
      hint: 'Admin · /admin/external-candidates',
      kind: 'navigate',
      group: 'Admin · Infrastructure',
      keywords: ['hybrid', 'tavily', 'external', 'review', 'promote', 'blacklist', 'discovery'],
      requiresRole: 'admin',
      perform: () => { router.push('/admin/external-candidates').catch(() => {}) },
    },
    {
      id: 'admin.ticker',
      label: 'Open Marketing ticker',
      hint: 'Admin · /admin/ticker',
      kind: 'navigate',
      group: 'Admin · Infrastructure',
      keywords: ['banner', 'announcement', 'live stats', 'header'],
      requiresRole: 'admin',
      perform: () => { router.push('/admin/ticker').catch(() => {}) },
    },
    {
      id: 'help.onboarding-tour',
      label: 'Restart onboarding tour',
      hint: 'Help',
      kind: 'action',
      group: 'Help',
      keywords: ['walkthrough', 'tutorial', 'getting started', 'tour', 'help'],
      perform: () => {
        // Lazy-import the store so the command palette plugin doesn't
        // pull the entire onboarding bundle on initial paint.
        import('~/store/onboardingTour')
          .then(({ useOnboardingTourStore }) => {
            useOnboardingTourStore().start()
          })
          .catch(() => {})
      },
    },
  )
})
