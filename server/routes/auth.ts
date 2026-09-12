import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../lib/db';
import { cleanSlug } from '../lib/storage';
import { generateToken, hashPassword, comparePassword, requireAuth, DUMMY_PASSWORD_HASH } from '../middleware/auth';
import { getEffectiveTierForEvent } from '../middleware/tierGate';
import { validateBody } from '../middleware/validate';
import { computeExpiry } from '../lib/retention';
import { authLimiter } from '../middleware/rateLimit';
import { errorLabel, isUniqueViolation } from '../lib/errors';

export const authRouter = Router();

// [FIX C-1/C-2/L-4] Passwords are now required. Max-length limits added.
// SEC-A7: bcrypt silently truncates at 72 *bytes*, not characters — a
// password with any multi-byte UTF-8 in it (accents, emoji) can exceed that
// well under 72 characters. Registration rejects it outright rather than
// silently accepting a password whose tail never actually gets checked;
// existing bcrypt hashes are untouched, this only guards new registrations.
const RegisterSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  fullName: z.string().min(2, 'Full name must be at least 2 characters').max(100),
  password: z.string()
    .min(6, 'Password must be at least 6 characters')
    .max(128)
    .refine((pw) => Buffer.byteLength(pw, 'utf8') <= 72, {
      message: 'Password must be at most 72 bytes (roughly 72 characters of plain text).',
    }),
  role: z.enum(['couple', 'planner', 'venue', 'photographer']).default('couple'),
  companyName: z.string().max(200).optional(),
});

const LoginSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});

// POST /api/auth/register
authRouter.post('/register', authLimiter, validateBody(RegisterSchema), async (req, res) => {
  const { email, fullName, password, role, companyName } = req.body;

  try {
    // [FIX C-2] If email already exists, reject with 409 — do NOT issue a token
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered. Please log in.' });
    }

    const passwordHash = await hashPassword(password);

    // The initial slug is a timestamp, not a real collision check — under
    // concurrent registration with the same full name (a load test, or two
    // guests signing up in the same venue at once) two requests can land in
    // the same millisecond. Retrying the whole transaction on the unique
    // constraint itself is what actually closes that race (SEC-P5); a
    // rollback undoes the user/subscription rows too, so a retry from
    // scratch cannot violate the email uniqueness check above.
    const MAX_SLUG_ATTEMPTS = 5;
    let result: { user: Record<string, unknown>; event: Record<string, unknown>; token: string } | undefined;

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !result; attempt++) {
      // [FIX M-13] Wrap all inserts in a transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const newUser = await client.query(
          `INSERT INTO users (email, full_name, password_hash, role, company_name)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, email, full_name, role, company_name, avatar_url, created_at, token_version`,
          [email, fullName, passwordHash, role, companyName || null]
        );
        const user = newUser.rows[0];

        // Create free subscription
        await client.query(
          `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency)
           VALUES ($1, 'free', 'active', 'one_time', 0, 'EUR') ON CONFLICT DO NOTHING`,
          [user.id]
        );

        // Auto-create initial wedding event
        const defaultEventDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const newSlug =
          attempt === 0
            ? cleanSlug(fullName) + '-' + Date.now().toString(36)
            : cleanSlug(fullName) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const newEvent = await client.query(
          `INSERT INTO events (title, slug, host_name, host_email, host_user_id, plan_tier, event_date, venue_name, welcome_message)
           VALUES ($1, $2, $3, $4, $5, 'free', $6, 'Голяма зала за тържества', 'Добре дошли на нашия сватбен ден! Сканирайте QR кода, снимайте весели и неподправени моменти и ни помогнете да запечатаме всеки миг заедно.')
           RETURNING id, title, slug, host_name, host_email, host_user_id, event_date, venue_name, welcome_message, theme_palette, cover_image_url, created_at`,
          [`${fullName}'s Wedding`, newSlug, fullName, email, user.id, defaultEventDate]
        );
        const event = newEvent.rows[0];
        // New accounts start on the free plan; the subscription row inserted above is authoritative.
        event.planTier = 'free';

        // Free albums are kept for 7 days after the celebration.
        const expiry = computeExpiry('free', event.event_date, event.created_at);
        await client.query('UPDATE events SET expires_at = $1 WHERE id = $2', [expiry, event.id]);
        event.expires_at = expiry;

        // Seed initial quests
        await client.query(
          `INSERT INTO scavenger_quests (event_id, title, description, icon_name, points)
           VALUES
           ($1, 'Първата целувка', 'Уловете магическия миг, когато младоженците си разменят първата целувка като съпруг и съпруга', 'heart', 15),
           ($1, 'Сълзи от радост', 'Уловете емоционален и трогателен момент от речите на кумовете и родителите', 'smile', 20),
           ($1, 'Най-забавното групово селфи', 'Съберете се цялата маса и направете най-щурото и забавно селфи!', 'users', 10),
           ($1, 'Снимай баба и дядо как танцуват', 'Улови техния романтичен и весел танц', 'music', 25),
           ($1, 'Празничен тост с шампанско', 'Снимайте звъна на чашите и искрящите усмивки по време на празничния тост!', 'wine', 15)`,
          [event.id]
        );

        await client.query('COMMIT');

        const token = generateToken({
          userId: user.id,
          email: user.email,
          role: user.role,
          fullName: user.full_name || fullName,
          // A brand-new row, so this is the column default (migration 019).
          tokenVersion: Number(user.token_version ?? 0),
        });

        result = { user, event, token };
      } catch (err) {
        await client.query('ROLLBACK');
        if (isUniqueViolation(err, 'events_slug_key') && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
        // M8 — the email pre-check above is a plain SELECT, so two concurrent
        // registrations for the same address can both pass it and one loses
        // the race against users_email_key. That is the same condition the
        // pre-check reports as 409; surfacing it as an opaque 500 just because
        // it was detected a few milliseconds later is a worse answer to an
        // identical situation.
        if (isUniqueViolation(err, 'users_email_key')) {
          return res.status(409).json({ error: 'Email already registered. Please log in.' });
        }
        throw err;
      } finally {
        client.release();
      }
    }

    if (!result) {
      return res.status(409).json({ error: 'Could not allocate a unique event URL. Please try again.' });
    }

    // [FIX M-9] Never return password_hash — explicit safe fields only
    const sanitizedUser = {
      id: result.user.id,
      email: result.user.email,
      fullName: result.user.full_name || fullName,
      role: result.user.role,
      companyName: result.user.company_name,
      avatarUrl: result.user.avatar_url,
      createdAt: result.user.created_at,
    };

    return res.status(201).json({ user: sanitizedUser, event: result.event, token: result.token });
  } catch (err) {
    console.error('[Auth] Register error:', errorLabel(err));
    // [FIX H-5] Never leak DB error details
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
authRouter.post('/login', authLimiter, validateBody(LoginSchema), async (req, res) => {
  const { email, password } = req.body;

  try {
    const { rows } = await pool.query(
      'SELECT id, email, full_name, role, company_name, avatar_url, created_at, password_hash, token_version FROM users WHERE email = $1 LIMIT 1',
      [email]
    );

    // [FIX C-1] Never auto-create accounts on login — return 401 for unknown emails.
    // SEC-A6: still runs a bcrypt comparison against a fixed decoy hash first,
    // so this response takes roughly as long as a real wrong-password 401 —
    // otherwise the two cases are distinguishable by timing alone (~1ms vs
    // bcrypt's ~90ms), which is enough to enumerate registered emails.
    if (rows.length === 0) {
      await comparePassword(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];

    if (!user.password_hash) {
      await comparePassword(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ error: 'Account requires password setup. Please contact support.' });
    }

    // Verify password against stored hash
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Resolve event — create one if host has none yet (legitimate case for OAuth imports)
    const eventRes = await pool.query(
      `SELECT id, title, slug, host_name, host_email, host_user_id, event_date, venue_name,
              welcome_message, theme_palette, cover_image_url, created_at
       FROM events WHERE host_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    let event = eventRes.rows[0];

    if (!event) {
      // DB-13: this fallback path (an OAuth import or any account that
      // somehow reached login with zero events) had its own copy of the
      // auto-create-an-event logic that predated both SEC-D4 (no
      // expires_at — the event never expired regardless of plan, unlike
      // every other event-creation path) and P5 (no retry on a slug
      // collision — an unhandled 500 instead of a working login). Mirrors
      // the register handler's pattern: one transaction, retry on 23505.
      const defaultDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const MAX_SLUG_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !event; attempt++) {
        const newSlug =
          attempt === 0
            ? cleanSlug(user.full_name) + '-' + Date.now().toString(36)
            : cleanSlug(user.full_name) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const createdEvent = await client.query(
            `INSERT INTO events (title, slug, host_name, host_email, host_user_id, plan_tier, event_date, venue_name, welcome_message)
             VALUES ($1, $2, $3, $4, $5, 'free', $6, 'Голяма зала за тържества', 'Добре дошли на нашия сватбен ден! Сканирайте QR кода, снимайте весели и неподправени моменти и ни помогнете да запечатаме всеки миг заедно.')
             RETURNING id, title, slug, host_name, host_email, host_user_id, event_date, venue_name, welcome_message, theme_palette, cover_image_url, created_at`,
            [`${user.full_name}'s Wedding`, newSlug, user.full_name, user.email, user.id, defaultDate]
          );
          const newEvent = createdEvent.rows[0];

          const expiry = computeExpiry('free', newEvent.event_date, newEvent.created_at);
          await client.query('UPDATE events SET expires_at = $1 WHERE id = $2', [expiry, newEvent.id]);
          newEvent.expires_at = expiry;

          await client.query('COMMIT');
          event = newEvent;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          if (isUniqueViolation(err, 'events_slug_key') && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
          throw err;
        } finally {
          client.release();
        }
      }
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      fullName: user.full_name,
      // Stamp the version this session starts at; a later logout increments the
      // column and leaves this token behind (migration 019).
      tokenVersion: Number(user.token_version ?? 0),
    });

    // [FIX M-9] Never return password_hash
    const sanitizedUser = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      companyName: user.company_name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    };

    event.planTier = await getEffectiveTierForEvent(event.id);
    res.json({ user: sanitizedUser, event, token });
  } catch (err) {
    console.error('[Auth] Login error:', errorLabel(err));
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// GET /api/auth/me
authRouter.get('/me', requireAuth, async (req, res) => {
  try {
    const userRes = await pool.query(
      `SELECT id, email, full_name as "fullName", role, company_name as "companyName",
              avatar_url as "avatarUrl", created_at as "createdAt"
       FROM users WHERE id = $1`,
      [req.user!.userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const eventRes = await pool.query(
      `SELECT id, title, slug, host_name, host_email, host_user_id, event_date, venue_name,
              welcome_message, theme_palette, cover_image_url, created_at
       FROM events WHERE host_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.user!.userId]
    );

    const event = eventRes.rows[0] || null;
    if (event) {
      event.planTier = await getEffectiveTierForEvent(event.id);
    }

    res.json({
      user: userRes.rows[0],
      event,
    });
  } catch (err) {
    console.error('[Auth] /me error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

const UpdateProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(200),
});

// PUT /api/auth/me — the host's own account profile. Email is intentionally
// not editable here: it's how the host registered and signs in, and this app
// has no email-change/re-verification flow.
authRouter.put('/me', requireAuth, validateBody(UpdateProfileSchema), async (req, res) => {
  const { fullName } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users SET full_name = $1 WHERE id = $2
       RETURNING id, email, full_name as "fullName", role, company_name as "companyName",
                 avatar_url as "avatarUrl", created_at as "createdAt"`,
      [fullName, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('[Auth] PUT /me error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/logout — end this account's sessions for real.
 *
 * Incrementing users.token_version (migration 019) invalidates every token
 * minted before now, so a token copied off a shared machine dies here rather
 * than living out the remaining days of its JWT_EXPIRES_IN window. Clearing
 * localStorage on the client cannot do that on its own; it only stops that one
 * browser from presenting the token.
 *
 * "Sign out everywhere" is deliberate, not a limitation. Someone pressing
 * logout on a host account generally does so because another person may have
 * had access, and ending only the session that happens to be asking would miss
 * exactly the session they are worried about.
 */
authRouter.post('/logout', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [
      req.user!.userId,
    ]);
    res.status(204).send();
  } catch (err) {
    console.error('[Auth] POST /logout error:', errorLabel(err));
    // The client clears its own storage regardless, but it must not be told
    // the session was revoked when it was not.
    res.status(500).json({ error: 'Could not complete sign-out' });
  }
});
