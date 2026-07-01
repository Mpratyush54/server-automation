/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts}",
  ],
  theme: {
    extend: {
      colors: {
        charcoal: '#1A1A1A',
        alabaster: '#F9F8F6',
        taupe: '#EBE5DE',
        warmgrey: '#6C6863',
        gold: '#D4AF37'
      },
      fontFamily: {
        playfair: ['"Playfair Display"', 'serif'],
        inter: ['Inter', 'sans-serif']
      },
      lineHeight: {
        'tight': '0.9',
        'relaxed': '1.625'
      },
      transitionDuration: {
        '500': '500ms',
        '700': '700ms',
        '1500': '1500ms',
        '2000': '2000ms'
      },
      transitionTimingFunction: {
        'luxury': 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'
      }
    },
  },
  plugins: [],
}
