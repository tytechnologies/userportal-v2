# Inquiry pipeline

End-to-end visitor inquiry flow. A buyer / renter submits an enquiry on the public website's listing detail page. The website proxies to the portal's anon-readable endpoint, which writes a row to `public.inquiries`. The lead-routing trigger fires; an email notification ships via Resend; the CRM (`/inquiries` admin page) renders the new row.

## Components

### Website
- `app/components/Listings/Enquiry.vue` — the inquire form.
- `server/api/public/inquiries.post.ts` — proxy that forwards to the portal. Adds the visitor's IP via `x-forwarded-for`. Normalizes upstream error shapes.

### Portal
- `server/api/public/inquiries.post.ts` — anon-friendly endpoint. Zod validation, honeypot field, listing existence check, dedup of repeated submissions (5min window), `created_by` orphan preflight.
- `public.inquiries` — the inquiry row. New table (UUID PK per [[pk-typing-rule]]).
- `inquiries_before_insert_route` trigger — fires lead-routing rules (see [[lead-routing]]).
- `/inquiries` admin page — CRM view of inquiries.

### Email notification
- `server/utils/email.ts` → `sendEmail()` via Resend. Fires when an inquiry's `assigned_user_id` is populated (post-trigger).

### Schema gotchas
- `inquiries.created_by` can orphan-reference a deleted profile — preflight is in the endpoint.
- `inquiries.id` is UUID but endpoints accept legacy numeric IDs too — see [[schema-drift]].
- Column is `inquiries.assigned_user_id` (NOT `assignee_user_id`).

## Operate

### Wire from the website

The Enquiry form posts to `/api/public/inquiries` on the **website**, which proxies to the **portal**. Required env on the website:
- `USERPORTAL_URL` — base URL of the portal.

Honeypot field is `website` — if populated, the portal silently 201s without writing.

### Dedup window

The portal endpoint checks for an existing inquiry with the same `(listing_id, sender_email, message_hash)` within the last 5 minutes. Returns the existing row's id without re-writing. Prevents accidental double-submits.

### Rate limit

Per-IP rate limit via `rate_limit_buckets`: 20 inquiries / hour. Beyond that → 429.

### Routing
- Lead-routing trigger runs BEFORE INSERT. See [[lead-routing.md]] for full mechanics.
- If no rule matches, falls back to the listing's `contact_owner_user_id` (legacy snapshot).
- If still NULL, the inquiry lands unassigned and the CRM lists it under "Unassigned".

### Email
- Triggered automatically after insert when `assigned_user_id` is set.
- Subject + body templated in `server/utils/notifications.ts`.
- Requires `RESEND_API_KEY` + `RESEND_FROM_EMAIL` per [[email-provider-wired]].

## Smoke

```powershell
# 1. Public submission via website
curl -s -X POST -H "content-type: application/json" `
  -d '{\"listing_id\":<id>,\"sender_name\":\"smoke\",\"sender_email\":\"smoke@test\",\"message\":\"smoke test\"}' `
  http://localhost:3001/api/public/inquiries

# 2. Direct against portal (skip website proxy)
curl -s -X POST -H "content-type: application/json" `
  -d '{\"listing_id\":<id>,\"sender_name\":\"smoke\",\"sender_email\":\"smoke@test\",\"message\":\"smoke\"}' `
  http://localhost:3002/api/public/inquiries

# 3. Honeypot dropped silently (note the `website` field)
curl -s -X POST -H "content-type: application/json" `
  -d '{\"listing_id\":<id>,\"sender_name\":\"bot\",\"sender_email\":\"a@b\",\"message\":\"spam\",\"website\":\"hacked\"}' `
  http://localhost:3002/api/public/inquiries
# Expect: 201 with an id, but no row in inquiries.
```

```sql
-- 4. Cleanup
DELETE FROM public.inquiries WHERE sender_email = 'smoke@test';
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Form submits but 503 | Website's `USERPORTAL_URL` unset | Set on website, restart |
| 500 from portal endpoint | `created_by` orphan (rare) | Logged as PostgREST shape; preflight should have caught — see [[orphan-created-by]] |
| Inquiry written but no email | Resend env unset OR `assigned_user_id` NULL | Check both; assignment may have legitimately fallen through to NULL |
| 429 in dev | Rate limit | Clear the bucket: `DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'inquiry%';` |
| Inquiry duplicates anyway | Dedup window is 5min; later submissions write fresh rows | Working as designed |

## Open work

- **Spam scoring** beyond honeypot — Akismet-style integration deferred.
- **Email reply parsing** — replying to the email notification doesn't yet thread back into the CRM.
- **Unassigned alert** — operator notification when an inquiry sits unassigned > 30min isn't wired.
- **CSV export** — quick filter export from `/inquiries` is in progress.

## Related guides

- [lead-routing.md](lead-routing.md) — the routing trigger
- [saved-search-digest.md](saved-search-digest.md) — adjacent email pipeline
