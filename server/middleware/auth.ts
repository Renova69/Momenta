import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { CONFIG } from '../lib/config';
import { pool } from '../lib/db';
import { errorLabel } from '../lib/errors';

export interface AuthUserPayload {
  userId: string;
  email: string;
  role: string;
  fullName: string;
  /**
   * The users.token_version this token was minted at (migration 019).
   * Optional because tokens issued before that migration carry no version;
   * those are treated as version 0, which is also the column's default, so
   * they keep working until their owner actually logs out.
   */
  tokenVersion?: number;
  /**
   * N-166 — set by requireAuth/optionalAuth from users.is_demo on every
   * request, never read from the token, so it cannot be claimed or kept after
   * the flag changes. generateToken never receives it.
   */
  isDemo?: boolean;
}

/** N-166 — what a demo account is told when it tries to change anything. */
export const DEMO_READ_ONLY_CODE = 'DEMO_READ_ONLY';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// SEC-01: session JWTs, download tokens (server/lib/downloadToken.ts) and
// guest tokens (server/lib/guestAuth.ts) are all signed with the same
// CONFIG.JWT_SECRET. requireAuth/optionalAuth only ever checked the
// signature and algorithm, never that the decoded payload was actually a
// *session* token - so a 5-minute single-purpose export-zip download token
// (which carries a real userId, just in a URL query string where it can end
// up in proxy logs or browser history) decoded cleanly as AuthUserPayload
// and passed every `req.user!.userId === host_user_id` ownership check in
// the app, replaying as a full host session for its 5-minute life. Special-
// purpose tokens always set a `purpose` field and never carry `email`; a
// real session token never sets `purpose` and always carries `email` - this
// is the same distinction downloadToken.ts's own verifyDownloadToken already
// enforces in the other direction.
export function isSessionTokenPayload(decoded: unknown): decoded is AuthUserPayload {
  if (!decoded || typeof decoded !== 'object') return false;
  const payload = decoded as Record<string, unknown>;
  return payload.purpose === undefined && typeof payload.email === 'string' && typeof payload.userId === 'string';
}

declare global {
  // Express type augmentation has no module-syntax equivalent.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUserPayload;
    }
  }
}

// Generate signed JWT Token
export function generateToken(payload: AuthUserPayload): string {
  return jwt.sign(payload, CONFIG.JWT_SECRET, {
    // jsonwebtoken types `expiresIn` as a template-literal union ('7d' | '1h' | ...),
    // which a value read from the environment at runtime cannot satisfy.
    expiresIn: CONFIG.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

// Hash password with bcrypt
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

// Compare password
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// SEC-A6 — a bcrypt hash of a fixed, meaningless string, computed once at
// module load. Login compares against this when the email doesn't exist (or
// has no password set) so that path takes roughly the same time as a real
// user with the wrong password, instead of returning in ~1ms while a real
// comparison takes bcrypt's ~90ms — a gap an attacker can use to enumerate
// which emails have accounts.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('wedmoments-timing-decoy', 10);

/**
 * Is this token still the current session for its user?
 *
 * Compares the version baked into the token against users.token_version
 * (migration 019). Logout increments the column, so every token minted before
 * it — including one copied off a shared machine — stops working immediately.
 *
 * One indexed primary-key lookup per authenticated request. That cost is
 * deliberate and small in context: the burst path at a wedding is guest photo
 * upload, which authenticates with guest tokens (lib/guestAuth.ts), not with
 * these. Host requests are dashboard actions.
 *
 * Fails CLOSED. If the lookup throws, the safe answer is "not current" — a
 * database blip must not become a window where revoked tokens are honoured.
 */
export async function isSessionTokenCurrent(payload: AuthUserPayload): Promise<boolean> {
  return (await currentSession(payload)) !== null;
}

/**
 * The same lookup, also answering whether the account is the public demo
 * (N-166). Null when the token is not current.
 */
async function currentSession(payload: AuthUserPayload): Promise<{ isDemo: boolean } | null> {
  try {
    const { rows } = await pool.query('SELECT token_version, is_demo FROM users WHERE id = $1', [payload.userId]);
    // No row: the account is gone, so no token for it is current.
    if (rows.length === 0) return null;
    if ((payload.tokenVersion ?? 0) !== Number(rows[0].token_version ?? 0)) return null;
    return { isDemo: rows[0].is_demo === true };
  } catch (err) {
    console.error('[Auth] token_version lookup failed:', errorLabel(err));
    return null;
  }
}

/**
 * N-166 — mounted before requireAuth on the few writes a demo visitor may
 * make because they change nothing anyone else sees: signing out, and asking
 * for a ZIP download token.
 */
export function allowDemoAccount(_req: Request, res: Response, next: NextFunction) {
  res.locals.allowDemo = true;
  next();
}

// Middleware: Require Authenticated Host User
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.substring(7);
  try {
    // Pinned so a token cannot switch algorithm (e.g. to 'none') to bypass
    // signature verification (SEC-A5).
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET, { algorithms: ['HS256'] });
    if (!isSessionTokenPayload(decoded)) {
      return res.status(401).json({ error: 'Unauthorized: Token expired or invalid' });
    }

    const session = await currentSession(decoded);
    if (!session) {
      // Distinct from the generic message below on purpose: this one is not a
      // hint an attacker can use (the token is already dead), and the client
      // needs to tell "signed out elsewhere" apart from "expired" to show the
      // right thing.
      return res.status(401).json({ error: 'Session has been signed out', code: 'SESSION_REVOKED' });
    }

    req.user = { ...decoded, isDemo: session.isDemo };

    // N-166 — the demo login is public (the one-click button), so the demo
    // account is view-only. Decided here, for every host route at once, so a
    // route added later is refused without anyone remembering to.
    if (session.isDemo && !READ_ONLY_METHODS.has(req.method) && !res.locals.allowDemo) {
      return res.status(403).json({
        error: 'The demo account is view-only: nothing it changes is saved.',
        code: DEMO_READ_ONLY_CODE,
      });
    }
    next();
  } catch {
    // The reason is deliberately not echoed back: distinguishing "expired" from
    // "malformed" tells an attacker which half of the token to work on.
    return res.status(401).json({ error: 'Unauthorized: Token expired or invalid' });
  }
}

// Middleware: Optional Authentication (attaches req.user if present, does not fail)
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, CONFIG.JWT_SECRET, { algorithms: ['HS256'] });
      // A revoked token must not identify anyone here either. These routes
      // widen what they return for a recognised host (GET /api/photos shows
      // pending photos to the owner), so treating a signed-out token as
      // "just a guest" is the whole point rather than a nicety.
      const session = isSessionTokenPayload(decoded) ? await currentSession(decoded) : null;
      if (session) req.user = { ...(decoded as AuthUserPayload), isDemo: session.isDemo };
    } catch {
      // ignore invalid token for optional routes
    }
  }
  next();
}
