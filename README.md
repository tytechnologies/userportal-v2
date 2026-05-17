# Housing Interactive — User Portal v2

The back-of-house Nuxt 4 + Supabase app that powers Housing Interactive's MLS, CRM, deal pipeline, property-management, and admin tooling. Brokers, agents, ops, and finance live here.

> **Repo provenance.** Migrated from [`Hi-Merkado/housing-interactive-user-portal`](https://github.com/Hi-Merkado/housing-interactive-user-portal) on **2026-05-14** as a single squashed initial commit. The migration was a clean-history reset — the old repo retains full commit log + 5 non-`main` branches (`staging`, `feat/may-2026-batch-portal`, `nuxt4-migration`, `nuxt4-staging`, `launch-readiness-2026-05-08`) for reference. See `docs/superpowers/specs/2026-05-13-userportal-v2-repo-migration-design.md` for the cutover plan.

## Quick start

```bash
pnpm install                          # node 20+, pnpm 9+
cp .env.example .env                  # then fill in real values
pnpm dev                              # → http://localhost:3002
```

New here? Read **[`ONBOARDING.md`](./ONBOARDING.md)** — covers architecture, primary surfaces, environment variables, common workflows, and pointers into `docs/pipelines/`.

## The three repos

| Repo | Role |
|---|---|
| [`Hi-Merkado/db-main-reference`](https://github.com/Hi-Merkado/db-main-reference) | Canonical schema (source of truth). Read-only reference. |
| `Hi-Merkado/userportal-v2` (this repo) | Portal — Nuxt 4 + Supabase. CRM, admin tools, ingest pipelines. Port 3002. |
| [`Hi-Merkado/website-v2`](https://github.com/Hi-Merkado/website-v2) | Public website — Nuxt 4 + Supabase anon. Browse, search, inquire. Port 3001. |

All three share **one Supabase project**.

## Where to read

- [`ONBOARDING.md`](./ONBOARDING.md) — Dev / operator onboarding primer.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — Operating contract, service-role allowlist, commit conventions.
- [`CHANGELOG.md`](./CHANGELOG.md) — Notable changes, dated per migration / commit.
- [`docs/pipelines/`](./docs/pipelines/) — Operational reference cards (hybrid search, ingest, statements, etc.).
- [`docs/design-system.md`](./docs/design-system.md) — Tokens + primitive composition spec.
- [`LAUNCH_STATUS.md`](./LAUNCH_STATUS.md) — Pre-launch readiness snapshot.

## Scripts

```bash
pnpm dev                              # Nuxt dev server (port 3002)
pnpm build                            # production build
pnpm preview                          # serve the prod build locally
pnpm test                             # vitest (unit; integration suites env-gated)
pnpm test:run                         # vitest run-once mode
pnpm typecheck                        # nuxt typecheck
pnpm check:tokens                     # design-token CI guard
pnpm check:migrations                 # migration manifest check
pnpm check:reference-drift            # verify no drift vs db-main-reference
pnpm check:seed-drift                 # verify production lookup-table seed vs seed.sql
pnpm e2e                              # playwright (separate setup)
```

## License

Proprietary. © Housing Interactive.
