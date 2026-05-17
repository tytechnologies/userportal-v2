# Schema Migrations Runbook

Single source of truth for the Supabase schema is `supabase/migrations/*.sql`.
Files are timestamped (`YYYYMMDDHHMMSS_description.sql`) and applied in order.

## One-time setup

```bash
# Install the Supabase CLI (per https://supabase.com/docs/guides/cli)
brew install supabase/tap/supabase   # macOS
# or: scoop install supabase             # Windows
# or: npx supabase ...                   # ad-hoc

# Link this project to the live Supabase instance.
# Get the project ref from the Supabase dashboard URL:
#   https://supabase.com/dashboard/project/<project-ref>
supabase login
supabase link --project-ref <project-ref>
```

## Phase A — Capture the existing schema (run once)

Almost everything in production today (`listings`, `contacts`, `cities`,
`barangays`, etc.) was created outside this folder. Capture it before any
further migration so changes diff cleanly.

```bash
# Dump the live schema as a baseline migration.
supabase db diff --schema public --linked \
  -f baseline_existing_schema > supabase/migrations/$(date +%Y%m%d%H%M%S)_baseline.sql

# Inspect the file (it should be hundreds of lines), then commit it.
git add supabase/migrations/*_baseline.sql
git commit -m "chore: track existing public schema as baseline migration"
```

After this, every future `supabase db diff` produces an incremental delta
against the baseline. **Until this is done, the migrations in this folder
do not reflect a complete schema** — they assume a baseline exists.

## Applying migrations

```bash
# Push pending migrations to the linked project.
supabase db push

# Or, for staging/testing first, point at a separate project:
supabase db push --db-url postgres://...staging...
```

## Migration order (apply top-to-bottom)

1. `20250129000000_create_documents_table.sql` — already in repo
2. `<your-baseline-from-Phase-A>` — required before anything below works
3. `20260429000001_create_profiles_table.sql` — `public.profiles` + auth trigger
4. `20260429000002_quarantine_listings_created_by.sql` — fixes mixed-UUID data
5. `20260429000003_drop_listings_contact_denorm.sql` — Phase E (apply only after server stops writing those columns; see comment in file)
6. `20260429000004_normalize_listings_city_barangay.sql` — Phase F

## Generating typed schema for the codebase

After every migration push, regenerate the TypeScript schema types so
`server/repositories/*` and other consumers stay in sync:

```bash
pnpm db:types
git add server/utils/database.types.ts
git commit -m "chore: regenerate Supabase types after <migration name>"
```

The `db:types` script (in `package.json`) calls
`supabase gen types typescript --linked` and writes to
`server/utils/database.types.ts`. Run it locally — committing stale types
is the same class of bug as committing stale lockfiles.

## Pre-commit guard (recommended)

Hook a pre-commit step (Husky / simple-git-hooks / etc.) that fails the
commit if a `supabase/migrations/*.sql` file changed without a matching
update to `server/utils/database.types.ts`:

```sh
#!/bin/sh
if git diff --cached --name-only | grep -q '^supabase/migrations/' && \
   ! git diff --cached --name-only | grep -q 'database.types.ts'; then
  echo "Migration changed but types weren't regenerated."
  echo "Run: pnpm db:types && git add server/utils/database.types.ts"
  exit 1
fi
```

## Rollback policy

Most migrations in this folder are forward-only (CREATE / ALTER … ADD).
Where a migration is destructive (DROP COLUMN, ALTER TYPE), the file
includes a `-- ROLLBACK:` block in comments at the top. To roll back:

```bash
# Connect to the database and run the SQL in the ROLLBACK block manually.
supabase db remote commit --message "manual rollback of <migration>"
```

Supabase's auto-rollback tooling is limited; treat every migration as a
careful change reviewed in PR.

## Schema discipline going forward

- **No schema changes via the dashboard.** All schema lives here, applied
  via `supabase db push`. Dashboard edits drift the baseline.
- **`select('*')` is an anti-pattern in code review.** Project explicit
  columns; PostgREST relational selects keep payloads small.
- **Every new table has RLS enabled before data lands.** Default-deny
  policy first, then add allow policies in the same migration.
- **Every new column has a `COMMENT ON COLUMN`** explaining what it stores
  and any constraints not enforced by CHECK.
