import crypto from 'crypto';
import { pool } from './db';
import { hashPassword } from '../middleware/auth';

/**
 * Give an account a new, temporary password, for the operator to pass on
 * (N-122). Forgotten passwords are reset by email once mail is configured;
 * until then a host who cannot sign in asks, and the operator runs
 * `npm run admin:reset-password -- <email>`.
 *
 * Every session the account had ends with it (token_version), so whoever knew
 * the old password is out. Answers null when no account has the address.
 */
export async function resetPasswordByEmail(email: string): Promise<string | null> {
  // 12 bytes of randomness, URL-safe: 16 characters, short enough to read out.
  const temporary = crypto.randomBytes(12).toString('base64url');
  const hash = await hashPassword(temporary);
  const { rowCount } = await pool.query(
    'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE email = $2',
    [hash, email.trim().toLowerCase()]
  );
  return rowCount ? temporary : null;
}
