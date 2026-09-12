import React, { useState } from 'react';
import { i18n } from '../../i18n';
import { PublicWeddingsShowcase } from './PublicWeddingsShowcase';
import {
  Sparkles,
  Camera,
  Tv,
  Mic,
  Trophy,
  Printer,
  ShieldCheck,
  Wifi,
  Download,
  CheckCircle2,
  Check,
  Star,
  ChevronDown,
  ArrowRight,
  QrCode,
  Heart,
  Crown,
  Zap,
  Users,
  Smartphone
} from 'lucide-react';

interface LandingHomePageProps {
  onSelectWedding: (slug: string) => void;
  onOpenCreateEvent: () => void;
  onOpenPricing: () => void;
}

export const LandingHomePage: React.FC<LandingHomePageProps> = ({
  onSelectWedding,
  onOpenCreateEvent,
  onOpenPricing,
}) => {
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);

  const faqs = [
    {
      q: i18n.t('landing.faq1_q'),
      a: i18n.t('landing.faq1_a'),
    },
    {
      q: i18n.t('landing.faq2_q'),
      a: i18n.t('landing.faq2_a'),
    },
    {
      q: i18n.t('landing.faq3_q'),
      a: i18n.t('landing.faq3_a'),
    },
    {
      q: i18n.t('landing.faq4_q'),
      a: i18n.t('landing.faq4_a'),
    },
    {
      q: i18n.t('landing.faq5_q'),
      a: i18n.t('landing.faq5_a'),
    },
  ];

  const features = [
    {
      icon: Camera,
      title: i18n.t('landing.feat1_title'),
      desc: i18n.t('landing.feat1_desc'),
      tag: i18n.t('landing.feat1_tag'),
    },
    {
      icon: Tv,
      title: i18n.t('landing.feat2_title'),
      desc: i18n.t('landing.feat2_desc'),
      tag: i18n.t('landing.feat2_tag'),
    },
    {
      icon: Mic,
      title: i18n.t('landing.feat3_title'),
      desc: i18n.t('landing.feat3_desc'),
      tag: i18n.t('landing.feat3_tag'),
    },
    {
      icon: Trophy,
      title: i18n.t('landing.feat4_title'),
      desc: i18n.t('landing.feat4_desc'),
      tag: i18n.t('landing.feat4_tag'),
    },
    {
      icon: Printer,
      title: 'QR Canvas Print Studio',
      desc: i18n.t('landing.feat5_desc'),
      tag: i18n.t('landing.feat5_tag'),
    },
    {
      icon: ShieldCheck,
      title: i18n.t('landing.feat6_title'),
      desc: i18n.t('landing.feat6_desc'),
      tag: i18n.t('landing.feat6_tag'),
    },
    {
      icon: Wifi,
      title: i18n.t('landing.feat7_title'),
      desc: i18n.t('landing.feat7_desc'),
      tag: i18n.t('landing.feat7_tag'),
    },
    {
      icon: Download,
      title: i18n.t('landing.feat8_title'),
      desc: i18n.t('landing.feat8_desc'),
      tag: i18n.t('landing.feat8_tag'),
    },
  ];

  const benefits = [
    {
      title: i18n.t('landing.benefit1_title'),
      desc: i18n.t('landing.benefit1_desc'),
    },
    {
      title: i18n.t('landing.benefit2_title'),
      desc: i18n.t('landing.benefit2_desc'),
    },
    {
      title: i18n.t('landing.benefit3_title'),
      desc: i18n.t('landing.benefit3_desc'),
    },
    {
      title: i18n.t('landing.benefit4_title'),
      desc: i18n.t('landing.benefit4_desc'),
    },
  ];

  return (
    <div className="space-y-16 sm:space-y-24 animate-fade-in pb-12">
      
      {/* 1. HERO SECTION */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-noir-850 via-noir-900 to-noir-950 border border-gold-400/25 p-6 sm:p-12 lg:p-16 text-center shadow-2xl">
        {/* Ambient Glow */}
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-96 h-96 bg-gold-400/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 max-w-4xl mx-auto space-y-6">
          {/* Top Trust Badge */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-gold-400/15 border border-gold-400/35 text-gold-300 text-xs font-semibold shadow-inner">
            <Sparkles className="w-3.5 h-3.5 text-gold-400 fill-gold-400/40" />
            <span>{i18n.t('ui.landing_home_page.1')}</span>
          </div>

          {/* Main Hero Headline */}
          <h1 className="font-serif text-3xl sm:text-5xl lg:text-6xl font-bold text-cream-100 tracking-tight leading-tight">
            {i18n.t('ui.landing_home_page.2')}
          </h1>

          {/* Hero Subtitle */}
          <p className="text-sm sm:text-lg text-cream-300/85 max-w-2xl mx-auto leading-relaxed">
            {i18n.t('ui.landing_home_page.3')}
            <strong className="text-gold-300 font-semibold">{i18n.t('ui.landing_home_page.4')}</strong>{' '}
            {i18n.t('landing.hero_tv_note')}
          </p>

          {/* Trust Metrics Pill Ribbon */}
          <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 pt-2 text-xs text-cream-300/80">
            <div className="flex items-center gap-1.5 bg-noir-800/80 px-3 py-1.5 rounded-xl border border-cream-400/10">
              <div className="flex items-center gap-0.5 text-gold-400">
                <Star className="w-3 h-3 fill-gold-400" />
                <Star className="w-3 h-3 fill-gold-400" />
                <Star className="w-3 h-3 fill-gold-400" />
                <Star className="w-3 h-3 fill-gold-400" />
                <Star className="w-3 h-3 fill-gold-400" />
              </div>
              <span>{i18n.t('ui.landing_home_page.5')}</span>
            </div>
            <div className="flex items-center gap-1.5 bg-noir-800/80 px-3 py-1.5 rounded-xl border border-cream-400/10">
              <Smartphone className="w-3.5 h-3.5 text-gold-400" />
              <span>{i18n.t('ui.landing_home_page.6')}</span>
            </div>
            <div className="flex items-center gap-1.5 bg-noir-800/80 px-3 py-1.5 rounded-xl border border-cream-400/10">
              <Zap className="w-3.5 h-3.5 text-gold-400" />
              <span>{i18n.t('ui.landing_home_page.7')}</span>
            </div>
          </div>

          {/* Hero Dual CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <button
              onClick={onOpenCreateEvent}
              className="w-full sm:w-auto px-8 py-4 rounded-2xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-sm sm:text-base shadow-glow hover:brightness-110 active:scale-98 transition-all flex items-center justify-center gap-2.5 group"
            >
              <Heart className="w-5 h-5 fill-noir-900 text-noir-900 group-hover:scale-110 transition-transform" />
              <span>{i18n.t('ui.landing_home_page.8')}</span>
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>

            <button
              onClick={onOpenPricing}
              className="w-full sm:w-auto px-6 py-4 rounded-2xl bg-noir-800/90 hover:bg-noir-750 border border-cream-400/20 text-cream-100 font-semibold text-sm sm:text-base transition-all flex items-center justify-center gap-2"
            >
              <Crown className="w-4 h-4 text-gold-400" />
              <span>{i18n.t('ui.landing_home_page.9')}</span>
            </button>
          </div>
        </div>
      </section>

      {/* 2. HOW IT WORKS (В 3 лесни стъпки) */}
      <section className="space-y-8 text-center max-w-5xl mx-auto px-2">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-gold-400/10 border border-gold-400/25 text-gold-300 text-xs font-semibold uppercase tracking-wider">
            {i18n.t('ui.landing_home_page.10')}
          </div>
          <h2 className="font-serif text-2xl sm:text-4xl font-bold text-cream-100">
            {i18n.t('ui.landing_home_page.11')}
          </h2>
          <p className="text-xs sm:text-sm text-cream-400/80 max-w-xl mx-auto">
            {i18n.t('ui.landing_home_page.12')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-left">
          <div className="bg-noir-800/70 border border-cream-400/10 rounded-2xl sm:rounded-3xl p-6 space-y-4 hover:border-gold-400/40 transition-colors group">
            <div className="w-12 h-12 rounded-2xl bg-gold-400/15 border border-gold-400/30 flex items-center justify-center text-gold-400 text-lg font-bold group-hover:scale-105 transition-transform">
              <QrCode className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <span className="text-gold-400 font-mono text-xs font-bold uppercase tracking-wider">{i18n.t('ui.landing_home_page.13')}</span>
              <h3 className="font-serif text-lg font-bold text-cream-100">{i18n.t('ui.landing_home_page.14')}</h3>
              <p className="text-xs text-cream-300/75 leading-relaxed">
                {i18n.t('ui.landing_home_page.15')}
              </p>
            </div>
          </div>

          <div className="bg-noir-800/70 border border-cream-400/10 rounded-2xl sm:rounded-3xl p-6 space-y-4 hover:border-gold-400/40 transition-colors group">
            <div className="w-12 h-12 rounded-2xl bg-gold-400/15 border border-gold-400/30 flex items-center justify-center text-gold-400 text-lg font-bold group-hover:scale-105 transition-transform">
              <Camera className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <span className="text-gold-400 font-mono text-xs font-bold uppercase tracking-wider">{i18n.t('ui.landing_home_page.16')}</span>
              <h3 className="font-serif text-lg font-bold text-cream-100">{i18n.t('ui.landing_home_page.17')}</h3>
              <p className="text-xs text-cream-300/75 leading-relaxed">
                {i18n.t('ui.landing_home_page.18')}
              </p>
            </div>
          </div>

          <div className="bg-noir-800/70 border border-cream-400/10 rounded-2xl sm:rounded-3xl p-6 space-y-4 hover:border-gold-400/40 transition-colors group">
            <div className="w-12 h-12 rounded-2xl bg-gold-400/15 border border-gold-400/30 flex items-center justify-center text-gold-400 text-lg font-bold group-hover:scale-105 transition-transform">
              <Tv className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <span className="text-gold-400 font-mono text-xs font-bold uppercase tracking-wider">{i18n.t('ui.landing_home_page.19')}</span>
              <h3 className="font-serif text-lg font-bold text-cream-100">{i18n.t('ui.landing_home_page.20')}</h3>
              <p className="text-xs text-cream-300/75 leading-relaxed">
                {i18n.t('ui.landing_home_page.21')}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 3. MULTI-WEDDING LIVE SHOWCASE FEED */}
      <PublicWeddingsShowcase
        onSelectWedding={onSelectWedding}
        onOpenCreateEvent={onOpenCreateEvent}
        onOpenPricing={onOpenPricing}
      />

      {/* 4. CORE FEATURES GRID */}
      <section className="space-y-8 max-w-6xl mx-auto px-2">
        <div className="text-center space-y-2 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-gold-400/10 border border-gold-400/25 text-gold-300 text-xs font-semibold uppercase tracking-wider">
            {i18n.t('ui.landing_home_page.22')}
          </div>
          <h2 className="font-serif text-2xl sm:text-4xl font-bold text-cream-100">
            {i18n.t('ui.landing_home_page.23')}
          </h2>
          <p className="text-xs sm:text-sm text-cream-400/80">
            {i18n.t('ui.landing_home_page.24')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
          {features.map((feat) => {
            const Icon = feat.icon;
            return (
              <div
                key={feat.title}
                className="bg-noir-800/80 border border-cream-400/15 hover:border-gold-400/40 rounded-2xl p-5 space-y-3 transition-all duration-300 hover:shadow-glow flex flex-col justify-between"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="w-10 h-10 rounded-xl bg-gold-400/15 border border-gold-400/30 flex items-center justify-center text-gold-400">
                      <Icon className="w-5 h-5" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-noir-900 border border-cream-400/15 text-gold-300">
                      {feat.tag}
                    </span>
                  </div>
                  <h3 className="font-serif text-base font-bold text-cream-100">
                    {feat.title}
                  </h3>
                  <p className="text-xs text-cream-300/75 leading-relaxed">
                    {feat.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 5. WHY COUPLES LOVE WEDMOMENTS (BENEFITS) */}
      <section className="rounded-3xl bg-noir-850 border border-gold-400/20 p-6 sm:p-12 max-w-6xl mx-auto space-y-8">
        <div className="text-center space-y-2 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-gold-400/10 border border-gold-400/25 text-gold-300 text-xs font-semibold uppercase tracking-wider">
            {i18n.t('ui.landing_home_page.25')}
          </div>
          <h2 className="font-serif text-2xl sm:text-4xl font-bold text-cream-100">
            {i18n.t('ui.landing_home_page.26')}
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {benefits.map((b) => (
            <div
              key={b.title}
              className="flex items-start gap-4 p-5 rounded-2xl bg-noir-900/80 border border-cream-400/10"
            >
              <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="font-serif text-base font-bold text-cream-100">
                  {b.title}
                </h3>
                <p className="text-xs sm:text-sm text-cream-300/75 leading-relaxed">
                  {b.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 6. PRICING PREVIEW TEASER */}
      <section className="space-y-8 text-center max-w-5xl mx-auto px-2">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-gold-400/10 border border-gold-400/25 text-gold-300 text-xs font-semibold uppercase tracking-wider">
            {i18n.t('ui.landing_home_page.27')}
          </div>
          <h2 className="font-serif text-2xl sm:text-4xl font-bold text-cream-100">
            {i18n.t('ui.landing_home_page.28')}
          </h2>
          <p className="text-xs sm:text-sm text-cream-400/80 max-w-lg mx-auto">
            {i18n.t('ui.landing_home_page.29')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-left">
          {/* Free */}
          <div className="p-5 rounded-2xl bg-noir-800/80 border border-cream-400/15 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <h3 className="font-serif text-base font-bold text-cream-100">{i18n.t('ui.landing_home_page.30')}</h3>
              <div className="text-2xl font-bold text-cream-100 font-serif">0 €</div>
              <p className="text-xs text-cream-400/70">{i18n.t('ui.landing_home_page.31')}</p>
              <ul className="text-xs text-cream-300/80 space-y-2 pt-2 border-t border-cream-400/10">
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.32')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.33')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.34')}</span></li>
              </ul>
            </div>
            <button
              onClick={onOpenCreateEvent}
              className="w-full py-2.5 rounded-xl bg-noir-700 hover:bg-noir-650 text-cream-100 text-xs font-bold transition-all"
            >
              {i18n.t('ui.landing_home_page.35')}
            </button>
          </div>

          {/* Celebration Pass */}
          <div className="p-5 rounded-2xl bg-gradient-to-b from-gold-400/15 to-noir-800 border-2 border-gold-400/60 shadow-glow flex flex-col justify-between space-y-4 relative">
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-gold-400 text-noir-900 text-[10px] font-bold uppercase tracking-wider">
              {i18n.t('ui.landing_home_page.36')}
            </span>
            <div className="space-y-2">
              <h3 className="font-serif text-base font-bold text-cream-100">Celebration Pass</h3>
              <div className="text-2xl font-bold text-gold-300 font-serif">49 €</div>
              <p className="text-xs text-cream-400/70">{i18n.t('ui.landing_home_page.37')}</p>
              <ul className="text-xs text-cream-200 space-y-2 pt-2 border-t border-cream-400/10">
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.38')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.39')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.40')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.41')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.42')}</span></li>
              </ul>
            </div>
            <button
              onClick={onOpenPricing}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 text-xs font-bold shadow-md hover:brightness-110 transition-all"
            >
              {i18n.t('ui.landing_home_page.43')}
            </button>
          </div>

          {/* Deluxe Keepsake */}
          <div className="p-5 rounded-2xl bg-noir-800/80 border border-cream-400/15 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <h3 className="font-serif text-base font-bold text-cream-100">Deluxe Keepsake</h3>
              <div className="text-2xl font-bold text-cream-100 font-serif">89 €</div>
              <p className="text-xs text-cream-400/70">{i18n.t('ui.landing_home_page.44')}</p>
              <ul className="text-xs text-cream-300/80 space-y-2 pt-2 border-t border-cream-400/10">
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.45')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.46')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.47')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.48')}</span></li>
              </ul>
            </div>
            <button
              onClick={onOpenPricing}
              className="w-full py-2.5 rounded-xl bg-noir-700 hover:bg-noir-650 text-cream-100 text-xs font-bold transition-all"
            >
              {i18n.t('ui.landing_home_page.49')}
            </button>
          </div>

          {/* Pro Planner */}
          <div className="p-5 rounded-2xl bg-noir-800/80 border border-cream-400/15 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <h3 className="font-serif text-base font-bold text-cream-100">Pro Planner</h3>
              <div className="text-2xl font-bold text-cream-100 font-serif">49 €<span className="text-xs font-normal">{i18n.t('ui.landing_home_page.50')}</span></div>
              <p className="text-xs text-cream-400/70">{i18n.t('ui.landing_home_page.51')}</p>
              <ul className="text-xs text-cream-300/80 space-y-2 pt-2 border-t border-cream-400/10">
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.52')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.53')}</span></li>
                <li className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-gold-400 shrink-0" /><span>{i18n.t('ui.landing_home_page.54')}</span></li>
              </ul>
            </div>
            <button
              onClick={onOpenPricing}
              className="w-full py-2.5 rounded-xl bg-noir-700 hover:bg-noir-650 text-cream-100 text-xs font-bold transition-all"
            >
              {i18n.t('ui.landing_home_page.55')}
            </button>
          </div>
        </div>
      </section>

      {/* 7. FAQ ACCORDION SECTION */}
      <section className="space-y-6 max-w-4xl mx-auto px-2">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-gold-400/10 border border-gold-400/25 text-gold-300 text-xs font-semibold uppercase tracking-wider">
            {i18n.t('ui.landing_home_page.56')}
          </div>
          <h2 className="font-serif text-2xl sm:text-4xl font-bold text-cream-100">
            {i18n.t('ui.landing_home_page.57')}
          </h2>
        </div>

        <div className="space-y-3 pt-4">
          {faqs.map((faq, index) => {
            const isOpen = openFaqIndex === index;
            return (
              <div
                key={faq.q}
                className="rounded-2xl bg-noir-800/80 border border-cream-400/15 overflow-hidden transition-colors"
              >
                <button
                  type="button"
                  onClick={() => setOpenFaqIndex(isOpen ? null : index)}
                  className="w-full p-4 sm:p-5 flex items-center justify-between text-left gap-4 hover:bg-noir-750/50 transition-colors"
                >
                  <span className="font-serif text-sm sm:text-base font-bold text-cream-100">
                    {faq.q}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-gold-400 shrink-0 transition-transform duration-300 ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 sm:px-5 sm:pb-5 text-xs sm:text-sm text-cream-300/80 leading-relaxed border-t border-cream-400/10 pt-3">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 8. FINAL HIGH-CONVERSION CTA */}
      <section className="relative rounded-3xl bg-gradient-to-r from-noir-900 via-gold-400/10 to-noir-900 border border-gold-400/40 p-8 sm:p-14 text-center max-w-5xl mx-auto shadow-2xl overflow-hidden">
        <div className="relative z-10 max-w-2xl mx-auto space-y-5">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gold-400/20 text-gold-300 text-xs font-semibold">
            <Heart className="w-3.5 h-3.5 fill-gold-400 text-gold-400" />
            <span>{i18n.t('ui.landing_home_page.58')}</span>
          </div>

          <h2 className="font-serif text-2xl sm:text-4xl font-bold text-cream-100 leading-tight">
            {i18n.t('ui.landing_home_page.59')}
          </h2>

          <p className="text-xs sm:text-sm text-cream-300/85 max-w-xl mx-auto leading-relaxed">
            {i18n.t('ui.landing_home_page.60')}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
            <button
              onClick={onOpenCreateEvent}
              className="w-full sm:w-auto px-8 py-4 rounded-2xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-sm sm:text-base shadow-glow hover:brightness-110 active:scale-98 transition-all flex items-center justify-center gap-2"
            >
              <Users className="w-4 h-4" />
              <span>{i18n.t('ui.landing_home_page.61')}</span>
            </button>

            <button
              onClick={onOpenPricing}
              className="w-full sm:w-auto px-6 py-4 rounded-2xl bg-noir-800 hover:bg-noir-700 border border-cream-400/20 text-cream-200 font-semibold text-xs sm:text-sm transition-all"
            >
              {i18n.t('ui.landing_home_page.62')}
            </button>
          </div>
        </div>
      </section>

    </div>
  );
};
