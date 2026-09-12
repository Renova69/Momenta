import { ThemePalette } from '../types';

/** `name` and `subtitle` are i18n keys resolved at render, not literal text. */
export interface ThemeConfig {
  id: ThemePalette;
  name: string;
  subtitle: string;
  accent: string;
  bgGradient: string;
  cardBg: string;
  borderAccent: string;
  badgeBg: string;
  badgeText: string;
  buttonPrimary: string;
  buttonHover: string;
  textPrimary: string;
  textMuted: string;
}

export const THEMES: Record<ThemePalette, ThemeConfig> = {
  champagne_gold: {
    id: 'champagne_gold',
    name: 'theme.champagne_gold.name',
    subtitle: 'theme.champagne_gold.desc',
    accent: '#D4AF37',
    bgGradient: 'from-noir-900 via-noir-800 to-[#1e190e]',
    cardBg: 'bg-noir-800/80 border-gold-400/20 hover:border-gold-400/50',
    borderAccent: 'border-gold-400/40',
    badgeBg: 'bg-gold-400/10 text-gold-300 border border-gold-400/30',
    badgeText: 'text-gold-300',
    buttonPrimary: 'bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-semibold shadow-glow hover:brightness-110',
    buttonHover: 'hover:bg-gold-400/10 hover:text-gold-300',
    textPrimary: 'text-cream-100',
    textMuted: 'text-cream-400/70',
  },
  rose_blush: {
    id: 'rose_blush',
    name: 'theme.blush_bordeaux.name',
    subtitle: 'theme.blush_bordeaux.desc',
    accent: '#D98991',
    bgGradient: 'from-noir-900 via-[#1f1315] to-[#2b161a]',
    cardBg: 'bg-noir-800/80 border-rosewood-400/20 hover:border-rosewood-400/50',
    borderAccent: 'border-rosewood-400/40',
    badgeBg: 'bg-rosewood-400/10 text-rosewood-300 border border-rosewood-400/30',
    badgeText: 'text-rosewood-300',
    buttonPrimary: 'bg-gradient-to-r from-rosewood-400 to-rosewood-500 text-white font-semibold shadow-lg hover:brightness-110',
    buttonHover: 'hover:bg-rosewood-400/10 hover:text-rosewood-300',
    textPrimary: 'text-cream-100',
    textMuted: 'text-rosewood-200/70',
  },
  sage_green: {
    id: 'sage_green',
    name: 'theme.botanical_sage.name',
    subtitle: 'theme.botanical_sage.desc',
    accent: '#84A784',
    bgGradient: 'from-noir-900 via-[#111a12] to-[#172317]',
    cardBg: 'bg-noir-800/80 border-sage-400/20 hover:border-sage-400/50',
    borderAccent: 'border-sage-400/40',
    badgeBg: 'bg-sage-400/10 text-sage-300 border border-sage-400/30',
    badgeText: 'text-sage-300',
    buttonPrimary: 'bg-gradient-to-r from-sage-400 to-sage-500 text-noir-900 font-semibold shadow-lg hover:brightness-110',
    buttonHover: 'hover:bg-sage-400/10 hover:text-sage-300',
    textPrimary: 'text-cream-100',
    textMuted: 'text-sage-200/70',
  },
  classic_noir: {
    id: 'classic_noir',
    name: 'theme.midnight_noir.name',
    subtitle: 'theme.midnight_noir.desc',
    accent: '#F4EEDC',
    bgGradient: 'from-black via-noir-900 to-noir-800',
    cardBg: 'bg-noir-800/90 border-white/10 hover:border-white/30',
    borderAccent: 'border-white/20',
    badgeBg: 'bg-white/10 text-white border border-white/20',
    badgeText: 'text-white',
    buttonPrimary: 'bg-white text-black font-semibold hover:bg-cream-200',
    buttonHover: 'hover:bg-white/10 hover:text-white',
    textPrimary: 'text-white',
    textMuted: 'text-neutral-400',
  },
};
