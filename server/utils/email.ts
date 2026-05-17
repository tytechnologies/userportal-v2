// Transactional email helper.
//
// Provider: Resend (https://resend.com) via REST. No SDK dependency —
// uses global fetch so the function works in both Nitro server context
// and standalone scripts.
//
// Configuration:
//   RESEND_API_KEY        — required to actually send. When absent the
//                           function logs and returns (matches the prior
//                           no-op behaviour for local/test envs).
//   RESEND_FROM_EMAIL     — required when sending. e.g.
//                           'Housing Interactive <noreply@housinginteractive.com.ph>'
//   EMAIL_DELIVERY_DISABLED=1 — kill switch (overrides the API key check).
//
// Caller contract:
//   - sendEmail({to, subject, html, text?}) → Promise<void>
//   - Throws on transient failures (4xx/5xx, network) so the
//     outbound_emails worker records them as retry-eligible.
//   - Internal notify() callers wrap with .catch() — a Resend
//     outage doesn't break user-visible writes.

import { logger } from './logger'

export type SendEmailInput = {
  to: string
  subject: string
  /** Plaintext fallback; HTML preferred. */
  text?: string
  html: string
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  // Operator-controlled kill switch. Honoured first so disabling
  // delivery doesn't require unsetting the API key.
  if (
    String(process.env.EMAIL_DELIVERY_DISABLED ?? '')
      .toLowerCase()
      .match(/^(1|true|yes)$/)
  ) {
    logger.info(
      { op: 'email.send', to: input.to, subject: input.subject, sent: false, reason: 'kill_switch' },
      'email_send_skipped',
    )
    return
  }

  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL

  // No provider configured — log and return. Same behaviour as the
  // legacy no-op stub; keeps local dev / tests working without keys.
  if (!apiKey || !from) {
    logger.info(
      {
        op: 'email.send',
        to: input.to,
        subject: input.subject,
        sent: false,
        reason: 'resend_not_configured',
      },
      'email_send_skipped',
    )
    return
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Resend ${res.status}: ${body.slice(0, 500)}`)
    }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, op: 'email.send', to: input.to, subject: input.subject },
      'email_send_failed',
    )
    throw err
  }
}

// =====================================================================
// Templates
// =====================================================================
//
// One render fn per notification kind. Each takes the structured input
// the notify() caller already gathered + an absolute portal URL for
// the click-through link.

type TemplateInput = {
  recipientName?: string | null
  actorName?: string | null
  title: string
  body?: string | null
  hrefAbsolute?: string | null
}

export type EmailTemplate = {
  subject: string
  html: string
}

function shell(content: string, title: string, hrefAbsolute?: string | null): string {
  // Minimal inline-styled HTML — most clients strip <style>, so we
  // inline. Container width 600 is the standard transactional shape.
  return `
<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 12px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:18px;color:#111827">${escapeHtml(title)}</h1>
          ${content}
          ${hrefAbsolute ? `<p style="margin:24px 0 0"><a href="${hrefAbsolute}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px">Open in portal</a></p>` : ''}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#9ca3af">You're getting this because you have notifications on at <strong>Housing Interactive</strong>. <a href="${process.env.PUBLIC_APP_URL ?? 'https://app.housinginteractive.com.ph'}/my-profile" style="color:#9ca3af">Manage email preferences</a>.</p>
    </td></tr>
  </table>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderEmail(kind: string, input: TemplateInput): EmailTemplate {
  const actor = input.actorName?.trim() || 'A teammate'
  const greet = input.recipientName?.trim() ? `Hi ${input.recipientName},` : 'Hi,'

  switch (kind) {
    case 'listing.shared': {
      const subject = `${actor} shared a listing with you`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">${escapeHtml(actor)} just shared a listing with you on Housing Interactive.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563"><em>"${escapeHtml(input.body)}"</em></p>` : ''}
          <p style="margin:0 0 12px">Open the portal to accept the invite and access the listing.</p>
        `,
        input.title,
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'task.assigned': {
      const subject = `New task assigned to you: ${input.title}`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">${escapeHtml(actor)} assigned a task to you: <strong>${escapeHtml(input.title)}</strong>.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
        `,
        'New task',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'listing.inquiry_received': {
      const subject = `New inquiry: ${input.title}`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">A visitor on the public website just inquired about one of your listings.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
          <p style="margin:0 0 12px">Open the inquiry in the portal to see contact details and reply.</p>
        `,
        'New listing inquiry',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'contact.note_added':
    case 'listing.note_added': {
      const subject = `${actor} added a note`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">${escapeHtml(actor)} added a note ${kind === 'contact.note_added' ? 'on a contact' : 'on a listing'}.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563"><em>${escapeHtml(input.body)}</em></p>` : ''}
        `,
        'New note',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'envelope.invitation': {
      // input.title = envelope title; input.body = optional cover message
      // hrefAbsolute = signing URL with single-use token
      const subject = `Document to sign: ${input.title}`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">${escapeHtml(actor)} sent you a document to sign on Housing Interactive.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
          <p style="margin:0 0 12px"><strong>${escapeHtml(input.title)}</strong></p>
          <p style="margin:0 0 12px">Click the button below to review and sign. The link is unique to you and expires in 30 days.</p>
        `,
        'Sign document',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'envelope.completed': {
      const subject = `All parties signed: ${input.title}`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">All recipients have signed <strong>${escapeHtml(input.title)}</strong>.</p>
          <p style="margin:0 0 12px">A signed copy plus the audit certificate is available in the portal.</p>
        `,
        'Signing complete',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'envelope.declined': {
      const subject = `Declined: ${input.title}`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">A signer declined <strong>${escapeHtml(input.title)}</strong>.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">Reason: ${escapeHtml(input.body)}</p>` : ''}
          <p style="margin:0 0 12px">Open the envelope in the portal to review and follow up.</p>
        `,
        'Envelope declined',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'platform_fee.invoice_issued': {
      // input.title = invoice number; input.body = amount summary
      const subject = `Invoice ${input.title} — Housing Interactive platform fee`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">Your monthly platform fee invoice <strong>${escapeHtml(input.title)}</strong> is ready.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
          <p style="margin:0 0 12px">Open the portal to review the line items and pay.</p>
        `,
        'New invoice',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'org.invitation_sent': {
      // input.title = organization name; hrefAbsolute = accept URL
      const subject = `You're invited to join ${input.title}`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">${escapeHtml(actor)} invited you to join <strong>${escapeHtml(input.title)}</strong> on Housing Interactive.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
          <p style="margin:0 0 12px">Click below to accept the invitation. The link expires in 30 days.</p>
        `,
        'Join organization',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'statement.tenant_issued': {
      // input.title = statement number; input.body = balance summary
      const subject = `Your statement is ready — ${input.title}`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">Your tenant statement <strong>${escapeHtml(input.title)}</strong> has been issued.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
        `,
        'New statement',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'statement.owner_issued': {
      const subject = `Your owner statement is ready — ${input.title}`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">Your owner statement <strong>${escapeHtml(input.title)}</strong> for the latest period has been issued.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
        `,
        'New owner statement',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'owner_portal.invitation': {
      // input.title = subject ("Access your owner portal")
      // input.body = personalised invite copy w/ expiry
      // hrefAbsolute = /portal/owner/accept-invite/<token> on the public site
      const subject = input.title || 'Your owner portal invitation'
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">${escapeHtml(actor)} invited you to your owner portal on Housing Interactive.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
          <p style="margin:0 0 12px">Sign in (or create your account with this email) to view your units, monthly statements, dues, and disbursements.</p>
          <p style="margin:0 0 12px;color:#9ca3af;font-size:12px">For your security this link only works once and is unique to this invitation.</p>
        `,
        'Open your owner portal',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'tenant_portal.invitation': {
      // input.title = subject ("Access your tenant portal")
      // input.body = personalised invite copy w/ unit + expiry
      // hrefAbsolute = /portal/accept-invite/<token> on the public site
      const subject = input.title || 'Your tenant portal invitation'
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">${escapeHtml(actor)} invited you to your tenant portal on Housing Interactive.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
          <p style="margin:0 0 12px">Sign in (or create your account with this email) and you'll see your lease, current balance, statements, and a one-click maintenance request form.</p>
          <p style="margin:0 0 12px;color:#9ca3af;font-size:12px">For your security this link only works once and is unique to this invitation.</p>
        `,
        'Open your tenant portal',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    case 'charge.due_soon': {
      // input.title = charge number; input.body = "{{amount}} due {{date}}"
      const subject = `Reminder: ${input.title} due soon`
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">This is a friendly reminder that your charge <strong>${escapeHtml(input.title)}</strong> is due soon.</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
          <p style="margin:0 0 12px">Open the portal to review and pay.</p>
        `,
        'Payment reminder',
        input.hrefAbsolute,
      )
      return { subject, html }
    }
    default: {
      // Generic shape — covers any future kind without a custom template.
      const subject = input.title
      const html = shell(
        `
          <p style="margin:0 0 12px">${greet}</p>
          <p style="margin:0 0 12px">${escapeHtml(input.title)}</p>
          ${input.body ? `<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(input.body)}</p>` : ''}
        `,
        input.title,
        input.hrefAbsolute,
      )
      return { subject, html }
    }
  }
}
