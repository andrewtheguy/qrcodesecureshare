/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f2ff',
          500: '#667eea',
          600: '#5a67d8',
          700: '#764ba2',
        }
      }
    },
  },
  plugins: [],
}