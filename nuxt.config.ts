// https://nuxt.com/docs/api/configuration/nuxt-config

export default defineNuxtConfig({
  imports: {
    dirs: ['app/services'],
  },

  // Explicitly register the design-tokens stylesheet. @nuxtjs/tailwindcss's
  // auto-discovery of `~/assets/css/tailwind.css` does not resolve
  // correctly with this project's Nuxt 4 srcDir layout, so the :root
  // design-token block (--background, --primary, --brass, etc.) was
  // silently absent from the production CSS bundle. Tailwind utilities
  // like `bg-background` compiled to `hsl(var(--background)/1)` but
  // those vars were never defined → everything fell back to browser
  // defaults. Registering here forces the file into the entry bundle.
  css: ['~/assets/css/tailwind.css'],

  plugins: ['~/plugins/fontawesome.js'],

  pinia: {
    storesDirs: ['./app/store/**'],
  },

  vite: {
    optimizeDeps: {
      include: ['@supabase/ssr > cookie'],
    },
    build: {
      sourcemap: false,
      // This app intentionally ships several large, rarely-changing vendor
      // libraries (PDF, DOCX, spreadsheet, maps/media tooling). Keep Vite's
      // chunk reporter quiet unless a chunk crosses a genuinely abnormal size.
      chunkSizeWarningLimit: 3500,
      rollupOptions: {
        onwarn(warning, defaultHandler) {
          if (
            warning.plugin === 'nuxt:module-preload-polyfill'
            && warning.message.includes('Sourcemap is likely to be incorrect')
          ) {
            return
          }

          defaultHandler(warning)
        },
        output: {
          manualChunks(id) {
            const normalizedId = id.replaceAll('\\', '/')

            if (normalizedId.includes('@nuxtjs/supabase/dist/runtime/server/services')) {
              return 'nuxt-supabase-server-services'
            }
          },
        },
      },
    },
    // Drop noisy dev-only console calls from the production bundle. Marking
    // them pure lets esbuild dead-code-eliminate them. console.error survives
    // because it's a real error path; route errors should flow through pino
    // (server) or a future structured client logger.
    esbuild: {
      pure:
        process.env.NODE_ENV === 'production'
          ? ['console.log', 'console.warn', 'console.info', 'console.debug', 'console.trace']
          : [],
    },
  },
  devtools: { enabled: true },

  routeRules: {
    // Disable HTTP caching on every Nitro-served response. Hashed assets
    // under /_nuxt/** and /_ipx/** keep their own immutable headers from
    // Nitro's static handler. Remove this rule to restore default cache
    // behavior.
    '/**': { headers: { 'cache-control': 'no-store' } },
    '/': { redirect: '/login' },
    // Decommissioned surfaces — bookmarks land on the live equivalents.
    // We use 301 (permanent) so search engines + browser history forget
    // the old URLs.
    '/contacts-legacy':  { redirect: { to: '/contacts',  statusCode: 301 } },
    '/documents-legacy': { redirect: { to: '/documents', statusCode: 301 } },
    '/archives':         { redirect: { to: '/listings',  statusCode: 301 } },
    '/outdated':         { redirect: { to: '/listings',  statusCode: 301 } },
  },

  nitro: {
    rollupConfig: {
      onwarn(warning, defaultHandler) {
        const message = warning.message || ''

        if (
          warning.code === 'THIS_IS_UNDEFINED'
          && message.includes('puppeteer-core')
        ) {
          return
        }

        if (
          ['CIRCULAR_DEPENDENCY', 'EVAL'].includes(warning.code || '')
          || message.includes('Unsupported source map comment')
        ) {
          return
        }

        defaultHandler(warning)
      },
    },
    prerender: {
      ignore: [
        '/documents',
        '/viewing-list-tabs',
        '/documents-old',
        '/document-tabs',
        '/contracts-list-tabs',
      ]
    },
    // Externalize heavy server-only packages so Nitro doesn't try to
    // bundle them. Without this, puppeteer's native binary + tens of
    // thousands of bidi/cdp helper modules get pulled into the server
    // bundle and rollup fires hundreds of "this keyword at top level"
    // warnings. Same logic for docusign-esign (uses dynamic require)
    // and the AWS SDK (large + reads native fs APIs at runtime).
    externals: {
      external: [
        'puppeteer',
        'puppeteer-core',
        'docusign-esign',
        '@aws-sdk/client-s3',
        '@aws-sdk/s3-request-presigner',
        '@aws-sdk/client-secrets-manager',
      ],
    },
  },

  app: {
    head: {
      title: 'Housinginteractive',
      htmlAttrs: {
        lang: 'en',
      },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { id: 'description', name: 'description', content: '' },
        { name: 'format-detection', content: 'telephone=no' },
      ],
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        // Estate aesthetic — Fraunces serif for display headings.
        // opsz 9..144 lets the variable font tune optical size to the
        // rendering size; weights 400/500/600 cover .text-page-title /
        // .text-section-title / emphasized variants.
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap',
        },
      ],
    },
  },

  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/supabase', '@vee-validate/nuxt', '@pinia/nuxt'],

  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
    secretKey:
      process.env.NUXT_SUPABASE_SECRET_KEY
      || process.env.SUPABASE_SECRET_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY,
    types: '~~/server/utils/database.types.ts',
    redirect: false,
    cookieOptions: {
      secure: true,
      sameSite: 'lax',
    },
  },

  components: [
    {
      path: '~/components',
      pathPrefix: false, // Avoid duplicate names: ui/Input.vue -> UiInput, tables/Table.vue -> TablesTable, pages/contacts/SuggestionBox.vue -> PagesContactsSuggestionBox
    },
  ],

  runtimeConfig: {
    // Private (server-side only)
    // Private (server-only)
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    // Kill switch for public inquiries (e.g., during incidents).
    PUBLIC_INQUIRIES_DISABLED: process.env.PUBLIC_INQUIRIES_DISABLED,
    // Email delivery is currently disabled at the helper level
    // (server/utils/email.ts is a no-op stub). This flag is kept
    // for backward compat with code that checks it; setting it
    // changes nothing operationally until an email provider is
    // wired back in.
    EMAIL_DELIVERY_DISABLED: process.env.EMAIL_DELIVERY_DISABLED,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,

    // Bridge two env-var spellings for the Supabase service-role key.
    // @nuxtjs/supabase reads `runtimeConfig.supabase.serviceKey`, which
    // it auto-populates from `process.env.SUPABASE_SERVICE_KEY`. The
    // Supabase dashboard + most ecosystem docs label this same secret
    // `SUPABASE_SERVICE_ROLE_KEY`, so users who follow the canonical
    // naming end up with a missing serviceKey at runtime + spurious
    // "ai_config_service_key_missing" 503s on the AI endpoints.
    // Override here with a fall-through so either name in `.env`
    // resolves the same key.
    supabase: {
      serviceKey:
        process.env.SUPABASE_SERVICE_KEY
        || process.env.SUPABASE_SERVICE_ROLE_KEY
        || '',
      secretKey:
        process.env.NUXT_SUPABASE_SECRET_KEY
        || process.env.SUPABASE_SECRET_KEY
        || process.env.SUPABASE_SERVICE_ROLE_KEY
        || '',
    },

    public: {
      S3_BUCKET_NAME: process.env.S3_BUCKET_NAME,
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_KEY,
      AWS_REGION: process.env.AWS_REGION,
      WEBSITE_URL: process.env.WEBSITE_URL,
    },
  },

  build: {
    transpile: [
      '@fortawesome/vue-fontawesome',
      '@fortawesome/fontawesome-svg-core',
      '@fortawesome/free-solid-svg-icons'
    ],
  },

  compatibilityDate: '2026-04-29',
})
