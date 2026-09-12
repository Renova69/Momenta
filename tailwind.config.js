/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        gold: {
          50: '#FAF8F0',
          100: '#F5EFE0',
          200: '#EBDCB9',
          300: '#DEC58F',
          400: '#D4AF37', // Signature wedding champagne gold
          500: '#B89325',
          600: '#91721A',
          700: '#6C5413',
          800: '#48370B',
          900: '#2A1F05',
        },
        rosewood: {
          50: '#FDF7F7',
          100: '#FAEEEE',
          200: '#F4D4D6',
          300: '#E9B2B6',
          400: '#D98991',
          500: '#C45E68',
          600: '#A3424C',
          700: '#7F3139',
          800: '#5A2228',
          900: '#381418',
        },
        sage: {
          50: '#F4F7F4',
          100: '#E6EFE6',
          200: '#CDDFCD',
          300: '#A9C5A9',
          400: '#84A784',
          500: '#628862',
          600: '#4C6E4C',
          700: '#3A543A',
          800: '#283B28',
          900: '#172317',
        },
        cream: {
          50: '#FFFEFA',
          100: '#FDFBF7',
          200: '#F9F5EC',
          300: '#F4EEDC',
          400: '#EAE1C7',
          500: '#D5C8A6',
          600: '#B2A37D',
          700: '#8A7C59',
          800: '#5F553B',
          900: '#383222',
        },
        noir: {
          900: '#121214',
          800: '#1B1B1E',
          700: '#27272C',
          600: '#3B3B42',
        }
      },
      fontFamily: {
        serif: ['"Cormorant Garamond"', '"Playfair Display"', 'Georgia', 'serif'],
        sans: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'wedding': '0 10px 30px -5px rgba(212, 175, 55, 0.15)',
        'polaroid': '0 14px 28px rgba(0,0,0,0.12), 0 10px 10px rgba(0,0,0,0.08)',
        'glow': '0 0 25px rgba(212, 175, 55, 0.35)',
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-subtle': 'pulseSubtle 3s infinite ease-in-out',
        // Ken Burns: a slow pan-and-zoom so a still photo stays alive on a TV.
        // Four variants keep consecutive slides from moving identically.
        'ken-burns-0': 'kenBurns0 12s ease-out forwards',
        'ken-burns-1': 'kenBurns1 12s ease-out forwards',
        'ken-burns-2': 'kenBurns2 12s ease-out forwards',
        'ken-burns-3': 'kenBurns3 12s ease-out forwards',
        'float-up': 'floatUp 3.2s ease-out forwards',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.85', transform: 'scale(1.02)' },
        },
        kenBurns0: {
          '0%': { transform: 'scale(1.04) translate3d(0, 0, 0)' },
          '100%': { transform: 'scale(1.16) translate3d(-2.2%, -1.6%, 0)' },
        },
        kenBurns1: {
          '0%': { transform: 'scale(1.16) translate3d(2%, 1.4%, 0)' },
          '100%': { transform: 'scale(1.04) translate3d(0, 0, 0)' },
        },
        kenBurns2: {
          '0%': { transform: 'scale(1.05) translate3d(2.4%, -1.2%, 0)' },
          '100%': { transform: 'scale(1.18) translate3d(-1.8%, 1.8%, 0)' },
        },
        kenBurns3: {
          '0%': { transform: 'scale(1.18) translate3d(-2%, 1.6%, 0)' },
          '100%': { transform: 'scale(1.05) translate3d(1.6%, -1.4%, 0)' },
        },
        floatUp: {
          '0%': { opacity: '0', transform: 'translate3d(0, 0, 0) scale(0.6)' },
          '12%': { opacity: '1', transform: 'translate3d(0, -8vh, 0) scale(1.1)' },
          '100%': { opacity: '0', transform: 'translate3d(var(--drift, 0px), -78vh, 0) scale(0.85)' },
        }
      }
    },
  },
  plugins: [],
}
