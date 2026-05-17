import { ref } from 'vue'

export type ConfirmOptions = {
  title?: string
  description?: string
  confirmText?: string
  cancelText?: string
  /** 'destructive' uses red confirm button; 'default' uses primary. */
  variant?: 'default' | 'destructive'
}

type ConfirmState = {
  isOpen: boolean
  options: Required<ConfirmOptions>
  resolve: ((value: boolean) => void) | null
}

const DEFAULTS: Required<ConfirmOptions> = {
  title: 'Are you sure?',
  description: '',
  confirmText: 'Confirm',
  cancelText: 'Cancel',
  variant: 'default',
}

// Module-level singleton: one ConfirmDialog instance is mounted in app.vue
// and any caller anywhere in the app can `await confirm(...)`.
const state = ref<ConfirmState>({
  isOpen: false,
  options: { ...DEFAULTS },
  resolve: null,
})

/**
 * Promise-based confirmation dialog. Resolves to `true` if the user clicks
 * the confirm button, `false` if they cancel / press escape / click outside.
 *
 *   const ok = await confirm({
 *     title: 'Delete listing?',
 *     description: 'This action cannot be undone.',
 *     variant: 'destructive',
 *     confirmText: 'Delete',
 *   })
 *   if (!ok) return
 */
export const useConfirm = () => {
  const confirm = (options: ConfirmOptions = {}): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      // If a previous prompt is somehow still open, decline it before opening
      // the next one. Avoids stuck Promises.
      state.value.resolve?.(false)

      state.value = {
        isOpen: true,
        options: { ...DEFAULTS, ...options },
        resolve,
      }
    })

  const respond = (value: boolean) => {
    state.value.resolve?.(value)
    state.value.isOpen = false
    state.value.resolve = null
  }

  return { confirm, state, respond }
}
