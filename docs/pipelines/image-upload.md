# Image upload (wizard → S3 → gallery)

Agents upload listing photos via the Add Listing wizard. Files go to S3 under `properties/property-<id>/`, optionally resized into the `635x423` thumbnail prefix. The detail page's gallery component lists S3 objects by prefix + size key. Thumbnail derivation is server-side (lambda or pre-resize at upload).

## Components

### Wizard
- `app/components/listings/AddListingWizard.vue` — multi-step form. Photos step picks files and stages them. On submit, calls `ListingService._uploadListingImages()`.
- `ListingService._uploadListingImages` (in `app/services/...`) — uploads via signed S3 PUT.
- **Critical fix 2026-05-14**: the submit AWAITS the upload before `router.push` to the detail page. Without await, the gallery raced ahead of S3 and showed "No photos."

### S3 layout
```
s3://<bucket>/
  properties/property-<id>/
    image-<globalIndex>-<filename>.jpg     # original
    635x423/image-<globalIndex>-<filename>.jpg  # thumbnail
```

### Gallery
- `/api/listings/get-gallery-images` — lists S3 objects under `properties/property-<id>/` filtered by `635x423` in the key. Returns signed URLs.
- `app/components/Listings/Gallery.vue` (website) — renders the strip.

### DB-side
- `listing_images` table — server-side metadata: `(listing_id, file_name, file_extension)`. Has known drift with S3 (see Failure Modes).

### Thumbnail batch fetch
- `useThumbnails()` composable — batched per-listing thumbnail signed-URL fetch, deduped + cached.

## Operate

### Local dev

1. Set AWS credentials in BOTH portal and website `.env`:
   ```
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   AWS_REGION=ap-southeast-1
   S3_BUCKET_NAME=hi-images-staging
   ```
2. The portal generates signed PUT URLs; the wizard uploads directly to S3 from the browser. CORS on the S3 bucket must allow the website's origin.

### CORS config (one-time)

```json
[
  {
    "AllowedOrigins": ["http://localhost:3001", "http://localhost:3002", "https://*.trycloudflare.com", "https://*.housinginteractive.com.ph"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3000
  }
]
```

### Bulk reupload

If a listing's photos went missing or got out-of-sync, the easiest path is:
1. Open the listing in the wizard's edit mode (`/listings/<id>/edit`).
2. Re-attach the photos.
3. Save — the wizard upserts and re-uploads.

## Smoke

```powershell
# 1. Gallery endpoint returns images for a listing with photos
curl -s "http://localhost:3001/api/listings/get-gallery-images?listing_id=<id>" | jq '.images | length'

# 2. Wizard upload signed URL
curl -s -X POST -H "content-type: application/json" `
  -H "Authorization: Bearer <token>" `
  -d '{\"listing_id\":<id>,\"file_name\":\"test.jpg\"}' `
  http://localhost:3002/api/listings/get-upload-url
# Expect: { url: <signed S3 PUT URL>, key: '...' }
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "No photos" on detail page right after publish | Wizard not awaiting upload (regression) | Restore `await` on `_uploadListingImages` per the 2026-05-14 fix |
| Photos missing for SOME listings | `listing_images.file_name` extension mismatch with S3 key | Known drift — see [[wizard image-upload race fix]] note in `project_open_threads.md` |
| CORS error in browser console | Bucket CORS rule misses the origin | Add origin to allowed list (above) |
| Upload 403 from S3 | Signed URL expired (default 15min) | User retries from the wizard, no fix needed |
| Thumbnail endpoint returns 404 | No `635x423/` derivative for that key | Lambda resizer missed it OR not enabled; check the Lambda's CloudWatch logs |

### Known tech debt (catalogued 2026-05-14)

1. **WizardImage.id vs S3 globalIndex** — `/api/listings/update-thumbnail` searches S3 for `image-<id>-*` but the uploader uses `globalIndex`. They never align → endpoint returns its own 404. Cosmetic because `upload-displayed-images` already pins the first image as the thumbnail.
2. **`dbImagesEngine.uploadImageToDB` uses `.single()` on unfiltered query** — fails on empty `listing_images` table (greenfield envs). Production has data so doesn't fire today.
3. **DB file_name uses CLIENT-supplied extension** while S3 uploader uses server-MIME-validated extension. `.jpg` vs `.jpeg` divergence possible. Gallery currently doesn't read `listing_images` so it hasn't bitten.
4. **`/api/listings/update-thumbnail` 404 is opaque** — should be 422 with structured body.

## Open work

- Lambda resizer audit — verify all listings have `635x423/` derivatives.
- Fix the four catalogued bugs above.
- Add a server-side reconcile job that compares S3 inventory ↔ `listing_images` rows.

## Related guides

- [aggregation-ingest.md](aggregation-ingest.md) — partners can supply image URLs in the raw payload (deferred — not yet wired)
