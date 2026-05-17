// DocuSign client helper. Reads platform_settings.docusign for the
// account/key/user/private-key tuple and produces a configured
// ApiClient with a fresh JWT-grant access token.
//
// Why JWT grant rather than Authorization Code: the platform sends
// envelopes on behalf of the brokerage account, not per-broker.
// JWT grant impersonates a single configured user with the account-
// admin scope and matches DocuSign's "service integration" recipe.
//
// The access token is cached for ~50 minutes (DocuSign issues
// 1-hour tokens). If the cached token is stale we refresh on the
// next call. No background refresh — Vercel functions don't have
// stable lifetimes.

// @ts-ignore — `docusign-esign` resolves after `pnpm install`; declared in package.json.
import * as docusign from 'docusign-esign'
import type { H3Event } from 'h3'
import { serverSupabaseServiceRole } from '#supabase/server/serverSupabaseServiceRole'
import { logger } from './logger'

type DocusignConfig = {
  account_id?:     string
  integration_key?: string
  user_id?:        string
  base_uri?:       string
  private_key?:    string
  redirect_uri?:   string
  webhook_secret?: string
}

let cachedToken: { value: string; expiresAt: number } | null = null

export async function readDocusignConfig(event: H3Event): Promise<DocusignConfig> {
  const sr = serverSupabaseServiceRole(event) as any
  const { data, error } = await sr
    .from('platform_settings')
    .select('value')
    .eq('key', 'docusign')
    .maybeSingle()
  if (error) {
    logger.error({ err: error.message, op: 'docusign.config' }, 'docusign_config_read_failed')
    throw createError({ statusCode: 500, statusMessage: 'DocuSign config read failed' })
  }
  return (data?.value ?? {}) as DocusignConfig
}

export function assertConfigured(cfg: DocusignConfig): asserts cfg is Required<DocusignConfig> {
  if (!cfg.account_id || !cfg.integration_key || !cfg.user_id || !cfg.base_uri || !cfg.private_key) {
    throw createError({
      statusCode: 503,
      statusMessage: 'DocuSign is not configured',
      data: { code: 'docusign_not_configured', admin_path: '/admin/esign-settings' },
    })
  }
}

export async function getDocusignClient(event: H3Event): Promise<{
  client: docusign.ApiClient
  accountId: string
}> {
  const cfg = await readDocusignConfig(event)
  assertConfigured(cfg)

  const apiClient = new docusign.ApiClient()
  // base_uri carries the host (na2.docusign.net etc); the SDK wants
  // the /restapi/v2.1 path appended.
  apiClient.setBasePath(`https://${cfg.base_uri}/restapi`)

  // Reuse a recent token if it has >5 minutes left.
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt - now > 5 * 60_000) {
    apiClient.addDefaultHeader('Authorization', `Bearer ${cachedToken.value}`)
    return { client: apiClient, accountId: cfg.account_id }
  }

  apiClient.setOAuthBasePath(cfg.base_uri.includes('demo') ? 'account-d.docusign.com' : 'account.docusign.com')
  try {
    const result = await apiClient.requestJWTUserToken(
      cfg.integration_key,
      cfg.user_id,
      ['signature', 'impersonation'],
      Buffer.from(cfg.private_key, 'utf8'),
      3600, // request a 1-hour token
    )
    const accessToken = (result.body as any).access_token as string
    const expiresIn   = (result.body as any).expires_in as number
    cachedToken = {
      value: accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    }
    apiClient.addDefaultHeader('Authorization', `Bearer ${accessToken}`)
  } catch (err: any) {
    // First-time JWT grant requires a one-off manual consent step
    // ("admin consent" URL with scopes=signature impersonation). The
    // integration owner has to click through it once per env. Surface
    // that case clearly so admins know what to do.
    const body = err?.response?.body
    if (body?.error === 'consent_required') {
      const consentUrl =
        `https://${cfg.base_uri.includes('demo') ? 'account-d.docusign.com' : 'account.docusign.com'}` +
        `/oauth/auth?response_type=code&scope=signature%20impersonation` +
        `&client_id=${cfg.integration_key}` +
        `&redirect_uri=${encodeURIComponent(cfg.redirect_uri || 'https://docusign.com/_consent_callback')}`
      logger.warn(
        { op: 'docusign.consent', consentUrl },
        'docusign_consent_required',
      )
      throw createError({
        statusCode: 503,
        statusMessage: 'DocuSign consent has not been granted yet.',
        data: { code: 'docusign_consent_required', consent_url: consentUrl },
      })
    }
    logger.error({ err: err?.message, op: 'docusign.jwt' }, 'docusign_jwt_failed')
    throw createError({ statusCode: 502, statusMessage: 'DocuSign authentication failed' })
  }

  return { client: apiClient, accountId: cfg.account_id }
}
