-- 026 — an email address is not case-sensitive, and the login form was.
--
-- `users.email` is a plain varchar, so `users_email_key` distinguishes
-- `Ana@example.com` from `ana@example.com`. Nothing in the register or login
-- handlers lowered the input either. No mail server on the public internet
-- treats those two as different mailboxes, and two things followed from
-- pretending otherwise — both of which a phone produces unprompted, because
-- mobile keyboards capitalise the first character of a text field:
--
--   A host who signed up on their phone as `Ana@...` and later typed `ana@...`
--   on a laptop was told "Invalid email or password." Not a confusing error —
--   a correct one, from the database's point of view. There was no such
--   account. They were locked out of their own wedding album, with no way to
--   discover why, and the obvious next step — register again — produced:
--
--   Two accounts for one person, each with its own album, its own plan and its
--   own storage. The unique constraint was satisfied throughout.
--
-- `server/lib/emailBounces.ts` already normalised addresses with
-- `trim().toLowerCase()`; this is the users table catching up with the
-- convention the rest of the system had settled on.
--
-- Two halves, and both are needed. The handlers now normalise on the way in
-- (a Zod transform on the shared EmailSchema, so every reader of req.body.email
-- gets the same value and no future handler has to remember). This migration
-- normalises what is already stored and then makes the pair impossible to
-- create again, so the guarantee does not depend on every future write path
-- going through that schema.

-- Normalise what is there. Checked before writing this: no existing row
-- differs from its own lowercase form, and no two rows collide when lowered,
-- so this is a no-op on the current data and exists for deployments whose rows
-- predate it.
UPDATE users SET email = lower(email) WHERE email <> lower(email);

-- If a deployment *does* hold a collided pair, the index below will fail to
-- build and the migration will abort rather than silently merge two people's
-- accounts. That is the correct outcome: which of the two is the real host,
-- and what becomes of the other's album, is not a decision a schema change
-- gets to make on its own.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

COMMENT ON INDEX idx_users_email_lower IS
  'Case-insensitive uniqueness for users.email. The handlers lowercase on the way in; this is what makes that a guarantee rather than a convention.';
