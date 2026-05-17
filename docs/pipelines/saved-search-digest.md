# Saved-search digest

Subscribers save a search filter on the website. Daily at 06:00 PHT (22:00 UTC), a cron job calls `/api/admin/saved-searches/run-digest`. The endpoint resolves which subscribers are due (per their cadence), runs each saved search, builds a digest email of new matches, and sends via Resend.

## Components

### Migrations
- `20260506000005_saved_search_subscriptions.sql` — subscription table.
- `20260506000006_saved_searches_due_function.sql` — `saved_searches_due_for_digest()` RPC.
- `20260506000007_saved_search_digest_cron.sql` — `internal_config` singleton + pg_cron schedule.

### Tables
| Table | Purpose |
|---|---|
| `saved_searches` | The search filter blob, keyed to a user/email |
| `saved_search_subscriptions` | Cadence + last_sent_at |
| `internal_config` | Singleton holding cron URL + secret |

### Cron job
- `saved_search_digest_daily` — `0 22 * * *` UTC (06:00 PHT).

### Endpoint
- `POST /api/admin/saved-searches/run-digest` — admin-JWT OR `x-internal-secret` for cron. Body: `{ dryRun: bool }`.

### Email send
- `server/utils/email.ts` → `sendEmail()` → Resend SDK. Requires `RESEND_API_KEY` + `RESEND_FROM_EMAIL`.

## Operate

### Setup checklist

1. Apply migrations.
2. Set env vars on the portal:
   ```
   RESEND_API_KEY=re_...
   RESEND_FROM_EMAIL=hello@your-verified-domain
   ```
3. Configure `internal_config`:
   ```sql
   UPDATE public.internal_config
      SET digest_endpoint_url = '<portal_base_url>/api/admin/saved-searches/run-digest',
          digest_cron_secret  = '<INTERNAL_CRON_SECRET value>'
    WHERE id = 1;
   ```
4. Confirm pg_cron + pg_net extensions are enabled.

### Verify Resend setup

Resend requires a verified sending domain. In the Resend dashboard:
1. Add your domain.
2. Apply the SPF + DKIM TXT records via your DNS provider.
3. Wait for `Verified` status. Until then, you can only send to your account-owner address (Resend forces `FROM` to the sandbox value).

### Tune cadence

A subscriber's row in `saved_search_subscriptions` carries `cadence` (e.g. `'daily'`, `'weekly'`). `saved_searches_due_for_digest()` reads this + `last_sent_at` to decide who fires today.

### Manual fire

```sql
-- dryRun: returns audience counts without sending. Safe.
WITH cfg AS (SELECT digest_endpoint_url, digest_cron_secret FROM internal_config WHERE id = 1)
SELECT net.http_post(
  url     := cfg.digest_endpoint_url,
  headers := jsonb_build_object('content-type','application/json',
                                'x-internal-secret', cfg.digest_cron_secret),
  body    := jsonb_build_object('dryRun', true)
) FROM cfg;
```

Replace `true` with `false` once verified to actually send.

## Smoke

```sql
-- 1. Cron registered?
SELECT jobname, schedule, active
  FROM cron.job WHERE jobname = 'saved_search_digest_daily';

-- 2. Config seeded?
SELECT digest_endpoint_url IS NOT NULL AS url_set,
       digest_cron_secret IS NOT NULL  AS secret_set
  FROM internal_config WHERE id = 1;

-- 3. Recent runs (last 10)
SELECT status, return_message, start_time
  FROM cron.job_run_details
 WHERE jobname = 'saved_search_digest_daily'
 ORDER BY start_time DESC LIMIT 10;

-- 4. Today's audience count (dryRun)
-- See "Manual fire" above with dryRun: true.
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Digest never sends | RESEND_API_KEY unset | Set env, restart portal |
| Cron status `failed` with 401 | INTERNAL_CRON_SECRET mismatch | Confirm `internal_config.digest_cron_secret` matches `.env` |
| All sends bounce | RESEND_FROM_EMAIL not on a verified domain | Verify domain in Resend dashboard, OR switch to sandbox |
| One user gets 0 results | Their saved search filter has no recent matches | Working as designed; digest skips empty audiences |
| Email opens but no listings shown | Image URLs in S3 signed-link expired | Templates use long-lived public URLs where possible; verify |

## Open work

- **Per-cadence cron** — currently one daily job covers everyone. Weekly subscribers get fired daily but the `due` check skips them. Splitting into `digest_daily_22utc` + `digest_weekly_mondays` is cleaner.
- **HTML template versioning** — emails are inline-rendered; no versioned template store yet.
- **Bounce handling** — Resend webhook → unsubscribe-on-bounce loop isn't wired.

## Related guides

- [inquiry-pipeline.md](inquiry-pipeline.md) — saved searches are scaffolding to drive future inquiries
