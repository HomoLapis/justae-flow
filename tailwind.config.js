/** @type {import('tailwindcss').Config} */
// Color tokens are mapped onto the Spectrum CSS variables defined in
// client/src/theme/spectrum.css. They resolve through `rgb(var(--token) /
// <alpha-value>)` so the whole UI re-themes by [data-theme] (light | dark |
// darkest) AND every Tailwind `/NN` opacity modifier keeps working.
export default {
  content: ['./client/index.html', './client/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'rgb(var(--jae-gray-100) / <alpha-value>)',
          raised:  'rgb(var(--jae-gray-75) / <alpha-value>)',
          subtle:  'rgb(var(--jae-gray-200) / <alpha-value>)',
          hover:   'rgb(var(--jae-gray-300) / <alpha-value>)',
        },
        line: 'rgb(var(--jae-border) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--jae-gray-900) / <alpha-value>)',
          dim:     'rgb(var(--jae-gray-600) / <alpha-value>)',
          mute:    'rgb(var(--jae-gray-500) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--jae-accent) / <alpha-value>)',
          hover:   'rgb(var(--jae-accent-hover) / <alpha-value>)',
          dim:     'rgb(var(--jae-accent-hover) / <alpha-value>)',
        },
        accent: 'rgb(var(--jae-accent) / <alpha-value>)',
        ok:   'rgb(var(--jae-positive) / <alpha-value>)',
        warn: 'rgb(var(--jae-warning) / <alpha-value>)',
        err:  'rgb(var(--jae-negative) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['DM Sans', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      animation: {
        'pulse-soft': 'pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
