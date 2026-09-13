import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createTransport = vi.fn();

vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: unknown[]) => createTransport(...args) },
  createTransport: (...args: unknown[]) => createTransport(...args),
}));

import { isMailerConfigured, resetMailer, sendMail, verifyMailer } from '../../server/lib/mailer';
import { CONFIG } from '../../server/lib/config';

/**
 * Outbound email, which is load-bearing for a destructive decision.
 *
 * The retention sweep will not delete an album until its host has been warned,
 * and `events.retention_notified_at` is stamped on the strength of what this
 * module reports. Anything here that returned success without a message
 * actually going out would mark a host as warned who was not, and their
 * wedding photos would be deleted a fortnight later on the back of a notice
 * that never arrived. So what is pinned below is mostly the refusals: an
 * unconfigured relay, a transport that throws, and — the easy one to miss — a
 * transport that accepts the message and rejects the recipient, which SMTP
 * reports in the response body rather than by throwing.
 */

const ORIGINAL = {
  SMTP_HOST: CONFIG.SMTP_HOST,
  SMTP_PORT: CONFIG.SMTP_PORT,
  SMTP_SECURE: CONFIG.SMTP_SECURE,
  SMTP_USER: CONFIG.SMTP_USER,
  SMTP_PASSWORD: CONFIG.SMTP_PASSWORD,
};

/** A transport whose sendMail resolves with the given SMTP response. */
function stubTransport(response: Record<string, unknown> = { rejected: [] }) {
  const transport = {
    sendMail: vi.fn().mockResolvedValue(response),
    verify: vi.fn().mockResolvedValue(true),
  };
  createTransport.mockReturnValue(transport);
  return transport;
}

const MESSAGE = {
  to: 'host@example.com',
  subject: 'Your album expires in 14 days',
  text: 'Download your photos before they are removed.',
};

beforeEach(() => {
  resetMailer();
  createTransport.mockReset();
  CONFIG.SMTP_HOST = 'smtp.example.com';
  CONFIG.SMTP_PORT = 587;
  CONFIG.SMTP_SECURE = false;
  CONFIG.SMTP_USER = 'mailer';
  CONFIG.SMTP_PASSWORD = 'secret';
});

afterEach(() => {
  resetMailer();
  Object.assign(CONFIG, ORIGINAL);
});

describe('isMailerConfigured', () => {
  it('is false when no relay is set', () => {
    CONFIG.SMTP_HOST = '';
    expect(isMailerConfigured()).toBe(false);
  });

  it('is true once a host is set', () => {
    expect(isMailerConfigured()).toBe(true);
  });
});

describe('building the transport', () => {
  it('refuses to send when no relay is configured', async () => {
    // The alternative is a transport built from empty credentials that fails
    // per-message, which reads as a delivery problem rather than a deployment
    // one.
    CONFIG.SMTP_HOST = '';

    await expect(sendMail(MESSAGE)).rejects.toThrow(/not configured/i);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('refuses to verify when no relay is configured', async () => {
    CONFIG.SMTP_HOST = '';
    await expect(verifyMailer()).rejects.toThrow(/not configured/i);
  });

  it('passes the host, port and TLS setting through', async () => {
    CONFIG.SMTP_PORT = 465;
    CONFIG.SMTP_SECURE = true;
    stubTransport();

    await sendMail(MESSAGE);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 465, secure: true })
    );
  });

  it('sends credentials when a user is configured', async () => {
    stubTransport();

    await sendMail(MESSAGE);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: 'mailer', pass: 'secret' } })
    );
  });

  it('omits the auth key entirely for an anonymous relay', async () => {
    // Not an empty auth object: nodemailer takes that as a reason to attempt
    // AUTH, which a relay accepting mail from a trusted network will reject.
    CONFIG.SMTP_USER = '';
    stubTransport();

    await sendMail(MESSAGE);

    expect(createTransport.mock.calls[0][0]).not.toHaveProperty('auth');
  });

  it('builds the transport once and reuses it', async () => {
    stubTransport();

    await sendMail(MESSAGE);
    await sendMail(MESSAGE);

    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after a reset', async () => {
    stubTransport();
    await sendMail(MESSAGE);

    resetMailer();
    await sendMail(MESSAGE);

    expect(createTransport).toHaveBeenCalledTimes(2);
  });
});

describe('sendMail', () => {
  it('sends from the configured address with the plain-text body', async () => {
    const transport = stubTransport();

    await sendMail(MESSAGE);

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: CONFIG.MAIL_FROM,
        to: MESSAGE.to,
        subject: MESSAGE.subject,
        text: MESSAGE.text,
      })
    );
  });

  it('omits the html key when the caller supplied none', async () => {
    // A present-but-empty html part makes some clients render a blank message
    // in place of the text one.
    const transport = stubTransport();

    await sendMail(MESSAGE);

    expect(transport.sendMail.mock.calls[0][0]).not.toHaveProperty('html');
  });

  it('includes the html part when there is one', async () => {
    const transport = stubTransport();

    await sendMail({ ...MESSAGE, html: '<p>Download your photos.</p>' });

    expect(transport.sendMail.mock.calls[0][0]).toMatchObject({
      html: '<p>Download your photos.</p>',
    });
  });

  it('throws when the transport throws', async () => {
    const transport = stubTransport();
    transport.sendMail.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(sendMail(MESSAGE)).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when the relay accepted the message but rejected the recipient', async () => {
    // This is the one that matters. The promise resolves, so a caller reading
    // only "did it throw" records the host as warned — and the sweep then has
    // permission to delete their album.
    stubTransport({ accepted: [], rejected: ['host@example.com'] });

    await expect(sendMail(MESSAGE)).rejects.toThrow(/rejected recipient/i);
  });

  it('names every rejected address', async () => {
    stubTransport({ rejected: ['a@example.com', 'b@example.com'] });

    await expect(sendMail(MESSAGE)).rejects.toThrow(/a@example\.com, b@example\.com/);
  });

  it('treats a response with no rejected list as a success', async () => {
    // Not every transport reports the field; absent is not the same as "all
    // rejected", and refusing here would stop notices going out at all.
    stubTransport({ accepted: ['host@example.com'] });

    await expect(sendMail(MESSAGE)).resolves.toBeUndefined();
  });

  it('treats an empty rejected list as a success', async () => {
    stubTransport({ rejected: [] });

    await expect(sendMail(MESSAGE)).resolves.toBeUndefined();
  });
});

describe('verifyMailer', () => {
  it('asks the transport to verify the connection', async () => {
    const transport = stubTransport();

    await verifyMailer();

    expect(transport.verify).toHaveBeenCalledTimes(1);
  });

  it('propagates a verification failure', async () => {
    // The notice script calls this first so a bad password surfaces once,
    // rather than as a separate failure against every host in the sweep.
    const transport = stubTransport();
    transport.verify.mockRejectedValue(new Error('535 Authentication failed'));

    await expect(verifyMailer()).rejects.toThrow('535 Authentication failed');
  });
});
