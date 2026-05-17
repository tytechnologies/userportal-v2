// First-sign-in product tour — step definitions.
//
// Each step targets a CSS selector that already exists in the rendered
// shell. If the selector misses (page hasn't rendered the element yet,
// or the element was renamed), the tour falls back to a centered modal
// with the same copy — never crashes.
//
// Adding a step: append to the array. Order = navigation order.
// Reordering / removing steps DOES affect users mid-tour (they jump to
// the new array slot at the same index). To force a re-run on existing
// users, bump TOUR_VERSION and the store will treat `onboarding_skipped
// = true` accounts as "tour pending" if their completed_at predates
// the bump. (Today: not wired — first version.)

export const TOUR_VERSION = 1

export type TooltipPosition = 'top' | 'right' | 'bottom' | 'left' | 'center'

export interface OnboardingStep {
  id: string
  /** Route to navigate to before showing this step. Skipped if the
   *  user is already on a matching route. */
  route?: string
  /** CSS selector for the element to spotlight. Falls back to
   *  centered modal when null. */
  target?: string | null
  title: string
  body: string
  /** Tooltip placement relative to the target. Ignored when target is
   *  null (centered modal). */
  position?: TooltipPosition
  /** Optional override for the next-button label on this step. */
  primaryCta?: string
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to Housing Interactive 👋',
    body: 'A quick 90-second tour so you know where everything lives. Skip anytime — you can rerun this from your profile.',
    primaryCta: 'Start the tour',
  },
  {
    id: 'dashboard',
    route: '/dashboard',
    target: '[data-tour="dashboard-hero"]',
    position: 'bottom',
    title: 'Your home base',
    body: 'The dashboard shows your active listings, recent inquiries, and pipeline at a glance. This is the page you\'ll see most often.',
  },
  {
    id: 'sidebar-nav',
    target: '[data-tour="sidebar-nav"]',
    position: 'right',
    title: 'Primary navigation',
    body: 'Listings, Inquiries, Tasks, Deals — all your daily surfaces live here. Click anywhere to jump.',
  },
  {
    id: 'create-listing',
    target: '[data-tour="create-button"]',
    position: 'bottom',
    title: 'Add a new listing',
    body: 'Use the Create dropdown to publish a property. The wizard walks you through property type, building, pricing, and photos.',
  },
  {
    id: 'inquiries',
    route: '/inquiries',
    target: '[data-tour="inquiries-table"]',
    position: 'top',
    title: 'Where leads land',
    body: 'Public-website inquiries auto-route to the right agent based on routing rules. Yours show up here in real time.',
  },
  {
    id: 'tasks',
    route: '/tasks',
    target: '[data-tour="tasks-table"]',
    position: 'top',
    title: 'Your daily punch list',
    body: 'Tasks track follow-ups, viewings, document chases — anything that needs done. Deal workflows auto-create most of these.',
  },
  {
    id: 'command-palette',
    target: null,
    title: 'Pro tip — keyboard shortcuts',
    body: 'Press Cmd-K (or Ctrl-K on Windows) anywhere to open the command palette. Two-key chords like "g d" jump straight to the dashboard.',
  },
  {
    id: 'done',
    target: null,
    title: 'You\'re set up 🎉',
    body: 'Browse around, publish your first listing, or open the help docs from your profile menu. Welcome aboard.',
    primaryCta: 'Get started',
  },
]
