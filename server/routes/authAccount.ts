import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../lib/db';
import { generateToken, hashPassword, comparePassword, requireAuth, DUMMY_PASSWORD_HASH } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { accountActionLimiter } from '../middleware/rateLimit';
import { errorLabel } from '../lib/errors';
import { getStripeClient, subscriptionLivenessAtStripe } from '../lib/stripe';
import { eraseAlbum, AlbumBeingDeletedError } from '../lib/albumErasure';
import { wsManager } from '../ws/wsServer';

/**
 * A host's own account: change the password, delete the account (N-122).
 * Mounted on authRouter. Both actions confirm the current password.
 */
export const accountRouter = Router();

/**
 * The rules a new password meets, at registration and on a change.
 * SEC-A7: bcrypt silently truncates at 72 *bytes*, not characters, so a
 * password whose tail would never be checked is refused rather than stored.
 */
export const NewPasswordSchema = z
  .string()
  .min(6, 'Password must be at least 6 characters')
  .max(128)
  .refine((pw) => Buffer.byteLength(pw, 'utf8') <= 72, {
    message: 'Password must be at most 72 bytes (roughly 72 characters of plain text).',
  });

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128),
  newPassword: NewPasswordSchema,
});

const DeleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required').max(128),
});

type Refusal = { status: number; body: { error: string; code: string } };

/** Null when `password` is this account's; otherwise what to answer. */
async function passwordRefusal(userId: string, password: string): Promise<Refusal | null> {
  const { rows } = await pool.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [
    userId,
  ]);
  const hash = rows[0]?.password_hash;
  if (!hash) {
    // Same time as a real check, as at sign-in (SEC-A6).
    await comparePassword(password, DUMMY_PASSWORD_HASH);
    return {
      status: 401,
      body: { error: 'Account requires password setup. Please contact support.', code: 'PASSWORD_SETUP_REQUIRED' },
    };
  }
  if (!(await comparePassword(password, hash))) {
    return { status: 401, body: { error: 'The password is not correct.', code: 'INVALID_CREDENTIALS' } };
  }
  return null;
}

// POST /api/auth/password — keeps this session, ends every other.
accountRouter.post(
  '/password',
  requireAuth,
  accountActionLimiter,
  validateBody(ChangePasswordSchema),
  async (req, res) => {
    const userId = req.user!.userId;
    const { currentPassword, newPassword } = req.body as z.infer<typeof ChangePasswordSchema>;

    try {
      const refused = await passwordRefusal(userId, currentPassword);
      if (refused) return res.status(refused.status).json(refused.body);

      // A password is usually changed because someone else may know it, so
      // every session minted under the old one ends (token_version), and
      // open sockets are closed (N-38). This session gets a fresh token.
      const { rows } = await pool.query<{ email: string; role: string; full_name: string; token_version: number }>(
        `UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2
         RETURNING email, role, full_name, token_version`,
        [await hashPassword(newPassword), userId]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
      wsManager.closeUserSessions(userId);

      const user = rows[0];
      const token = generateToken({
        userId,
        email: user.email,
        role: user.role,
        fullName: user.full_name,
        tokenVersion: Number(user.token_version),
      });
      res.json({ token });
    } catch (err) {
      console.error('[Auth] POST /password error:', errorLabel(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * Cancel every plan of this account that Stripe still bills. False when Stripe
 * could not say or could not cancel: the account must then stay, rather than
 * be erased while its card goes on being charged.
 */
async function cancelPlansAtStripe(userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ stripe_subscription_id: string }>(
    `SELECT DISTINCT stripe_subscription_id FROM subscriptions
      WHERE user_id = $1 AND stripe_subscription_id IS NOT NULL AND status <> 'canceled'`,
    [userId]
  );
  for (const { stripe_subscription_id: subscriptionId } of rows) {
    const liveness = await subscriptionLivenessAtStripe(subscriptionId);
    if (liveness === 'ended') continue;
    if (liveness === 'unknown') return false;
    try {
      await getStripeClient().subscriptions.cancel(subscriptionId);
    } catch (err) {
      console.error(`[Auth] could not cancel subscription ${subscriptionId} for an account deletion:`, errorLabel(err));
      return false;
    }
  }
  return true;
}

/**
 * DELETE /api/auth/account — the host's right to erasure (GDPR Article 17).
 *
 * Immediate and complete once the password is confirmed: a live plan is
 * cancelled at Stripe first, then every album is erased the way deleting one
 * album is (files before rows, an anonymous record that it happened), then the
 * account. Stripe keeps its own payment records, which the law requires.
 */
accountRouter.delete(
  '/account',
  requireAuth,
  accountActionLimiter,
  validateBody(DeleteAccountSchema),
  async (req, res) => {
    const userId = req.user!.userId;
    const { password } = req.body as z.infer<typeof DeleteAccountSchema>;

    try {
      const refused = await passwordRefusal(userId, password);
      if (refused) return res.status(refused.status).json(refused.body);

      if (!(await cancelPlansAtStripe(userId))) {
        return res.status(503).json({
          error: 'The payment provider could not be reached to cancel the plan. Nothing was deleted; please try again.',
          code: 'BILLING_UNVERIFIABLE',
        });
      }

      const albums = await pool.query<{ id: string }>('SELECT id FROM events WHERE host_user_id = $1', [userId]);
      let photosDeleted = 0;
      for (const { id } of albums.rows) {
        try {
          photosDeleted += (await eraseAlbum(id)).photosDeleted;
        } catch (err) {
          if (err instanceof AlbumBeingDeletedError) {
            return res.status(409).json({
              error: 'One of the albums is already being deleted. Try again in a few minutes.',
              code: 'DELETION_IN_PROGRESS',
            });
          }
          throw err;
        }
      }

      // Cascades the subscription rows; the deletion records keep no owner.
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      wsManager.closeUserSessions(userId);
      console.warn(`[Auth] account ${userId} deleted with ${albums.rows.length} album(s), ${photosDeleted} photo(s)`);

      res.json({ deleted: true, albumsDeleted: albums.rows.length, photosDeleted });
    } catch (err) {
      console.error('[Auth] DELETE /account error:', errorLabel(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);
