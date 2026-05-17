import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

// pino-pretty makes dev logs readable, but it isn't a runtime dependency
// (it's used as a transport target by name). Probe for it at module load
// so the absence of the dev-time pretty printer doesn't crash Nitro's
// server entry — the symptom is "every route returns NuxtWelcome", which
// is hard to diagnose from a single log line.
let prettyAvailable = false
if (isDev) {
  try {
    require.resolve('pino-pretty')
    prettyAvailable = true
  } catch {
    prettyAvailable = false
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  base: { service: 'hi-user-portal' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.access_token',
      '*.refresh_token',
      '*.password',
      '*.SUPABASE_KEY',
      '*.AWS_SECRET_ACCESS_KEY',
    ],
    censor: '[REDACTED]',
  },
  ...(prettyAvailable
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
})
