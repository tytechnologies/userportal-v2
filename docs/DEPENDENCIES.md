# Dependency policy

This codebase has been bitten by **silent semver drift on infrastructure
dependencies** — most recently `@nuxtjs/supabase` going from 1.x to 2.x
during a routine `pnpm install`, which broke `serverSupabaseUser()`'s
return shape and produced 401s on every authenticated endpoint until we
shipped the `sbUser` wrapper.

To prevent a repeat, the following packages are **pinned to exact
versions** in `package.json` (no leading `^` or `~`):

| Package | Why it's pinned |
|---|---|
| `@nuxtjs/supabase` | Module API breaks across majors; `serverSupabaseUser` returned User in v1 and JWT claims in v2 with no SemVer warning. |
| `@supabase/supabase-js` | Auth + RLS contract surface. A patch bump has shipped client-side regression more than once. |
| `nuxt` | Major framework. Already exact-pinned. |
| `vue` | Reactivity model + SFC compiler. Already exact-pinned. |
| `puppeteer` | Bundles a native Chromium binary; minor bumps have changed CDP behavior used by PDF rendering. |
| `docusign-esign` | SDK signature has changed between major versions; envelope payloads need verifying on bump. |

Everything else (UI libs, utilities, AWS SDK, etc.) stays on caret ranges.

## When upgrading a pinned package

1. Open a dedicated branch — never bundle a pinned-dep bump with feature work.
2. Run the full test suite + a Playwright smoke (login → create listing → generate document → send envelope) against the upgrade.
3. Document the surface area that the new version changes (read the changelog and grep our codebase for any API that moved).
4. Squash into one commit titled `chore(deps): bump <pkg> a.b.c → x.y.z` with the smoke results in the body.
5. CI runs `pnpm typecheck` + `pnpm test:run` + `pnpm build` on the PR; if green, merge.

## How the `cookie` override survives this

`pnpm.overrides.cookie` and the top-level `overrides.cookie` force every
transitive `cookie` dep to `^0.7.2`. This was needed when an older
transitive version mis-handled certain encoded values during Supabase
SSR auth. Keep both override entries — pnpm honors the `pnpm.overrides`
key, but the `overrides` key is what npm itself reads, so we cover both
package managers.
