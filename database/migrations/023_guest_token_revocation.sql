-- 023 — give guest tokens a revocation path.
--
-- M10. A guest token is a bearer credential with a 400-day TTL, and that TTL
-- is justified: a Deluxe Keepsake album lives a year, and a guest reopening
-- the link weeks later should not be treated as a stranger claiming someone
-- else's identity. The problem was that nothing could ever end one. A token
-- copied off a shared phone, or read out of a screenshot, stayed valid for the
-- life of the album with nothing the host could do about it.
--
-- users.token_version (migration 019) solved the same problem for hosts, but
-- had no guests equivalent because there is no guest logout to bump it. The
-- trigger that does exist is a host action on the album they control:
-- "reset guest sessions".
--
-- Default 0, matching migration 019's approach: tokens minted before this
-- carry no version, are read as 0, and keep working until an actual reset
-- rather than breaking on deploy.

ALTER TABLE guests ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN guests.token_version IS
  'Incremented by the host-initiated guest session reset (M10). A guest token carrying an older version no longer verifies.';

-- The reset also clears device_fingerprint, and that pairing is what makes
-- revocation recoverable without reopening SEC-03: with the
-- (event_id, device_fingerprint) slot released, a returning guest no longer
-- matches an existing row, gets a genuinely fresh one, and is issued a token
-- because that row is inherently theirs. Issuing a token on a *match* is
-- precisely the hole SEC-03 exists to keep shut, so the slot has to be freed
-- rather than the rule relaxed.
--
-- The old row is left in place with its photos, comments and reactions
-- intact — revocation must never be a way to delete a guest's contributions.
