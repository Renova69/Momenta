import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { hashPassword, comparePassword, generateToken, requireAuth, optionalAuth, DUMMY_PASSWORD_HASH } from '../../server/middleware/auth';
import { validateBody, validateQuery } from '../../server/middleware/validate';
import { z } from 'zod';
import { query } from '../../server/lib/db';

/**
 * requireAuth/optionalAuth verify the signature AND check the token against
 * users.token_version (migration 019), so they are async and need a real user
 * row. These specs used to sign a token for a made-up id and call the
 * middleware synchronously; both stopped being valid when revocation landed.
 */
let realUserId = '';

beforeAll(async () => {
  const { rows } = await query(
    `INSERT INTO users (email, full_name, role, password_hash)
     VALUES ($1, 'Middleware Spec User', 'couple', 'x') RETURNING id`,
    [`middleware-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`]
  );
  realUserId = rows[0].id;
});

afterAll(async () => {
  if (realUserId) await query('DELETE FROM users WHERE id = $1', [realUserId]).catch(() => undefined);
});

function createMockResponse(): { res: Response; statusFn: ReturnType<typeof vi.fn>; jsonFn: ReturnType<typeof vi.fn> } {
  const jsonFn = vi.fn();
  const statusFn = vi.fn().mockReturnValue({ json: jsonFn });
  const res = {
    status: statusFn,
    json: jsonFn,
  } as unknown as Response;
  return { res, statusFn, jsonFn };
}

describe('Server Authentication & Middleware Spec', () => {
  it('hashes passwords with bcrypt and verifies hashes correctly', async () => {
    const rawPass = 'SecretPassword123!';
    const hashed = await hashPassword(rawPass);

    expect(hashed).toMatch(/^\$2[aby]\$\d+\$/);
    expect(await comparePassword(rawPass, hashed)).toBe(true);
    expect(await comparePassword('WrongPassword', hashed)).toBe(false);
  });

  it('exposes a real, comparable bcrypt decoy hash for login timing normalization (SEC-A6)', async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$2[aby]\$\d+\$/);
    // A real bcrypt round trip, not a fast-path stub — this is what makes it
    // useful as a timing decoy for a nonexistent-email login attempt.
    expect(await comparePassword('anything at all', DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it('generates and verifies JWT tokens with valid claims', () => {
    const payload = { userId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', email: 'test@example.com', role: 'couple', fullName: 'Couple' };
    const token = generateToken(payload);

    expect(typeof token).toBe('string');
  });

  it('requireAuth middleware guards routes and extracts verified user', async () => {
    const token = generateToken({ userId: realUserId, email: 'u1@test.com', role: 'couple', fullName: 'Couple' });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const { res, statusFn } = createMockResponse();
    const next: NextFunction = vi.fn();

    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user?.userId).toBe(realUserId);

    // Missing token
    const unauthReq = { headers: {} } as unknown as Request;
    await requireAuth(unauthReq, res, next);
    expect(statusFn).toHaveBeenCalledWith(401);
  });

  it('requireAuth rejects a well-signed token for a user that no longer exists', async () => {
    // Same shape as a valid session token, but nothing to check the version
    // against — a deleted account must not keep an authenticated session.
    // Deliberately NOT the '10eebc99-…' sample id used elsewhere in the suite:
    // that one belongs to the seeded demo.couple@wedmoments.bg row, so the
    // middleware rightly accepted it and this test failed on its own premise.
    const token = generateToken({
      userId: randomUUID(),
      email: 'gone@test.com',
      role: 'couple',
      fullName: 'Deleted',
    });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const { res, statusFn } = createMockResponse();
    const next: NextFunction = vi.fn();

    await requireAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledWith(401);
  });

  it('optionalAuth middleware attaches user if token valid, or proceeds if missing', async () => {
    const token = generateToken({ userId: realUserId, email: 'u2@test.com', role: 'couple', fullName: 'Couple' });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const { res } = createMockResponse();
    const next: NextFunction = vi.fn();

    await optionalAuth(req, res, next);
    expect(req.user?.userId).toBe(realUserId);
    expect(next).toHaveBeenCalled();

    const noAuthReq = { headers: {} } as unknown as Request;
    const next2: NextFunction = vi.fn();
    await optionalAuth(noAuthReq, res, next2);
    expect(noAuthReq.user).toBeUndefined();
    expect(next2).toHaveBeenCalled();
  });

  it('validateBody middleware validates and strips invalid request inputs', () => {
    const schema = z.object({
      name: z.string().min(2),
      age: z.number().optional(),
    });

    const validReq = { body: { name: 'Alex' } } as unknown as Request;
    const { res, statusFn } = createMockResponse();
    const next: NextFunction = vi.fn();

    validateBody(schema)(validReq, res, next);
    expect(next).toHaveBeenCalled();

    const invalidReq = { body: { name: 'A' } } as unknown as Request;
    validateBody(schema)(invalidReq, res, next);
    expect(statusFn).toHaveBeenCalledWith(400);
  });

  it('validateQuery middleware validates query parameters', () => {
    const querySchema = z.object({
      eventId: z.string().uuid(),
    });

    const validReq = { query: { eventId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01' } } as unknown as Request;
    const { res, statusFn } = createMockResponse();
    const next: NextFunction = vi.fn();

    validateQuery(querySchema)(validReq, res, next);
    expect(next).toHaveBeenCalled();

    const invalidReq = { query: { eventId: 'not-a-uuid' } } as unknown as Request;
    validateQuery(querySchema)(invalidReq, res, next);
    expect(statusFn).toHaveBeenCalledWith(400);
  });
});
