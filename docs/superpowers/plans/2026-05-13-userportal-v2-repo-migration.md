# userportal-v2 Repo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the current codebase from `Hi-Merkado/housing-interactive-user-portal` to a fresh repo `Hi-Merkado/userportal-v2` with a single squashed initial commit, then archive the old repo.

**Architecture:** Six-phase cutover documented in `docs/superpowers/specs/2026-05-13-userportal-v2-repo-migration-design.md`. Phases A–C are non-destructive setup. Phase D (Vercel reconnect) is the only step that touches production traffic. Phases E–F are post-cutover verification and archival.

**Tech Stack:** Git (Windows / PowerShell), GitHub web UI, Vercel dashboard, optionally GitHub CLI (`gh`).

---

## Pre-flight: resolve open items

Before starting Task 1, three Open Items from the spec must be resolved:

1. **Other consumers of the old repo URL** — Search any other Hi-Merkado repos, internal admin tools, partner integrations for references to `housing-interactive-user-portal`. Each will need updating in Phase D or after Phase F. **Document the list in this plan file under "Known consumers" before continuing.**
2. **Cutover window** — Pick a specific date/time for Phase D. Late-night PHT (Philippine Time) or weekend recommended. Production deploys are paused for 5–15 min during Vercel reconnect.
3. **Open PRs on old repo** — Visit `https://github.com/Hi-Merkado/housing-interactive-user-portal/pulls?q=is%3Apr+is%3Aopen` in a browser. For each open PR: decide merge-before-cutover or abandon. Document the decision per PR.

Optionally: install `gh` CLI now for scripted discovery: `winget install GitHub.cli`. The plan assumes `gh` is NOT installed — UI-based fallbacks are documented.

---

## Phase A — Pre-cutover (this repo, current branch)

### Task 1: Browser-test wizard publish flow

**Files:** None modified — manual UI test.

- [ ] **Step 1: Start dev server**

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ\housing-interactive-user-portal-main"
pnpm dev
```

Expected: Nuxt dev server boots, accessible at `http://localhost:3000`.

- [ ] **Step 2: Navigate to `/listings/new`**

Open `http://localhost:3000/listings/new` in the browser. Confirm the AddListingWizard renders with step 1 active.

- [ ] **Step 3: Walk the wizard to publish**

Fill in minimum required fields across all 6 steps. Use `for_sale=true` with a non-zero sale_price (this exercises the per-sqm path that was broken). On step 6, click Publish.

Expected: Toast says "Listing published successfully". Browser network tab shows `POST /rest/v1/listings` returning 201 (NOT 400 PGRST204). Browser console has no errors.

- [ ] **Step 4: Verify the new listing appears**

Navigate to `/listings`. Confirm the newly published listing appears in the table with the correct title and price.

Expected: Listing row renders. No console errors.

### Task 2: Browser-test wizard edit flow

**Files:** None modified — manual UI test.

- [ ] **Step 1: Open edit page for the listing just created**

Click the listing's row to open the detail page, then click the "✎ Edit" button. URL should be `/listings/{id}/edit`.

Expected: Wizard mounts in edit mode. Header shows "Listing #{id} — changes are tracked in the activity log". Form fields are pre-populated from the existing listing data.

- [ ] **Step 2: Modify one field and save**

Change the description. Click "Save changes" on step 6.

Expected: Toast says save succeeded. Network tab shows `PATCH /rest/v1/listings` returning 200.

- [ ] **Step 3: Open history drawer**

On the listing detail page, click the "⏱ History" button.

Expected: Drawer opens. Shows a `listing.updated` entry with the field-level diff (old description → new description).

### Task 3: Commit + push wizard work

**Files:**
- Modify (commit): `app/components/listings/AddListingWizard.vue`
- Modify (commit): `app/components/listings/ListingDetailContent.vue`
- Modify (commit): `app/pages/listings/[id]/edit.vue`

- [ ] **Step 1: Stage the 3 wizard files**

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ\housing-interactive-user-portal-main"
git add app/components/listings/AddListingWizard.vue `
        app/components/listings/ListingDetailContent.vue `
        app/pages/listings/[id]/edit.vue
git status
```

Expected: All 3 files appear under "Changes to be committed". No other files staged.

- [ ] **Step 2: Commit with a feat message**

```powershell
git commit -m @'
feat(listings): wizard edit-mode end-to-end

AddListingWizard now accepts a `listingId` prop and switches into
edit mode: hydrates form from the existing listing (parallel fetch
of listing/attributes/amenities/images), shows existing photos with
mark-for-delete + thumbnail-pick, branches submit to _updateListing,
surfaces a View History button.

edit.vue replaces the legacy NewForm.vue path (TDZ-prone, missing
the wizard's new fields).

ListingDetailContent adds inline History + Edit buttons in the
detail header.

Per-sqm fields are intentionally NOT in listingPayload — those are
computed columns on the listing_details MV; writing them PGRST204s.
'@
```

Expected: Commit succeeds. New commit appears on `git log -1 --oneline`.

- [ ] **Step 3: Push to origin**

```powershell
git push
```

Expected: Push succeeds. `git status` shows "Your branch is up to date with 'origin/launch-readiness-2026-05-08'".

---

## Phase B — Snapshot creation

### Task 4: Shallow clone the launch-readiness branch into a sibling directory

**Files:**
- Create: `C:\Users\tylte\Desktop\Housing Interactive HQ\userportal-v2-snapshot\` (new dir)

- [ ] **Step 1: Run the shallow clone**

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ"
git clone --depth 1 --branch launch-readiness-2026-05-08 `
  https://github.com/Hi-Merkado/housing-interactive-user-portal.git `
  userportal-v2-snapshot
```

Expected: Clone completes. New directory `userportal-v2-snapshot\` appears next to `housing-interactive-user-portal-main\`. PowerShell may emit CRLF warnings — expected, harmless.

- [ ] **Step 2: Verify the snapshot points at the right HEAD**

```powershell
cd userportal-v2-snapshot
git log -1 --oneline
git rev-parse HEAD
```

Expected: Output matches the HEAD of `launch-readiness-2026-05-08` from Task 3 Step 3 — same SHA. If they differ, abort and re-run with the correct `--branch` flag.

### Task 5: Find references to the old repo URL in tracked content

**Files:** None modified — discovery only.

- [ ] **Step 1: Grep for old repo references in markdown / JSON / TOML**

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ\userportal-v2-snapshot"
Get-ChildItem -Recurse -Include *.md,*.json,*.toml -File `
  | Select-String -Pattern "housing-interactive-user-portal" -SimpleMatch `
  | Select-Object Path, LineNumber, Line
```

Expected: A list of lines with hits. Likely candidates: `package.json`, `CLAUDE.md`, `README.md` (if exists), `docs/**/*.md`, `supabase/MIGRATIONS.md`.

- [ ] **Step 2: Also check for any hardcoded full GitHub URL**

```powershell
Get-ChildItem -Recurse -Include *.ts,*.js,*.vue,*.md,*.json -File `
  | Select-String -Pattern "github\.com/Hi-Merkado" -CaseSensitive
```

Expected: A list of file:line hits. Eyeball each — some hits may be inside copy/comments that are still semantically correct after rewrite, others may be inside historical references that should stay verbatim ("migrated from X").

- [ ] **Step 3: Write the hit list to a local notes file**

Save the combined output of Steps 1 + 2 to `C:\Users\tylte\Desktop\Housing Interactive HQ\url-rewrites.txt` — used in Task 6 to track which files need editing.

### Task 6: Apply URL rewrites in the snapshot

**Files:**
- Modify: Each file listed in `url-rewrites.txt` from Task 5

- [ ] **Step 1: Open each file from the hit list**

For each unique file path in `url-rewrites.txt`, open and review the matching line(s).

- [ ] **Step 2: Decide per-line: rewrite, keep, or delete**

Rules:
- **Rewrite** `housing-interactive-user-portal` → `userportal-v2` for live references (e.g., `package.json` `repository.url`, README clone instructions, CLAUDE.md current-state pointers)
- **Keep** for historical references ("migrated from housing-interactive-user-portal on 2026-05-13", "originally housed at github.com/Hi-Merkado/housing-interactive-user-portal", commit messages quoted verbatim)
- **Delete** if the entire reference is no longer relevant (rare)

- [ ] **Step 3: Apply edits in your editor**

Use VS Code / your editor of choice for find-replace on each file. Do NOT use a single global find-replace — review each hit.

- [ ] **Step 4: Re-grep to verify only intentional references remain**

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ\userportal-v2-snapshot"
Get-ChildItem -Recurse -Include *.md,*.json,*.toml -File `
  | Select-String -Pattern "housing-interactive-user-portal" -SimpleMatch
```

Expected: Remaining hits should match the historical-reference list you intentionally preserved. No live links to the old repo.

### Task 7: Wipe history, re-init, create the initial commit, push

**Files:**
- Delete: `userportal-v2-snapshot\.git\` (entire dir)
- Create: fresh `userportal-v2-snapshot\.git\` (via `git init`)

- [ ] **Step 1: Remove the existing .git directory**

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ\userportal-v2-snapshot"
Remove-Item -Recurse -Force .git
Get-ChildItem -Force -Name | Select-Object -First 20
```

Expected: `.git` no longer in the directory listing. All tracked files still present (the snapshot's working tree is untouched).

- [ ] **Step 2: Initialize new repo with `main` as default branch**

```powershell
git init -b main
```

Expected: "Initialized empty Git repository in .../userportal-v2-snapshot/.git/".

- [ ] **Step 3: Stage everything and make the initial commit**

```powershell
git add -A
git status
```

Expected: Long list of files under "Changes to be committed". CRLF warnings may appear — harmless.

```powershell
git commit -m "Initial commit — userportal-v2"
```

Expected: Single commit created. `git log` shows exactly one commit.

- [ ] **Step 4: Add the new remote**

```powershell
git remote add origin https://github.com/Hi-Merkado/userportal-v2.git
git remote -v
```

Expected: `origin` shows `https://github.com/Hi-Merkado/userportal-v2.git` for both fetch and push.

- [ ] **Step 5: Push to the new repo**

**STOP** before this step — verify `Hi-Merkado/userportal-v2` exists in GitHub and is empty (no auto-init README, no .gitignore). Visit `https://github.com/Hi-Merkado/userportal-v2` in a browser to confirm.

```powershell
git push -u origin main
```

Expected: Push succeeds. Browser refresh of the new repo URL shows the full codebase, exactly one commit.

If the new repo doesn't exist yet: create it via GitHub web UI now — **Create a new repository**, owner: `Hi-Merkado`, name: `userportal-v2`, visibility: match the old repo, **DO NOT** initialize with README/gitignore/license. Then retry the push.

---

## Phase C — GitHub-side setup

### Task 8: Set branch protection on `main`

**Files:** None — GitHub UI configuration.

- [ ] **Step 1: Navigate to branch protection settings**

Open `https://github.com/Hi-Merkado/userportal-v2/settings/branches`.

- [ ] **Step 2: Add a rule for `main`**

Click "Add branch protection rule" or "Add rule". Branch name pattern: `main`.

- [ ] **Step 3: Configure the rule**

Enable:
- [x] **Require a pull request before merging** (set required reviewers to 0 if solo, 1+ if team)
- [x] **Require linear history** (matches the "clean linear history" goal — prevents merge commits)
- [x] **Do not allow bypassing the above settings** (or leave unchecked if you want admin override)

Disable (leave unchecked):
- [ ] Require deployments to succeed before merging (no GitHub Actions yet)
- [ ] Lock branch (would block your own pushes)

- [ ] **Step 4: Save the rule**

Click "Create" or "Save changes". Confirm the rule appears in the list.

### Task 9: Enumerate old-repo secrets

**Files:** None — GitHub UI discovery.

- [ ] **Step 1: Open old repo secrets page**

Browser: `https://github.com/Hi-Merkado/housing-interactive-user-portal/settings/secrets/actions`.

- [ ] **Step 2: Document the list**

Screenshot the secrets list. Each entry shows the name (values are hidden — that's fine, you'll re-enter from your local `.env` or password manager).

If `gh` CLI is installed, alternative:

```powershell
gh secret list --repo Hi-Merkado/housing-interactive-user-portal
```

- [ ] **Step 3: Mark which secrets are still in use**

For each secret, check `nuxt.config.ts` and `server/utils/*` for `process.env.<NAME>` references. If a secret is unreferenced (dead config), DON'T migrate it to the new repo. Document the live-vs-dead split in a notes file.

### Task 10: Re-add live secrets to new repo

**Files:** None — GitHub UI configuration.

- [ ] **Step 1: Open new repo secrets page**

Browser: `https://github.com/Hi-Merkado/userportal-v2/settings/secrets/actions`.

- [ ] **Step 2: Add each live secret from Task 9**

For each secret name in the "live" list: click "New repository secret", paste name + value (from your local `.env` or password manager), click "Add secret".

- [ ] **Step 3: Verify counts match**

The count of secrets on the new repo's page should equal the count of "live" secrets identified in Task 9.

### Task 11: Mirror collaborator / team access

**Files:** None — GitHub UI configuration.

- [ ] **Step 1: List old repo collaborators**

Browser: `https://github.com/Hi-Merkado/housing-interactive-user-portal/settings/access`.

Screenshot the team + individual access list.

- [ ] **Step 2: Replicate on new repo**

Browser: `https://github.com/Hi-Merkado/userportal-v2/settings/access`. Add the same teams and collaborators with matching permission levels.

---

## Phase D — Vercel re-link (cutover risk window)

This is the only phase that affects production traffic. Pause active deploys on the OLD repo's `main` if any are queued (best-effort — Vercel doesn't formally "pause," but don't push to the old repo's main during this window).

### Task 12: Screenshot Vercel env vars before any changes

**Files:** None — Vercel UI screenshot.

- [ ] **Step 1: Open the Vercel project's env vars page**

Vercel dashboard → project → Settings → Environment Variables.

- [ ] **Step 2: Screenshot the full list (all environments: Production, Preview, Development)**

Keep this screenshot accessible — if Vercel doesn't persist env vars across the disconnect-reconnect in Task 13, you'll need to re-paste from this screenshot or your local `.env`.

### Task 13: Disconnect old repo, connect new repo in Vercel

**Files:** None — Vercel UI configuration.

- [ ] **Step 1: Disconnect old repo**

Vercel dashboard → project → Settings → Git → click "Disconnect". Confirm.

Expected: Project shows "no git repository connected". Deploys paused.

- [ ] **Step 2: Connect new repo**

Same Git settings page → "Connect Git Repository" → pick `Hi-Merkado/userportal-v2`.

Expected: Project connects. Framework preset should auto-detect Nuxt. Build command should be unchanged from the old repo's project (likely `pnpm build` or `nuxt build`).

- [ ] **Step 3: Verify framework + build settings**

Vercel project → Settings → General → confirm Framework Preset is "Nuxt.js" (or matches whatever was set before). Confirm Build Command and Output Directory are unchanged.

- [ ] **Step 4: Verify env vars persisted**

Vercel project → Settings → Environment Variables → compare against the screenshot from Task 12.

If any are missing: re-add them from the screenshot. If all persist: continue.

### Task 14: Trigger manual deploy + verify

**Files:** None — Vercel UI action.

- [ ] **Step 1: Trigger deploy**

Vercel dashboard → project → Deployments → "Redeploy" the latest commit (which should now be `Initial commit — userportal-v2`), or push a no-op commit to `main` of the new repo.

Alternative no-op trigger:

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ\userportal-v2-snapshot"
git commit --allow-empty -m "chore: trigger initial Vercel build"
git push
```

- [ ] **Step 2: Watch build logs**

Vercel deployments page → click the in-progress deploy. Watch logs.

Expected: Build completes successfully. Status: "Ready". Production URL still resolves.

If build fails: read the error. Most common causes:
- Missing env var → re-check Task 13 Step 4
- Build script references a path that doesn't exist in the snapshot → check the build command + verify the file exists in `userportal-v2-snapshot/`

- [ ] **Step 3: Verify production domain serves the new build**

In a browser, visit your production domain. Open dev tools → Network tab → reload.

Expected: The site loads. The response headers or page footer should show the new commit SHA (if you have a build-stamp in the footer).

---

## Phase E — Post-cutover verification

### Task 15: Production smoke test

**Files:** None — manual production testing.

- [ ] **Step 1: Auth flow**

Log in as a real admin user on production. Confirm session works.

- [ ] **Step 2: Listings table loads**

Navigate to `/listings`. Confirm: table renders, thumbnails fetch, search/filter works.

- [ ] **Step 3: Listing detail loads**

Click any listing → confirm: gallery loads, History drawer opens, Edit button routes to `/listings/{id}/edit`.

- [ ] **Step 4: Wizard publish works on production**

`/listings/new` → fill in fields → publish. Confirm publish succeeds (this is the canary that the per-sqm fix shipped).

- [ ] **Step 5: Deals + Documents surfaces**

`/deals` — kanban + workflow panel render. `/documents` — viewing-list creator renders. Open any envelope. Confirm no 500s.

- [ ] **Step 6: Health endpoint reports new SHA**

```powershell
Invoke-WebRequest "https://YOUR-PORTAL-URL/api/health" | Select-Object -ExpandProperty Content
```

Expected: Response includes the SHA of `Initial commit — userportal-v2`.

- [ ] **Step 7: Vercel logs clean**

Vercel project → Logs (Functions / Edge / etc.) → filter to last 1 hour. Confirm no 500s, no unhandled errors.

### Task 16: Optional 24h soak

**Files:** None — wait period.

- [ ] **Step 1: Decide whether to soak**

If high-confidence in Task 15, skip to Task 17. If any concerns, wait 24 hours before Task 17 — gives time for slow-burn errors (cron jobs, scheduled tasks, low-traffic endpoints) to surface.

- [ ] **Step 2: During soak: monitor Vercel logs daily**

Check Vercel Logs once during the soak period. Look for unusual error spikes.

---

## Phase F — Old-repo archival (last, semi-irreversible)

### Task 17: Archive old repo

**Files:** None — GitHub UI configuration.

- [ ] **Step 1: Open old repo settings**

Browser: `https://github.com/Hi-Merkado/housing-interactive-user-portal/settings`.

- [ ] **Step 2: Scroll to "Danger Zone" → Archive this repository**

Click "Archive this repository". Type the repo name to confirm. Submit.

Expected: Repo becomes read-only. Banner shows "This repository has been archived by the owner."

### Task 18: Rename snapshot directory to its final name

**Files:**
- Rename: `userportal-v2-snapshot\` → `userportal-v2\`

- [ ] **Step 1: Move out of the directory if you're in it**

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ"
```

- [ ] **Step 2: Rename**

```powershell
Rename-Item -Path userportal-v2-snapshot -NewName userportal-v2
```

Expected: New dir `userportal-v2\` exists; `userportal-v2-snapshot\` no longer exists.

### Task 19: Copy memory directory to new project location

**Files:**
- Source: `C:\Users\tylte\.claude\projects\C--Users-tylte-Desktop-Housing-Interactive-HQ-housing-interactive-user-portal-main\memory\`
- Destination: `C:\Users\tylte\.claude\projects\C--Users-tylte-Desktop-Housing-Interactive-HQ-userportal-v2\memory\`

- [ ] **Step 1: Start a Claude Code session in the renamed directory**

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ\userportal-v2"
```

Open Claude Code from this directory. Claude will create the project memory dir on first interaction (the dir name mirrors the path with `\` → `-`).

- [ ] **Step 2: Verify the new project memory dir was created**

```powershell
Test-Path "C:\Users\tylte\.claude\projects\C--Users-tylte-Desktop-Housing-Interactive-HQ-userportal-v2\memory"
```

Expected: `True`. If `False`, send Claude Code one prompt (anything) — the dir is created on first interaction, not on launch.

- [ ] **Step 3: Copy memory files**

```powershell
$src = "C:\Users\tylte\.claude\projects\C--Users-tylte-Desktop-Housing-Interactive-HQ-housing-interactive-user-portal-main\memory"
$dst = "C:\Users\tylte\.claude\projects\C--Users-tylte-Desktop-Housing-Interactive-HQ-userportal-v2\memory"
Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force
```

Expected: `MEMORY.md` + the individual memory `.md` files now exist in the new project dir. Verify with:

```powershell
Get-ChildItem $dst
```

### Task 20: Delete old local clone

**Files:**
- Delete: `housing-interactive-user-portal-main\` (entire dir)

- [ ] **Step 1: Confirm new clone is fully working**

Verify Task 15 still passes against production. Verify you can run `pnpm dev` in `userportal-v2/`.

- [ ] **Step 2: Optionally back up the old clone first**

If you want a local archive (paranoia is healthy):

```powershell
cd "C:\Users\tylte\Desktop\Housing Interactive HQ"
Compress-Archive -Path housing-interactive-user-portal-main -DestinationPath housing-interactive-user-portal-main_archived.zip
```

- [ ] **Step 3: Delete the old directory**

```powershell
Remove-Item -Recurse -Force housing-interactive-user-portal-main
```

Expected: Directory gone. The archived old repo on GitHub (Task 17) is the only remaining record.

---

## Known consumers of old repo URL

Resolved 2026-05-13:

- **Vercel** — only known consumer. Phase D Tasks 12–14 cover the reconnect.
- **AWS** — confirmed S3-only (image storage). NOT wired to GitHub. No migration action needed.
- Slack pins / docs in other systems — not enumerated; GitHub URL redirects from archived repos keep these working, so deferred as nice-to-update post-Phase-F.

## Open PR decisions

Resolved 2026-05-13:

- **None.** Solo repo, no open PRs to merge or migrate.

## Cutover window

**Status:** DEFERRED. User to pick before starting Task 12.

**Phases in scope for current session:** A–C (Tasks 1–11). Non-destructive setup; new repo created and configured but Vercel still points at old repo.

**Phases deferred:** D–F (Tasks 12–20). Requires explicit cutover-window selection + go-ahead before resuming.

---

## Self-review notes

Spec coverage check (Phase → Task mapping):
- Phase A → Tasks 1, 2, 3
- Phase B → Tasks 4, 5, 6, 7
- Phase C → Tasks 8, 9, 10, 11
- Phase D → Tasks 12, 13, 14
- Phase E → Tasks 15, 16
- Phase F → Tasks 17, 18, 19, 20

All open items from the spec are surfaced under "Pre-flight: resolve open items" with explicit fill-in sections at the bottom of this plan.
