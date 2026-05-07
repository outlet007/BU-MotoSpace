/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './public/**/*.js'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
        },
        slate: {
          750: '#293548',
          850: '#162032',
        }
      },
      fontFamily: {
        sans: ['Noto Sans Thai', 'sans-serif'],
        mono: ['Noto Sans Thai', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
