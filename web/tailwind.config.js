/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* La scala è volutamente invertita: in questa interfaccia i toni
           "ink" chiari sono superfici e quelli scuri sono testo. */
        ink: {
          950: '#181510',
          900: '#f2eee5',
          850: '#ffffff',
          800: '#f8f5ee',
          750: '#f0ebe1',
          700: '#e3ddd0',
          600: '#c8c1b2',
          500: '#9d9688',
          400: '#7b7569',
          300: '#5b554b',
          200: '#403b33',
          100: '#29251f',
          50: '#171511',
        },
        accent: {
          50: '#edf5f0',
          100: '#dbebe2',
          200: '#bdd8ca',
          300: '#94bfa9',
          400: '#6ba286',
          500: '#477e67',
          600: '#235347',
          700: '#1b4339',
          800: '#15362e',
          900: '#102a24',
        },
        coral: {
          50: '#fff3ee',
          100: '#ffe2d7',
          200: '#ffc4af',
          300: '#ff9b79',
          400: '#fa7a4f',
          500: '#f2643a',
          600: '#da4e28',
          700: '#b33d1f',
        },
        rose: {
          400: '#f08a6b',
          500: '#e45c3c',
        },
      },
      fontFamily: {
        sans: [
          'Avenir Next',
          'Avenir',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica Neue',
          'sans-serif',
        ],
        serif: ['Iowan Old Style', 'Palatino', 'Georgia', 'serif'],
      },
      boxShadow: {
        soft: '0 18px 60px -24px rgba(54, 47, 32, .22)',
        shell: '0 38px 100px -34px rgba(54, 47, 32, .28)',
        card: '0 18px 40px -22px rgba(54, 47, 32, .32)',
        book: '0 20px 38px -18px rgba(54, 47, 32, .34)',
        lift: '0 14px 34px -14px rgba(35, 83, 71, .35)',
        panel: '0 30px 90px -26px rgba(35, 30, 20, .35)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in .22s ease-out',
        'slide-in': 'slide-in .26s cubic-bezier(.22,1,.36,1)',
        'scale-in': 'scale-in .18s ease-out',
      },
    },
  },
  plugins: [],
};
