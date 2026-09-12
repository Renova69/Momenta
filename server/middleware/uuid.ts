import { Request, Response, NextFunction } from 'express';
import { isValidUuid } from '../lib/validation';

/**
 * Reject malformed UUID route parameters before they reach SQL.
 *
 * Without this a non-UUID id reaches Postgres, raises `22P02 invalid input
 * syntax for type uuid`, and surfaces as a 500 with a stack trace in the logs —
 * when the correct answer is a 400. Apply to every route with a `:id`-style
 * parameter that is used as a UUID.
 */
export function requireUuidParams(...names: string[]) {
  const params = names.length > 0 ? names : ['id'];

  return (req: Request, res: Response, next: NextFunction): void => {
    for (const name of params) {
      const raw = req.params[name];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (!isValidUuid(value)) {
        res.status(400).json({
          error: `Invalid ${name}: expected a UUID.`,
          code: 'INVALID_UUID',
        });
        return;
      }
    }
    next();
  };
}
