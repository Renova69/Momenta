import React, { useState } from 'react';
import { ActiveView, ThemePalette, Guest, PlanTier, HostUser } from '../../types';
import { THEMES } from '../../config/themes';
import { i18n } from '../../i18n';
import { isFeatureUnlocked } from '../../config/tierGating';
import { LockedFeatureBadge } from '../common/LockedFeatureBadge';
import {
  Camera,
  Tv,
  LayoutDashboard,
  Palette,
  User,
  Heart,
  Crown,
  Calendar,
  MoreVertical,
  X,
  Lock,
  Check,
  LogOut
} from 'lucide-react';

interface NavbarProps {
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
  onLogoClick?: () => void;
  isHomePage?: boolean;
  currentTheme: ThemePalette;
  onThemeChange: (theme: ThemePalette) => void;
  currentGuest: Guest;
  onOpenGuestProfile: () => void;
  onOpenPricing: () => void;
  onOpenEventsList: () => void;
  currentPlanTier?: PlanTier;
  pendingCount?: number;
  currentHostUser?: HostUser | null;
  onHostLogout?: () => void;
  onOpenHostAuth?: () => void;
  onOpenHostProfile?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeView,
  setActiveView,
  onLogoClick,
  isHomePage = false,
  currentTheme,
  onThemeChange,
  currentGuest,
  onOpenGuestProfile,
  onOpenPricing,
  onOpenEventsList,
  currentPlanTier = 'free',
  pendingCount = 0,
  currentHostUser,
  onHostLogout,
  onOpenHostProfile,
}) => {
  const theme = THEMES[currentTheme];
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  const guestDisplayName = currentGuest?.name || i18n.t('nav.guest');

  /** Shared by the standalone guest chip and the host's secondary one. */
  const guestAvatar = (
    <div className="w-6 h-6 rounded-full bg-gold-400/20 border border-gold-400/40 flex items-center justify-center overflow-hidden shrink-0">
      {currentGuest?.avatarUrl ? (
        <img src={currentGuest.avatarUrl} alt={guestDisplayName} className="w-full h-full object-cover" />
      ) : (
        <User className="w-3 h-3 text-gold-400" />
      )}
    </div>
  );

  // A host who tested their own event as a guest has BOTH identities on this
  // device. Worth surfacing on the album view — it is the only way back into
  // the guest profile editor — but never on the Host Studio, where a guest
  // identity is irrelevant and used to read as being signed in as the wrong
  // person.
  const hasSeparateGuestIdentity =
    activeView !== 'host' && !!currentGuest && currentGuest.id !== 'anonymous';

  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-noir-900/90 border-b border-cream-400/10">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-2">
        
        {/* Brand Logo */}
        <div className="flex items-center gap-2">
          <div
            onClick={onLogoClick || (() => setActiveView('guest'))}
            className="flex items-center gap-2 cursor-pointer group"
          >
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center bg-gradient-to-tr from-gold-500/20 to-gold-400/40 border border-gold-400/50 shadow-glow group-hover:scale-105 transition-transform shrink-0">
              <Heart className="w-4 h-4 sm:w-5 sm:h-5 text-gold-400 fill-gold-400/30" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-serif text-base sm:text-2xl font-bold tracking-wide text-cream-100 block leading-tight">
                  WedMoments
                </span>
              </div>
              <span className="text-[9px] sm:text-[10px] tracking-widest uppercase text-gold-400/80 font-medium hidden xs:block">
                {i18n.t('app.subtitle')}
              </span>
            </div>
          </div>
        </div>

        {/* View Switcher Tabs (Desktop Only) */}
        <nav className="hidden sm:flex items-center bg-noir-800/95 rounded-full p-1 border border-gold-400/25 text-xs font-semibold shadow-inner">
          <button
            onClick={() => setActiveView('guest')}
            className={`flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-full transition-all ${
              activeView === 'guest'
                ? `${theme.buttonPrimary} shadow-sm`
                : 'text-cream-300 hover:text-cream-100 hover:bg-noir-700'
            }`}
          >
            <Camera className="w-3.5 h-3.5" />
            <span className="inline">{i18n.t('nav.guest_app')}</span>
          </button>

          <button
            onClick={() => setActiveView('host')}
            className={`relative flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-full transition-all ${
              activeView === 'host'
                ? `${theme.buttonPrimary} shadow-sm`
                : 'text-cream-300 hover:text-cream-100 hover:bg-noir-700'
            }`}
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            <span className="inline flex items-center gap-1">
              {!currentHostUser && activeView !== 'host' && (
                <Lock className="w-3 h-3 text-cream-400/80" />
              )}
              {i18n.t('nav.host_studio')}
            </span>
            {pendingCount > 0 && (
              <span className="absolute -top-1 -right-1 px-1.5 py-0.5 bg-rosewood-500 text-white rounded-full text-[9px] font-bold animate-pulse">
                {pendingCount}
              </span>
            )}
          </button>

          {!isHomePage && (
            <button
              onClick={() => {
                if (!isFeatureUnlocked(currentPlanTier, 'live_tv')) {
                  onOpenPricing();
                } else {
                  setActiveView('projector');
                }
              }}
              className={`flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-full transition-all ${
                activeView === 'projector'
                  ? 'bg-cream-100 text-noir-900 font-bold shadow-sm'
                  : 'text-cream-300 hover:text-cream-100 hover:bg-noir-700'
              }`}
            >
              <Tv className="w-3.5 h-3.5" />
              <span className="inline">{i18n.t('nav.live_tv')}</span>
              {!isFeatureUnlocked(currentPlanTier, 'live_tv') && (
                <LockedFeatureBadge feature="live_tv" compact onUpgrade={onOpenPricing} />
              )}
            </button>
          )}
        </nav>

        {/* Right Actions: Languages, Theme, Profile & Mobile Overflow */}
        <div className="flex items-center gap-1 sm:gap-2">
          
          {/* My Events Switcher Button (Desktop) — ONLY FOR LOGGED IN HOSTS */}
          {currentHostUser && (
            <button
              onClick={onOpenEventsList}
              title={i18n.t('nav.my_events')}
              className="hidden lg:flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-noir-800 hover:bg-noir-700 border border-cream-400/10 text-xs text-cream-200"
            >
              <Calendar className="w-3.5 h-3.5 text-gold-400" />
              <span>{i18n.t('nav.my_events')}</span>
            </button>
          )}

          {/* Pricing & Plan Upgrade Button (Desktop) */}
          <button
            onClick={onOpenPricing}
            title={i18n.t('nav.pricing')}
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-gold-400/10 hover:bg-gold-400/20 border border-gold-400/30 text-xs font-semibold text-gold-300 transition-colors"
          >
            <Crown className="w-3.5 h-3.5 text-gold-400" />
            <span className="hidden xl:inline">{i18n.t('nav.pricing')}</span>
          </button>

          {/* Language Switcher (BG / EN) */}
          <button
            onClick={() => i18n.setLanguage(i18n.getLanguage() === 'bg' ? 'en' : 'bg')}
            title={i18n.t('nav.language')}
            className="p-1.5 sm:p-2 rounded-full bg-noir-800 text-cream-300 hover:text-cream-100 border border-cream-400/10 hover:border-gold-400/40 transition-colors text-[10px] font-bold tracking-wide"
          >
            {i18n.getLanguage().toUpperCase()}
          </button>

          {/* Theme Palette Switcher Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowThemePicker(!showThemePicker)}
              title={i18n.t('nav.theme')}
              className="p-1.5 sm:p-2 rounded-full bg-noir-800 text-cream-300 hover:text-cream-100 border border-cream-400/10 hover:border-gold-400/40 transition-colors"
            >
              <Palette className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>

            {showThemePicker && (
              <div className="absolute right-0 mt-2 w-56 rounded-2xl bg-noir-800 border border-cream-400/20 shadow-2xl p-2 z-50 animate-fade-in">
                <div className="text-[11px] uppercase tracking-wider text-cream-400/70 font-semibold px-2.5 py-1">
                  {i18n.t('nav.theme')}
                </div>
                {(Object.keys(THEMES) as ThemePalette[]).map((themeKey) => {
                  const t = THEMES[themeKey];
                  const isSelected = currentTheme === themeKey;
                  return (
                    <button
                      key={themeKey}
                      onClick={() => {
                        onThemeChange(themeKey);
                        setShowThemePicker(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left text-xs transition-colors ${
                        isSelected
                          ? 'bg-gold-400/20 text-gold-300 font-medium'
                          : 'text-cream-200 hover:bg-noir-700'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="w-3.5 h-3.5 rounded-full border border-white/20"
                          style={{ backgroundColor: t.accent }}
                        />
                        <span>{i18n.t(t.name)}</span>
                      </div>
                      {isSelected && <Check className="w-3.5 h-3.5 text-gold-400" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Identity badge — the authenticated host's own name whenever one
              is signed in, on every view.

              This used to be scoped to `activeView === 'host'`, so a signed-in
              host browsing their own album's guest view saw the cached
              per-device guest badge instead (a host who tested their own event
              as a guest leaves a real guest row, e.g. "Ivan", in this
              browser). The two identity systems — host JWT vs. guest
              localStorage — never mixed any data, but the badge said otherwise,
              and landing on /e/:slug after a Stripe checkout made it read as
              being signed into the wrong account entirely. Whoever is actually
              authenticated is the answer to "who am I", regardless of which
              page is open, so the host badge now wins everywhere. */}
          {currentHostUser ? (
            <>
              <button
                onClick={onOpenHostProfile}
                className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-noir-800 hover:bg-noir-700 border border-cream-400/10 transition-colors text-xs"
                title={currentHostUser.fullName || currentHostUser.email}
              >
                <div className="w-6 h-6 rounded-full bg-gold-400/20 border border-gold-400/40 flex items-center justify-center shrink-0">
                  <Crown className="w-3 h-3 text-gold-400" />
                </div>
                <span className="font-medium text-cream-100 max-w-[65px] sm:max-w-[100px] truncate text-[11px] sm:text-xs">
                  {currentHostUser.fullName.split(' ')[0]}
                </span>
              </button>

              {/* Secondary: how this same person appears TO GUESTS on this
                  album. Avatar only, dimmed until hovered — two equally
                  weighted name chips side by side would recreate the very
                  ambiguity the primary badge exists to settle. The name lives
                  in the tooltip and the profile editor this opens. */}
              {hasSeparateGuestIdentity && (
                <button
                  onClick={onOpenGuestProfile}
                  className="opacity-60 hover:opacity-100 transition-opacity rounded-full"
                  title={i18n.t('nav.appearing_as', { name: guestDisplayName })}
                  aria-label={i18n.t('nav.appearing_as', { name: guestDisplayName })}
                >
                  {guestAvatar}
                </button>
              )}
            </>
          ) : (
            (!isHomePage || (currentGuest && currentGuest.id !== 'anonymous')) && (
              <button
                onClick={onOpenGuestProfile}
                className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-noir-800 hover:bg-noir-700 border border-cream-400/10 transition-colors text-xs"
              >
                {guestAvatar}
                <span className="font-medium text-cream-100 max-w-[65px] sm:max-w-[100px] truncate text-[11px] sm:text-xs">
                  {guestDisplayName.split(' ')[0]}
                </span>
              </button>
            )
          )}

          {/* Sign out — shown wherever a host is signed in, at every
              breakpoint. The only logout control used to live inside the
              `sm:hidden` mobile sheet below, so on any screen ≥640px there was
              no way at all to end a host session: on a shared laptop the next
              person inherited the account, and the 7-day JWT in localStorage
              kept it alive. Deliberately not gated on `activeView === 'host'`
              either — a signed-in host browsing their own album's guest view
              still needs to be able to sign out from there. */}
          {currentHostUser && onHostLogout && (
            <button
              onClick={onHostLogout}
              className="p-1.5 rounded-xl bg-noir-800 text-cream-300 hover:text-rosewood-300 hover:border-rosewood-400/30 border border-cream-400/10 transition-colors"
              title={`${i18n.t('nav.logout')} (${currentHostUser.fullName || currentHostUser.email})`}
              aria-label={i18n.t('nav.logout')}
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}

          {/* Mobile Extra Menu Button */}
          <button
            onClick={() => setShowMobileMenu(!showMobileMenu)}
            className="sm:hidden p-1.5 rounded-xl bg-noir-800 text-cream-300 hover:text-white border border-cream-400/10"
            title={i18n.t('nav.more')}
          >
            {showMobileMenu ? <X className="w-4 h-4" /> : <MoreVertical className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Mobile Dropdown Menu Sheet */}
      {showMobileMenu && (
        <div className="sm:hidden bg-noir-900 border-b border-gold-400/20 p-3 space-y-2 animate-fade-in">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {!isHomePage && (
              <button
                onClick={() => {
                  setActiveView('projector');
                  setShowMobileMenu(false);
                }}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-noir-800 border border-cream-400/10 text-cream-200"
              >
                <Tv className="w-4 h-4 text-gold-400" />
                <span>{i18n.t('nav.live_tv')}</span>
              </button>
            )}

            <button
              onClick={() => {
                onOpenPricing();
                setShowMobileMenu(false);
              }}
              className={`flex items-center gap-2 p-2.5 rounded-xl bg-noir-800 border border-cream-400/10 text-cream-200 ${
                isHomePage ? 'col-span-2' : ''
              }`}
            >
              <Crown className="w-4 h-4 text-gold-400" />
              <span>{i18n.t('nav.pricing')}</span>
            </button>

            {currentHostUser && (
              <button
                onClick={() => {
                  onOpenEventsList();
                  setShowMobileMenu(false);
                }}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-noir-800 border border-cream-400/10 text-cream-200 col-span-2"
              >
                <Calendar className="w-4 h-4 text-gold-400" />
                <span>{i18n.t('nav.my_events')}</span>
              </button>
            )}

            {currentHostUser && (
              <button
                onClick={() => {
                  if (onHostLogout) onHostLogout();
                  setShowMobileMenu(false);
                }}
                className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-rosewood-900/40 border border-rosewood-400/30 text-rosewood-300 col-span-2 font-semibold"
              >
                <span>{i18n.t('nav.logout')} ({(currentHostUser.fullName || currentHostUser.email || i18n.t('nav.couple')).split(' ')[0]} )</span>
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
