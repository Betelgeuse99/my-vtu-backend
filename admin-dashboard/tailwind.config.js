/** @type {import('tailwindcss').Config} */

// Every palette step is backed by a CSS custom property so the whole app can be
// re-themed (light/dark) from src/index.css without touching JSX colour classes.
// Each var holds "R G B" channels; Tailwind's <alpha-value> handles the /opacity
// modifiers (e.g. bg-slate-800/50).
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  v('b-50'),
          100: v('b-100'),
          200: v('b-200'),
          300: v('b-300'),
          400: v('b-400'),
          500: v('b-500'),
          600: v('b-600'),
          700: v('b-700'),
          800: v('b-800'),
          900: v('b-900'),
        },
        slate: {
          50:  v('s-50'),
          100: v('s-100'),
          200: v('s-200'),
          300: v('s-300'),
          400: v('s-400'),
          500: v('s-500'),
          600: v('s-600'),
          700: v('s-700'),
          800: v('s-800'),
          900: v('s-900'),
          950: v('s-950'),
        },
        gray: {
          100: v('g-100'),
          200: v('g-200'),
          300: v('g-300'),
          400: v('g-400'),
          700: v('g-700'),
          800: v('g-800'),
        },
        purple: {
          50:  v('p-50'),
          200: v('p-200'),
          300: v('p-300'),
          600: v('p-600'),
          700: v('p-700'),
          800: v('p-800'),
          900: v('p-900'),
        },
        red: {
          50:  v('r-50'),
          200: v('r-200'),
          300: v('r-300'),
          400: v('r-400'),
          500: v('r-500'),
          600: v('r-600'),
          700: v('r-700'),
          800: v('r-800'),
          900: v('r-900'),
        },
        amber: {
          300: v('a-300'),
          400: v('a-400'),
          700: v('a-700'),
          900: v('a-900'),
        },
        emerald: {
          50:  v('e-50'),
          200: v('e-200'),
          300: v('e-300'),
          400: v('e-400'),
          500: v('e-500'),
          600: v('e-600'),
          700: v('e-700'),
          800: v('e-800'),
          900: v('e-900'),
        },
        blue: {
          300: v('bl-300'),
          500: v('bl-500'),
          700: v('bl-700'),
          900: v('bl-900'),
        },
        sky: {
          300: v('sk-300'),
          700: v('sk-700'),
          800: v('sk-800'),
          900: v('sk-900'),
        },
        yellow: {
          300: v('y-300'),
          700: v('y-700'),
          900: v('y-900'),
        },
        lime: {
          300: v('l-300'),
          700: v('l-700'),
          900: v('l-900'),
        },
        orange: {
          300: v('o-300'),
          700: v('o-700'),
          900: v('o-900'),
        },
        violet: {
          300: v('v-300'),
          700: v('v-700'),
          900: v('v-900'),
        },
        fuchsia: {
          300: v('f-300'),
          700: v('f-700'),
          900: v('f-900'),
        },
      }
    },
  },
  plugins: [],
}
