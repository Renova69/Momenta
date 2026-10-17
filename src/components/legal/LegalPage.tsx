import React, { useId } from 'react';
import { i18n } from '../../i18n';
import { PRIVACY } from './privacyContent';
import { TERMS } from './termsContent';
import { fillOperatorDetails, type LegalDocId } from './legalTypes';

interface LegalPageProps {
  doc: LegalDocId;
}

const DOCS = { privacy: PRIVACY, terms: TERMS };

/**
 * The privacy policy or the terms, in the app's language (N-163). Its own
 * chunk: no guest's album page downloads it.
 */
export const LegalPage: React.FC<LegalPageProps> = ({ doc }) => {
  const lang = i18n.getLanguage() === 'en' ? 'en' : 'bg';
  const content = DOCS[doc][lang];
  const fill = (text: string) => fillOperatorDetails(text, lang);
  const titleId = useId();
  const other: LegalDocId = doc === 'privacy' ? 'terms' : 'privacy';

  return (
    <article aria-labelledby={titleId} className="max-w-3xl mx-auto py-6 sm:py-10 animate-fade-in">
      <header className="mb-8 pb-6 border-b border-cream-400/10">
        <h1 id={titleId} className="font-serif text-3xl sm:text-4xl font-bold text-cream-100">
          {content.title}
        </h1>
        <p className="mt-2 text-xs text-cream-400">{i18n.t('legal.effective', { date: fill('{{effectiveDate}}') })}</p>
        <p className="mt-4 text-sm text-cream-200 leading-relaxed">{fill(content.summary)}</p>
      </header>

      <div className="space-y-8">
        {content.sections.map((section) => (
          <section key={section.heading} className="space-y-3">
            <h2 className="font-serif text-xl font-bold text-gold-300">{section.heading}</h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph} className="text-sm text-cream-200 leading-relaxed">
                {fill(paragraph)}
              </p>
            ))}
            {section.items && (
              <ul className="list-disc pl-5 space-y-2 text-sm text-cream-200 leading-relaxed marker:text-gold-400">
                {section.items.map((item) => (
                  <li key={item}>{fill(item)}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <nav aria-label={i18n.t('legal.see_also')} className="mt-10 pt-6 border-t border-cream-400/10 flex flex-wrap gap-4 text-xs">
        <a href={`/${other}`} className="text-gold-300 underline underline-offset-2 hover:text-gold-200">
          {i18n.t(`legal.${other}`)}
        </a>
        <a href="/" className="text-cream-300 underline underline-offset-2 hover:text-cream-100">
          {i18n.t('legal.back_home')}
        </a>
      </nav>
    </article>
  );
};
