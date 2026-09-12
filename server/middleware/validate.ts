import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError, ZodIssue } from 'zod';

/** Pull the issue list off a thrown Zod error, or null if it is something else. */
function zodIssues(err: unknown): ZodIssue[] | null {
  if (err instanceof ZodError) return err.issues;
  if (err && typeof err === 'object' && Array.isArray((err as { issues?: unknown }).issues)) {
    return (err as { issues: ZodIssue[] }).issues;
  }
  return null;
}

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      const issues = zodIssues(err);
      if (issues) {
        return res.status(400).json({
          error: 'Validation failed',
          details: issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      return res.status(400).json({ error: 'Invalid request body' });
    }
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Express 5 exposes `req.query` as a prototype getter, so a plain
      // assignment is silently discarded. Define an own property instead so the
      // parsed and coerced values are what handlers actually read.
      const parsed = schema.parse(req.query);
      Object.defineProperty(req, 'query', {
        value: parsed,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      next();
    } catch (err) {
      const issues = zodIssues(err);
      if (issues) {
        return res.status(400).json({
          error: 'Query parameter validation failed',
          details: issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      return res.status(400).json({ error: 'Invalid query parameters' });
    }
  };
}
