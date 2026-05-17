import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * return formatter number to currency with currency prefix
 */
export function formatMoney(
  value: number | string | null,
  displayEmptyWhenZero: boolean = false
): string {
  const currency = '₱'

  if (value == null || isNaN(Number(value))) {
    value = 0
  }

  let numericValue: number =
    value.toString().length > 0
      ? parseFloat(value.toString().replace(/,/g, ''))
      : 0

  if (isNaN(numericValue)) {
    numericValue = 0
  }

  if (displayEmptyWhenZero && numericValue === 0) {
    return ''
  }

  return (
    currency +
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 0 }).format(
      numericValue
    )
  )
}