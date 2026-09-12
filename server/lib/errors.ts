/**
 * Postgres errors carry a SQLSTATE `code`; everything else is a plain Error.
 * Logging the code (never the full error) keeps DB internals out of responses.
 */
export function errorLabel(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string };
    return e.code || e.message || 'unknown error';
  }
  return String(err);
}

/**
 * True when `err` is a Postgres unique-violation (SQLSTATE 23505), optionally
 * narrowed to one named constraint. A check-then-insert slug uniqueness test
 * is inherently racy under concurrent registration (SEC-P5) — this is what
 * the insert itself is caught against so the race can be retried instead of
 * surfacing as an opaque 500.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return false;
  return constraint === undefined || e.constraint === constraint;
}
