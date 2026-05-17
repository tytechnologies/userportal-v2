// Legacy email helper — now a no-op.
//
// The Mailgun integration was removed; this stub preserves the
// existing call sites' contract (Promise<void>, fire-and-forget,
// errors never thrown) so the saved-search endpoints continue to
// work without an email provider.
//
// To re-enable email later: pick a provider, drop its SDK in, and
// replace the body below. The call signature is preserved.

/**
 * @param {string} subject - Email subject line
 * @param {string} _htmlBody - HTML body of the email (ignored in stub)
 * @param {string} [toOverride] - Optional override for the recipient email
 */
export default async function sendMail(subject, _htmlBody, toOverride) {
  // eslint-disable-next-line no-console
  console.info('[sendMail] email_provider_disabled', {
    subject,
    to: toOverride || null,
  })
}
