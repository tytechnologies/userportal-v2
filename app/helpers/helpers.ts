import Swal, { type SweetAlertIcon } from 'sweetalert2'
import { toast } from 'vue-sonner'
import { formatMoney } from '~/helpers/formatMoney'
import base64 from 'base-64'
import { ToWords } from 'to-words'

/**
 * @see https://stackoverflow.com/a/1714899
 *
 * @param  obj
 * @param  prefix
 * @returns {string}
 */

export function http_build_query(
  obj: Record<string, any>,
  prefix: string | null = null
): string {
  const str: string[] = []
  for (let p in obj) {
    if (obj.hasOwnProperty(p)) {
      const k = prefix ? `${prefix}[${p}]` : p
      const v = obj[p]

      str.push(
        v !== null && typeof v === 'object'
          ? http_build_query(v, k)
          : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
      )
    }
  }
  return str.join('&')
}

/**
 * @see https://stackoverflow.com/a/42483509
 *
 * @param formData
 * @param data
 * @param parentKey
 */

function buildFormData(formData: FormData, data: any, parentKey?: string) {
  if (
    data &&
    typeof data === 'object' &&
    !(data instanceof Date) &&
    !(data instanceof File)
  ) {
    Object.keys(data).forEach((key) => {
      buildFormData(
        formData,
        data[key],
        parentKey ? `${parentKey}[${key}]` : key
      )
    })
  } else {
    const value = data == null ? '' : data
    formData.append(parentKey || '', value)
  }
}

/**
 * @see https://stackoverflow.com/a/42483509
 *
 * @param    data
 * @return {FormData}
 */
export function jsonToFormData(data: any): FormData {
  const formData = new FormData()
  buildFormData(formData, data)
  return formData
}

/**
 * @see https://gist.github.com/rickycheers/4541395 *
 *
 * @param  string
 * @return string
 */
export function ucwords(string: string): string {
  string = string.toLowerCase()
  return string.replace(/(^([a-zA-Z\p{M}]))|([ -][a-zA-Z\p{M}])/gu, (s) =>
    s.toUpperCase()
  )
}

/**
 * @see https://stackoverflow.com/questions/149055/how-to-format-numbers-as-currency-strings
 *
 * Native API
 *
 * @param number
 * @return string
 *
 */
export function formatCurrency(number: number = 0): string {
  const formatter = new Intl.NumberFormat('en-US', {
    currency: 'PHP',
  })
  return `₱${formatter.format(number)}`
}

export function currencySuffix(number: number = 0): string {
  let value
  let suffix = ''

  if (number > 999 && number < 1000000) {
    value = Math.ceil(number / 1000) // convert to K for number from > 1000 < 1 million
    suffix = 'K'
  } else if (number > 1000000) {
    value = Math.ceil(number / 1000000) // convert to M for number from > 1 million
    suffix = 'M'
  } else if (number < 900) {
    value = number // if value < 1000, nothing to do
  } else {
    value = 0
  }

  return `${formatMoney(value)}${suffix}`
}

/**
 * Loading overlay shims. The js-loading-overlay@1.1.0 CDN script was removed
 * from nuxt.config.ts; these are no-ops so the ~80 existing call sites don't
 * throw ReferenceError. Replace with skeleton loaders and route-transition
 * spinners as part of the broader UX state cleanup (see audit Milestone 1).
 */
export function showLoading() {
  // no-op
}

export function dismissLoading() {
  // no-op
}

export function showSwal({
  title = '',
  html = '',
  icon = 'success',
  confirmButtonText = 'Ok',
  denyButtonText = 'Ignore',
  showCancelButton = false,
  confirmButtonColor = '#3b82f6',
  allowOutsideClick = true,
}: {
  title?: string
  html?: string
  icon?: SweetAlertIcon
  confirmButtonText?: string
  denyButtonText?: string
  showCancelButton?: boolean
  confirmButtonColor?: string
  allowOutsideClick?: boolean
}) {
  return Swal.fire({
    title,
    html,
    icon,
    showCancelButton,
    confirmButtonText,
    denyButtonText,
    confirmButtonColor,
    allowOutsideClick,
  })
}

/**
 * Backed by vue-sonner. Preserves the legacy SweetAlert call signature so the
 * ~50 existing call sites continue to work; new code should call `toast.*`
 * from `vue-sonner` directly.
 *
 * `message` was previously typed away — callers passed it but the function
 * silently dropped it before the smoke-test sweep. vue-sonner already
 * supports a description line under the title; we now route `message` to
 * `description` so the body text actually renders. Long messages flow under
 * the title in muted type.
 */
export function showToast({
  title = '',
  message = undefined,
  icon = 'success',
  button = undefined,
  onButtonClick = undefined,
  duration = undefined,
}: {
  title?: string
  /**
   * Secondary line under the title. Use for the *why* — error detail,
   * affected count, follow-up hint. Keep the title short and put the
   * detail here. Was previously a no-op on ~26 call sites.
   */
  message?: string | null
  icon?: 'success' | 'error' | 'warning' | 'info' | 'question'
  /** legacy field; vue-sonner generates its own ids. */
  id?: number
  button?: {
    text: string
    color?: string
  }
  onButtonClick?: () => void
  /**
   * Override the default auto-dismiss timeout (ms). vue-sonner defaults
   * to ~4s. Use for bulk summaries / multi-line errors that need
   * longer dwell time. Toasts with `button` already pin to Infinity.
   */
  duration?: number
}) {
  const opts: Record<string, unknown> = {}
  if (button) {
    opts.action = {
      label: button.text,
      onClick: () => onButtonClick?.(),
    }
    // Toasts with actions stay until interacted with.
    opts.duration = Infinity
  } else if (typeof duration === 'number') {
    opts.duration = duration
  }
  if (message) {
    opts.description = message
  }

  switch (icon) {
    case 'success':
      toast.success(title, opts)
      break
    case 'error':
      toast.error(title, opts)
      break
    case 'warning':
      toast.warning(title, opts)
      break
    case 'info':
      toast.info(title, opts)
      break
    default:
      toast(title, opts)
  }
}

export function setStorage(key: string, value: string): boolean {
  if (!value) {
    return true
  }
  const lKey = base64.encode(key)
  const lValue = base64.encode(value)
  localStorage.setItem(lKey, lValue)
  return true
}

export function getStorage(key: string): string {
  const lKey = base64.encode(key)
  const lValue = localStorage.getItem(lKey)
  if (!lValue) {
    return ''
  }
  return base64.decode(lValue)
}

export function removeStorage(key: string): void {
  const lKey = base64.encode(key)
  return localStorage.removeItem(lKey)
}
export function formatDate(date: string) {
  console.log('date: ', date)
  const dateObj = new Date(date)
  const month = dateObj.toLocaleString('en-US', { month: 'long' })
  const day = dateObj.getDate()
  const year = dateObj.getFullYear()
  return `${month} ${day}, ${year}`
}

export function priceToWords(price: string) {
  // Transform "2,000,000" to 2000000
  const numberWithoutCommas = parseInt(price.replace(/,/g, ''))

  console.log(
    'number without commas from convertToWords: ',
    numberWithoutCommas
  )
  const toWords = new ToWords({
    localeCode: 'en-PH',
    converterOptions: { currency: true, doNotAddOnly: true },
  })

  return toWords
    .convert(numberWithoutCommas, {
      currency: true,
      currencyOptions: {
        name: 'PESO',
        plural: 'PESOS',
        symbol: '₱',
        fractionalUnit: { name: 'CENTAVO', plural: 'CENTAVOS', symbol: '¢' },
      },
    })
    .toUpperCase()
}

export function monthsToWords(months: number) {
  console.log('months: ', months)
  const toWords = new ToWords({
    converterOptions: { currency: false, doNotAddOnly: true },
  })
  return toWords.convert(months, { currency: false })
}

export function formatPrice(price: string) {
  // Remove any non-digit characters first, just to be safe
  const cleaned = price.replace(/\D/g, '')
  return cleaned.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function base64ToUint8Array(base64Data: string) {
  // Decode the Base64 string to a binary string
  const binaryString = atob(base64Data)

  // Create a Uint8Array to hold the binary data
  const uint8Array = new Uint8Array(binaryString.length)

  // Populate the Uint8Array with the binary data
  for (let i = 0; i < binaryString.length; i++) {
    uint8Array[i] = binaryString.charCodeAt(i)
  }

  return uint8Array
}