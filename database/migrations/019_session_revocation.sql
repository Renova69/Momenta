-- Server-side session revocation for host accounts.
--
-- Logging out used to be a purely client-side act: authService.logout() cleared
-- two localStorage keys and nothing else. The JWT itself stayed valid for its
-- full JWT_EXPIRES_IN (7 days by default), so a token captured or copied before
-- logout kept working — signing out on a shared laptop did not actually end the
-- session, it only hid it from that browser.
--
-- Every session token now carries the version it was minted at, and requireAuth
-- rejects any token whose version is behind the row. Incrementing this column is
-- therefore "sign out everywhere", which is the right meaning for a host account:
-- the reason to press logout is that someone else may have access.
--
-- Defaults to 0 so existing tokens (minted before this column existed, and so
-- carrying no version) keep working until their owner actually logs out.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
