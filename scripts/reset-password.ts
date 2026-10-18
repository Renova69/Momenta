/**
 * Give a host who cannot sign in a temporary password (N-122).
 *
 *   npm run admin:reset-password -- host@example.com
 *
 * Until mail is configured there is no self-service "forgot password": a host
 * asks, and the operator runs this and passes the password on by phone or in
 * person. Every session the account had ends. The host then signs in and sets
 * their own password from the studio's profile ("Смяна на паролата").
 */
import { pool } from '../server/lib/db';
import { resetPasswordByEmail } from '../server/lib/passwordReset';

async function main(): Promise<number> {
  const email = process.argv[2];
  if (!email || !email.includes('@')) {
    console.error('Usage: npm run admin:reset-password -- <email>');
    return 2;
  }
  const temporary = await resetPasswordByEmail(email);
  if (!temporary) {
    console.error(`No account has the address ${email}.`);
    return 1;
  }
  console.log(`Temporary password for ${email}: ${temporary}`);
  // N-180 — this runs in its own process: signed-in pages stop at their next
  // request, and the server closes open live connections at its next session
  // check, within five minutes.
  console.log(
    'Every session of this account has ended (open live connections close within five minutes). ' +
      'Ask the host to change it after signing in.'
  );
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
