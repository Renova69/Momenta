/**
 * Who runs the service, as the privacy notice and the terms state it (N-163).
 *
 * Every field the operator has not filled in yet is shown on the legal pages
 * as a visible placeholder ("[TO FILL IN: …]"), never left blank or made up:
 * a page that looks finished while it names nobody would be worse than one
 * that plainly says what is missing. Fill these in, and have the pages read
 * by a lawyer, before the service takes real guests or payments.
 */
export interface OperatorDetails {
  /** Registered name of the company or sole trader. */
  legalName: string;
  /** Bulgarian company number (ЕИК / БУЛСТАТ). */
  companyId: string;
  /** VAT number, if registered for VAT; leave empty otherwise. */
  vatId: string;
  /** Registered address. */
  address: string;
  /** Address for privacy requests and customer contact. */
  email: string;
  phone: string;
  /** Where the server and database run (provider and country). */
  hostingProvider: string;
  /** Who sends the service's email, once SMTP is configured. */
  emailProvider: string;
  /**
   * How long an album is kept after it closes, before it is deleted. The
   * retention sweep, once RETENTION_ENFORCED is on (U-4), deletes an album
   * GRACE_PERIOD_DAYS (30) after it closes and no sooner than 14 days after
   * the host was warned (server/lib/retention.ts). Until it is on, nothing is
   * deleted, so do not state a period here before switching it on.
   */
  retentionAfterClose: string;
  /** Whether listed prices include VAT. */
  pricesIncludeVat: string;
  /** The date these documents take effect. */
  effectiveDate: string;
  /**
   * How data reaching providers outside the EEA is protected (an adequacy
   * decision, standard contractual clauses), provider by provider.
   */
  transferSafeguards: string;
}

export const OPERATOR: OperatorDetails = {
  legalName: '',
  companyId: '',
  vatId: '',
  address: '',
  email: '',
  phone: '',
  hostingProvider: '',
  emailProvider: '',
  retentionAfterClose: '',
  pricesIncludeVat: '',
  effectiveDate: '',
  transferSafeguards: '',
};
