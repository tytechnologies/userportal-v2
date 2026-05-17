// Build / deploy metadata.
//
// GET /api/build-info → { commit_sha, build_timestamp, environment, repo, runtime }
//
// Public, anonymous, fast. Pairs with /api/health to give incident
// responders both "is this thing alive" and "which version is alive."
//
// Values come from env vars that should be baked at build/deploy time:
//   COMMIT_SHA          — `git rev-parse HEAD` at build
//   BUILD_TIMESTAMP     — ISO timestamp at build
//   NODE_ENV            — production / development
//   PUBLIC_DEPLOY_ENV   — environment label (prod / staging / preview)
//
// Missing values surface as "unknown" rather than 500ing — even an
// incomplete build-info is more useful than nothing.

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'public, max-age=300, s-maxage=300')
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')

  return {
    repo: 'housing-interactive-user-portal',
    commit_sha: process.env.COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
    build_timestamp: process.env.BUILD_TIMESTAMP || 'unknown',
    environment:
      process.env.PUBLIC_DEPLOY_ENV ||
      process.env.NODE_ENV ||
      'unknown',
    runtime: {
      node_version: process.version,
      // process.uptime() is process-uptime in seconds — useful for
      // "did this instance just restart?" checks.
      uptime_seconds: Math.round(process.uptime?.() ?? 0),
    },
    served_at: new Date().toISOString(),
  }
})
