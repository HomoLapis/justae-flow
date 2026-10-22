/** @type {import('tailwindcss').Config} */
export default {
  content: ['./client-storyboard/index.html', './client-storyboard/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#0b0c0e', 900: '#111316', 850: '#16191d', 800: '#1c2025', 700: '#262b31', 600: '#323840', 500: '#4a525c', 400: '#6b7480', 300: '#9aa3ad', 200: '#c9d0d7', 100: '#e8ecef' },
        accent: { DEFAULT: '#7c9cff', soft: '#7c9cff22' },
        // The same names EffectCraft paints on the timeline.
        st: { queued: '#e6c84f', running: '#4fd2e6', done: '#5fd37a', error: '#e04fd1', idle: '#6b7480' },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      keyframes: {
        pulseRing: { '0%,100%': { opacity: '0.35' }, '50%': { opacity: '1' } },
      },
      animation: { pulseRing: 'pulseRing 1.6s ease-in-out infinite' },
    },
  },
  plugins: [],
};
