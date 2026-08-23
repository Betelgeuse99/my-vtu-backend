/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#eef7ff',
          100: '#d8edff',
          200: '#b9dfff',
          300: '#89cbff',
          400: '#52adff',
          500: '#2a89ff',
          600: '#1568f5',
          700: '#0e52e1',
          800: '#1143b6',
          900: '#143b8f',
          950: '#112557',
        }
      }
    },
  },
  plugins: [],
}
