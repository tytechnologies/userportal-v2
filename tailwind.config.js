
const colors = require('tailwindcss/colors');
const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  content: [
    './app/**/*.{vue,js,ts}',
  ],
    theme: {
        extend: {
            width: {
                26: '6.5rem',
                39: '9.75rem',
                60: '15rem',
                72: '18rem',
                80: '20rem',
                84: '21rem',
                88: '22rem',
                90: '22.5rem',
                120: '28rem',
                128: '32rem',
                132: '33rem',
                136: '34rem',
                140: '35rem',
                148: '36rem',
                164: '40rem',
                188: '46rem',
                189: '45.3rem',
                200: '49rem'
            },
            minWidth: {
                200: '200px',
                56: '14rem'
            },
            height: {
                13: '3.25rem',
                25: '6.25rem',
                26: '6.5rem',
                54: '13.5rem',
                112: '28rem',
                135: '33.75rem'
            },
            minHeight: {
                12: '3rem',
                '3xl': '48rem'
            },

            colors: {
                /* Design tokens (shadcn-vue convention) — see app/assets/css/tailwind.css */
                background: 'hsl(var(--background) / <alpha-value>)',
                foreground: 'hsl(var(--foreground) / <alpha-value>)',
                card: {
                    DEFAULT: 'hsl(var(--card) / <alpha-value>)',
                    foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
                },
                popover: {
                    DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
                    foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
                },
                primary: {
                    DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
                    foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
                },
                secondary: {
                    DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
                    foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
                },
                muted: {
                    DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
                    foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
                },
                accent: {
                    DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
                    foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
                },
                destructive: {
                    DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
                    foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
                },
                success: {
                    DEFAULT: 'hsl(var(--success) / <alpha-value>)',
                    foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
                },
                warning: {
                    DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
                    foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
                },
                /* "brass" kept as a token alias of primary for back-compat
                 * with existing `bg-brass` / `text-brass` usages. Operations
                 * palette ships with one accent; brass and primary read the
                 * same. */
                brass: {
                    DEFAULT: 'hsl(var(--brass) / <alpha-value>)',
                    foreground: 'hsl(var(--brass-foreground) / <alpha-value>)',
                },
                /* Layered surface tokens for elevation rhythm. Use:
                 *   bg-surface-1   standard panel
                 *   bg-surface-2   sticky / nested cards-on-cards
                 *   bg-surface-3   floating overlay (modal / dropdown) */
                'surface-1': {
                    DEFAULT: 'hsl(var(--surface-1) / <alpha-value>)',
                    foreground: 'hsl(var(--surface-1-foreground) / <alpha-value>)',
                },
                'surface-2': {
                    DEFAULT: 'hsl(var(--surface-2) / <alpha-value>)',
                    foreground: 'hsl(var(--surface-2-foreground) / <alpha-value>)',
                },
                'surface-3': {
                    DEFAULT: 'hsl(var(--surface-3) / <alpha-value>)',
                    foreground: 'hsl(var(--surface-3-foreground) / <alpha-value>)',
                },
                border: {
                    DEFAULT: 'hsl(var(--border) / <alpha-value>)',
                    strong: 'hsl(var(--border-strong) / <alpha-value>)',
                },
                input: 'hsl(var(--input) / <alpha-value>)',
                ring: 'hsl(var(--ring) / <alpha-value>)',

                /* Legacy palette (kept for back-compat with existing utility classes) */
                transparent: 'transparent',
                white: colors.white,
                gray: {
                    3: '#6B7280',  // was #828282 (3.5:1 on white) → now 4.6:1 (WCAG AA)
                    5: '#e0e0e0',
                    401: '#dadada', // not defined on palette
                    402: '#c4c4c4', // not defined on palette
                    300: '#cbd5e1',
                    350: '#808080',
                    400: '#F2F2F2'
                },
                black: {
                    2: '#fafafa',
                    5: '#f2f2f2',
                    10: '#e5e5e5',
                    20: '#ccc',
                    30: '#b3b3b3',
                    40: '#999',
                    50: '#808080',
                    80: '#333',
                    DEFAULT: '#000'
                },
                blue: {
                    10: '#eaf2fd',
                    20: '#2E80ED',
                    DEFAULT: '#2f80ed',
                    401: '#e1e9f4', // not defined on palette
                    402: '#2265bf', // not defined on palette
                    403: '#8ab4f8'
                },
                green: {
                    DEFAULT: '#6fcf97',
                    dark: '#5bad7d'
                },
                red: {
                    DEFAULT: '#ff5856',
                    light: '#ff7171'
                }
            },

            fontSize: {
                'xs': ['13px', '20px']
            },

            fontFamily: {
                'sans': [
                    '"CircularXX TT"',
                    'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"',
                    '"Helvetica Neue"', 'Arial', 'sans-serif',
                ],
                /* Display family kept as a token name for back-compat with
                 * existing `font-display` callers. Resolves to the same
                 * sans stack as body — Operations palette has no editorial
                 * serif moment. Page titles render denser and tighter. */
                'display': [
                    '"CircularXX TT"',
                    'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"',
                    '"Helvetica Neue"', 'Arial', 'sans-serif',
                ],
                'mono': [
                    'ui-monospace', 'SFMono-Regular', '"SF Mono"', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace',
                ]
            },

            borderWidth: {
                '1': '1px',
                '6': '6px',
            },
            borderRadius: Object.assign(
                {},
                require('tailwindcss/defaultTheme').borderRadius,
                {
                    '4xl': '2rem'
                }
            ),

            dropShadow: {
                '3xl': '0 0 16px rgba(230,230,230,0.75)'
            }
        },
        screens: {
            'xs': { 'max': '475px'},
            ...defaultTheme.screens
        }
    },
    plugins: [
        // require('@tailwindcss/forms')({
        //   strategy: 'class',
        // }),
        // require('postcss-focus-visible'),
        require('tailwind-scrollbar'),
        require('tailwindcss-animate'),
    ]
}
