import type { EventHandler, H3Event } from 'h3'
import type { ZodSchema } from 'zod'
import { ZodError } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from './logger'

type AuthMode = 'required' | 'optional'

type HandlerCtx<Q, B, U> = {
  event: H3Event
  query: Q
  body: B
  user: U
}

type Opts<Q, B, R, U> = {
  query?: ZodSchema<Q>
  body?: ZodSchema<B>
  auth?: AuthMode
  handler: (ctx: HandlerCtx<Q, B, U>) => Promise<R> | R
}

export const defineApiHandler = <Q = unknown, B = unknown, R = unknown>(
  opts: Opts<Q, B, R, any>,
): EventHandler => {
  const auth: AuthMode = opts.auth ?? 'required'

  return defineEventHandler(async (event) => {
    const method = getMethod(event)

    // Fetch the user via the @supabase/supabase-js client directly rather
    // than the module's `serverSupabaseUser` helper. As of @nuxtjs/supabase
    // v2 that helper switched to `auth.getClaims()` and returns JWT claims
    // (`{ sub, email, exp, role, ... }`) instead of the legacy User shape
    // (`{ id, email, ... }`). Most of this codebase reads `user.id`, so the
    // v2 shape silently returned `undefined` everywhere — surfacing as
    // "invalid input syntax for type uuid: undefined" deep inside handlers
    // and, more recently, as a 401 wave once we tightened the auth gate.
    //
    // Going through `client.auth.getUser()` keeps the User shape stable
    // regardless of which @nuxtjs/supabase version is installed, so every
    // existing `user.id` reference keeps working without a sweep.
    let user: any = null
    try {
      const client = await serverSupabaseClient(event)
      const { data, error } = await (client as any).auth.getUser()
      if (!error) user = data?.user ?? null
    } catch {
      user = null
    }

    if (auth === 'required' && (!user || !user.id)) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
    }

    let query: Q = getQuery(event) as Q
    let body: B = null as unknown as B

    try {
      if (opts.query) query = opts.query.parse(query)
      if (opts.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        const raw = await readBody(event)
        body = opts.body.parse(raw)
      }
    } catch (err) {
      if (err instanceof ZodError) {
        throw createError({
          statusCode: 422,
          statusMessage: 'Validation failed',
          data: { issues: err.issues },
        })
      }
      throw err
    }

    try {
      return await opts.handler({ event, query, body, user })
    } catch (err: any) {
      if (err.statusCode) throw err
      logger.error(
        { err: err?.message, stack: err?.stack, route: event.path, userId: user?.id },
        'api_error',
      )
      // In development, surface the underlying error in the response body
      // so the failing endpoint is debuggable without scraping server
      // logs. Production stays opaque ("Internal Server Error" only).
      const isDev = process.env.NODE_ENV !== 'production'
      throw createError({
        statusCode:    500,
        statusMessage: isDev ? `Internal Server Error: ${err?.message ?? 'unknown'}` : 'Internal Server Error',
        data:          isDev ? { error: err?.message, stack: err?.stack, route: event.path } : undefined,
      })
    }
  })
}
