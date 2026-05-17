import DOMPurify from 'isomorphic-dompurify'

const LISTING_DESCRIPTION_CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],
  RETURN_TRUSTED_TYPE: false,
} as const

export function sanitizeListingHtml(input: string | null | undefined): string {
  if (!input) return ''
  return DOMPurify.sanitize(String(input), LISTING_DESCRIPTION_CONFIG as any)
}
