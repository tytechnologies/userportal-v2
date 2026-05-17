# userportal-v2 repo migration

**Date:** 2026-05-13
**Status:** Approved design — pending implementation plan
**Owner:** Tyler (brinxtyler@gmail.com)

---

## Driver

`Hi-Merkado/housing-interactive-user-portal` has accumulated ~hundreds of WIP / AI-coauthored commits over the launch-readiness push. The code is fine; the git log is the noise. We want `main` to read like an intentional project log from day one. The chosen remedy: a fresh repo with a single squashed initial commit. The old repo is archived (read-only) for historical reference.

## Scope

- **Source repo:** `https://github.com/Hi-Merkado/housing-interactive-user-portal.git` (archive after cutover)
- **Destination repo:** `https://github.com/Hi-Merkado/userportal-v2.git` (must exist, empty, before Phase C)
- **Snapshot source:** HEAD of `launch-readiness-2026-05-08` **after** the wizard edit-mode work is committed
- **History strategy:** single initial commit ("Initial commit — userportal-v2"); no carry-over of the 87+ commits
- **Branches transferred:** none. New repo starts with `main` only. The 5 non-main branches (`staging`, `feat/may-2026-batch-portal`, `nuxt4-migration`, `nuxt4-staging`, `launch-readiness-2026-05-08`) remain in the archived old repo for reference. If their work is wanted later, read the diff there and reapply on top of new `main`.
- **What does NOT come along:** open issues, open PRs, releases, tags, GitHub Discussions, Wiki. All stay in the archived repo.

## Cutover sequence (six phases)

### Phase A — Pre-cutover (old repo, current branch)

1. Browser-test wizard at `/listings/new` (publish flow, golden path)
2. Browser-test wizard at `/listings/{id}/edit` (edit flow, including history drawer)
3. Commit the 3 wizard files (`AddListingWizard.vue`, `ListingDetailContent.vue`, `app/pages/listings/[id]/edit.vue`) as the wizard edit-mode feature commit
4. `git push` so origin holds the final state

Phase A is non-destructive. If wizard testing reveals new bugs, abort and fix them before continuing — Phase B onwards assumes HEAD is the snapshot we want.

### Phase B — Snapshot creation (local, sibling directory)

Performed from a new working directory **next to** the current repo clone, not inside it.

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ"
git clone --depth 1 --branch launch-readiness-2026-05-08 `
  https://github.com/Hi-Merkado/housing-interactive-user-portal.git `
  userportal-v2-snapshot
cd userportal-v2-snapshot
Remove-Item -Recurse -Force .git
# URL rewrites in tracked files (see "URL rewrites" section below)
git init -b main
git add -A
git commit -m "Initial commit — userportal-v2"
git remote add origin https://github.com/Hi-Merkado/userportal-v2.git
git push -u origin main
```

The `--branch` flag is required — without it, `git clone --depth 1` pulls origin's default branch (`main`), which would lose the 87 launch-readiness commits we're trying to snapshot.

Phase B is non-destructive: old repo is untouched, new repo is populated.

### Phase C — GitHub-side setup (manual, ~10–15 min)

1. Confirm `Hi-Merkado/userportal-v2` is empty (no auto-init README, no .gitignore, nothing)
2. After Phase B's push, set branch protection on `main`:
   - Require PR before merging
   - Disallow force-push
   - Require linear history (matches the "clean linear" goal — no merge commits in main's future)
3. Re-add repo secrets that the old repo has (collaborate via GitHub UI; or install `gh` CLI to enumerate)
4. Mirror collaborator / team access from old repo

Phase C is additive. New repo exists alongside the old; production traffic still on old.

### Phase D — Vercel re-link (manual, real cutover risk window, ~20–30 min)

This is the only phase that affects production traffic.

1. Vercel dashboard → existing project → Settings → Git → **screenshot the current env-var list** before doing anything
2. Same screen → **Disconnect** from old repo
3. Same screen → **Connect Git Repository** → pick `Hi-Merkado/userportal-v2`
4. Verify framework preset is Nuxt and build command is unchanged
5. Verify all env vars persisted across the disconnect-reconnect; if any are missing, re-paste from the screenshot (or your production `.env`)
6. Trigger a manual deploy on `main`
7. If build fails: most likely missing env var or build-script path that referenced the old repo name — debug from logs
8. Smoke-test the deployed site (Phase E checklist)

The Vercel **project** itself is not re-created — same project, just re-pointed. This preserves the production domain across cutover; end users see no change.

Should be done in a low-traffic window (late night PHT or weekend) — there's a 5–15 minute deploy-paused window.

### Phase E — Post-cutover verification (before archive)

Smoke test on the new-repo deployment:

- Log in as a real user (admin role)
- Load `/listings` — table renders, thumbnails fetch
- Open a listing detail page — gallery loads, History drawer opens, Edit button routes to `/listings/{id}/edit`
- Create a draft listing via the wizard at `/listings/new` — full publish flow (confirms the per-sqm fix shipped: `sale_price_per_sqm` and `rent_price_per_sqm` must NOT be in the insert payload)
- Open `/deals` — workflow panel, kanban renders
- Open `/documents` — viewing-list creator + an envelope path
- Check `/api/health` returns the new commit SHA
- No 500s in Vercel logs in the first hour post-cutover

Optional 24h soak — leave both repos technically valid (old not yet archived) for a day before Phase F.

### Phase F — Old-repo archival (last, semi-irreversible)

1. GitHub → `Hi-Merkado/housing-interactive-user-portal` → Settings → bottom → **Archive this repository**
2. Repo becomes read-only. Issues / PRs / history all stay browsable; no new pushes / PRs / issues accepted
3. Reversible (Unarchive button) — but if you need to unarchive, something went wrong in Phase E and you should investigate, not paper over

After Phase F, local developer migration:

4. Each developer: clone new repo, copy local `.env` over, install deps
5. Old local clone can be deleted or kept as historical reference

## URL rewrites

Before Phase B's `git commit`, sweep the working tree for references to the old repo URL or name. Expected hits:

- `package.json` — `repository.url` field if set
- `README.md` (root, if exists)
- `CLAUDE.md` — likely references the repo or working directory path
- `docs/**/*.md` — specs / runbooks
- `supabase/MIGRATIONS.md` — likely

Concrete grep before commit:

```powershell
# In the snapshot directory, before `git add -A`:
Get-ChildItem -Recurse -Include *.md,*.json,*.toml -File `
  | Select-String -Pattern "housing-interactive-user-portal" -SimpleMatch
```

Replace `housing-interactive-user-portal` with `userportal-v2` and `Hi-Merkado/housing-interactive-user-portal` with `Hi-Merkado/userportal-v2`. Eyeball each hit — some references may be intentional (e.g., "migrated from housing-interactive-user-portal on 2026-05-13") and should stay.

## Risk / rollback

| Phase | Failure mode | Recovery |
|---|---|---|
| A | Wizard test reveals bug | Fix wizard, return to A1. No state lost. |
| B | Bad URL rewrite, snapshot is wrong | Delete `userportal-v2-snapshot/`, redo from `git clone`. New repo not pushed yet. |
| C | Bad branch protection / missing secret | Edit settings in GitHub UI. No traffic affected yet. |
| D | Vercel build fails on new repo | In Vercel → Git → reconnect to OLD repo. Old repo never lost commits; production resumes. New repo becomes dead inventory until fixed. |
| E | Smoke test reveals regression | Same as D — disconnect new, reconnect old. Investigate before retrying. |
| F | Realized after archive that something was wrong | Unarchive (GitHub button), reconnect Vercel, investigate. |

The point of no easy return is **Phase F + 30 days** — GitHub's archive policy preserves the repo, but team-policy convention is "archived = don't touch." Treat F as a one-way door for planning purposes.

## Memory system continuity

`C:\Users\tylte\.claude\projects\C--Users-tylte-Desktop-Housing-Interactive-HQ-housing-interactive-user-portal-main\memory\` is keyed to the OLD working directory path. When the new repo clones into `userportal-v2/`, Claude Code creates a fresh memory directory keyed to that path. To preserve existing memories (`MEMORY.md` + the individual memory `.md` files), manually copy them into the new project's memory directory on first Claude Code session in v2.

The existing memories are about code patterns (thumbnail source, no mid-script imports, `has_permission` signature) and remain valid in v2.

## Open items (must be resolved before Phase D)

1. **Other consumers of the old repo URL.** Vercel is the known consumer. Are there others — a separate website repo that imports from this one, a CI pipeline in a sibling repo, partner integration, internal admin tool — that need updating? User to enumerate before Phase D.
2. **Cutover window.** Pick a specific low-traffic window for Phase D (late night PHT or weekend recommended).
3. **`gh` CLI install.** Decide whether to install `winget install GitHub.cli` to enable scripted enumeration of secrets / webhooks / open PRs from the old repo. Otherwise this is done by hand in the GitHub UI.
4. **Open PRs on old repo.** Couldn't enumerate without `gh`. If any are open and merge-worthy, merge before Phase D; if any are work-in-progress, decide whether to reapply on v2 or abandon.
5. **Repo secrets.** Need to enumerate what the old repo has (via `gh secret list` or the GitHub UI) to know what Phase C step 3 must re-add.

## Not in scope

- Changes to application code (the snapshot is byte-for-byte identical to old-repo HEAD)
- Changes to Supabase project, env vars, deployed infrastructure
- Re-org of `docs/` or migration of the existing memory system
- CI/CD adoption (adding GitHub Actions — separate decision, possibly a follow-up project)
- Squashing the existing repo's history in-place (rejected — the chosen path is "new repo")
