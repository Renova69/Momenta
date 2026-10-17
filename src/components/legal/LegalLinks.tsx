import React from 'react';
import { i18n } from '../../i18n';

const LINK_CLASS = 'underline underline-offset-2 text-gold-300 hover:text-gold-200';

/**
 * Where the privacy policy and the terms are linked from a form (N-163). A
 * form is the point where data is collected or a contract is made, which is
 * where the notice is owed. They open in a new tab, so a half-filled form is
 * not lost.
 */
export const LegalNotice: React.FC<{ kind: 'signup' | 'guest' | 'pricing' }> = ({ kind }) => {
  const link = (doc: 'privacy' | 'terms') => (
    <a href={`/${doc}`} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      {i18n.t(`legal.${doc}_link`)}
    </a>
  );

  return (
    <p className="text-[11px] text-cream-400 leading-relaxed">
      {kind === 'signup' && (
        <>
          {i18n.t('legal.signup_accept')} {link('terms')} {i18n.t('legal.and')} {link('privacy')}.
        </>
      )}
      {kind === 'guest' && (
        <>
          {i18n.t('legal.guest_notice')} {link('privacy')}.
        </>
      )}
      {kind === 'pricing' && (
        <>
          {i18n.t('legal.pricing_notice')} {link('terms')}.
        </>
      )}
    </p>
  );
};

/** The footer's links, on every page. */
export const LegalFooterLinks: React.FC = () => (
  <nav aria-label={i18n.t('legal.nav')} className="mt-3 flex items-center justify-center gap-4">
    <a href="/privacy" className="underline underline-offset-2 hover:text-cream-200">
      {i18n.t('legal.privacy')}
    </a>
    <a href="/terms" className="underline underline-offset-2 hover:text-cream-200">
      {i18n.t('legal.terms')}
    </a>
  </nav>
);
