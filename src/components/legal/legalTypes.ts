import { OPERATOR, type OperatorDetails } from '../../config/operator';

export type LegalDocId = 'privacy' | 'terms';

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  items?: string[];
}

export interface LegalDoc {
  title: string;
  summary: string;
  sections: LegalSection[];
}

/** What each operator detail is called in a placeholder, per language. */
const PLACEHOLDER_LABELS: Record<keyof OperatorDetails, { bg: string; en: string }> = {
  legalName: { bg: 'наименование на търговеца', en: "trader's registered name" },
  companyId: { bg: 'ЕИК', en: 'company number' },
  vatId: { bg: 'ДДС номер или „не е регистриран по ДДС“', en: 'VAT number, or "not VAT-registered"' },
  address: { bg: 'седалище и адрес на управление', en: 'registered address' },
  email: { bg: 'имейл за контакт', en: 'contact email' },
  phone: { bg: 'телефон за контакт', en: 'contact phone' },
  hostingProvider: { bg: 'хостинг доставчик и държава', en: 'hosting provider and country' },
  emailProvider: { bg: 'доставчик на имейл услугата', en: 'email provider' },
  retentionAfterClose: { bg: 'срок за пазене след затваряне, напр. „30 дни“', en: 'period kept after closing, e.g. "30 days"' },
  pricesIncludeVat: { bg: '„включват ДДС“ или „не включват ДДС“', en: '"include VAT" or "do not include VAT"' },
  effectiveDate: { bg: 'дата на влизане в сила', en: 'date these take effect' },
  transferSafeguards: { bg: 'основание за трансфер извън ЕИП за всеки доставчик', en: 'transfer safeguard outside the EEA for each provider' },
};

/**
 * Put the operator's details into a document's text. A detail not filled in
 * yet is shown as a visible placeholder, never as a blank (N-163).
 */
export function fillOperatorDetails(text: string, lang: 'bg' | 'en', details: OperatorDetails = OPERATOR): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (!(name in PLACEHOLDER_LABELS)) return match;
    const key = name as keyof OperatorDetails;
    const value = details[key]?.trim();
    if (value) return value;
    return lang === 'bg' ? `[ПОПЪЛНЕТЕ: ${PLACEHOLDER_LABELS[key].bg}]` : `[TO FILL IN: ${PLACEHOLDER_LABELS[key].en}]`;
  });
}
