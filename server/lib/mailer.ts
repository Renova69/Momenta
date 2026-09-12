import nodemailer, { Transporter } from 'nodemailer';
import { CONFIG } from './config';

/**
 * Outbound email.
 *
 * Exists to unblock retention notices (D1): the sweep will not delete an album
 * until its host has been warned, and until now nothing could warn anyone.
 *
 * SMTP rather than a provider SDK, because this app ships as its own
 * docker-compose and SMTP is the one interface every provider speaks. Swapping
 * SES for Postmark is then an environment change, not a code change.
 *
 * Lazily constructed, like getStripeClient() and for the same reason: building
 * a transport at module load with empty credentials would make importing this
 * file fail in every environment that has no mail configured, which is most of
 * them.
 */

let transport: Transporter | null = null;

export function isMailerConfigured(): boolean {
  return !!CONFIG.SMTP_HOST;
}

function getTransport(): Transporter {
  if (!isMailerConfigured()) {
    throw new Error('Mailer is not configured (SMTP_HOST missing)');
  }
  if (!transport) {
    transport = nodemailer.createTransport({
      host: CONFIG.SMTP_HOST,
      port: CONFIG.SMTP_PORT,
      secure: CONFIG.SMTP_SECURE,
      // Some relays on a trusted network take no credentials at all; passing
      // an empty user/pass object to nodemailer makes it attempt AUTH and fail,
      // so the key is omitted entirely rather than left blank.
      ...(CONFIG.SMTP_USER ? { auth: { user: CONFIG.SMTP_USER, pass: CONFIG.SMTP_PASSWORD } } : {}),
    });
  }
  return transport;
}

/** Test seam — drop the memoised transport so a later call rebuilds it. */
export function resetMailer(): void {
  transport = null;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send one message.
 *
 * **Throws on failure, deliberately.** Every caller here decides something
 * based on whether the mail went out — the retention notice stamps
 * `events.retention_notified_at` on success, and that stamp is what later
 * permits the album to be deleted. A send that quietly returned success on
 * failure would mark a host as warned when they were not, and their photos
 * would be deleted a fortnight later on the strength of a notice that never
 * arrived. Nothing here may fail soft.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const info = await getTransport().sendMail({
    from: CONFIG.MAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });

  // A transport can accept a message and still reject every recipient — SMTP
  // reports that per address rather than by throwing. Treating it as a send
  // would be the same lie as swallowing an exception.
  const rejected = (info as { rejected?: string[] }).rejected ?? [];
  if (rejected.length > 0) {
    throw new Error(`SMTP rejected recipient(s): ${rejected.join(', ')}`);
  }
}

/**
 * Check the SMTP connection and credentials without sending anything.
 * Used by the notice script so a misconfiguration surfaces as one clear error
 * rather than as a failure against every host in turn.
 */
export async function verifyMailer(): Promise<void> {
  await getTransport().verify();
}
