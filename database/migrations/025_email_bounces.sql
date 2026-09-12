-- 025 — a bounced warning is not a warning.
--
-- Migration 024 made `events.retention_notified_at` the thing that permits
-- deletion, and the notice sender stamps it only after a confirmed send. That
-- confirmation is weaker than it looks.
--
-- `sendMail` throws when the transport rejects a recipient during the SMTP
-- conversation, and that case is handled. But a relay normally *accepts* a
-- message, returns 250, and bounces asynchronously minutes later when the
-- receiving server refuses it — no mailbox, domain gone, address abandoned
-- after the wedding. Nothing in this system could see that. The album was
-- stamped as warned, and a fortnight later the sweep deleted the photographs
-- on the strength of a notice that was never delivered.
--
-- The host whose address has died is precisely the host least able to notice
-- their album is about to be destroyed, so this is the exact failure the notice
-- mechanism exists to prevent, surviving inside it.
--
-- A bounce is a property of the address, not of one album — a host may own
-- several events, and all of them are equally unwarned. So the record is keyed
-- by address.
CREATE TABLE IF NOT EXISTS email_bounces (
  email       TEXT PRIMARY KEY,
  -- 'hard'  — permanent (no such mailbox, domain does not exist). Blocks.
  -- 'soft'  — transient (mailbox full, greylisted). Recorded, does not block;
  --           the next run retries, which is what a soft bounce means.
  kind        TEXT NOT NULL CHECK (kind IN ('hard', 'soft')),
  bounced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Whatever the provider said, kept verbatim for whoever has to work out why.
  detail      TEXT,
  -- Which provider or person reported it, so a wrong entry can be traced.
  source      TEXT NOT NULL DEFAULT 'manual',
  -- Set when a human has dealt with it: address corrected, or confirmed fine.
  -- Clearing is deliberate and manual; nothing expires a hard bounce on its
  -- own, because "it has been a while" is not evidence an address works.
  cleared_at  TIMESTAMPTZ
);

COMMENT ON TABLE email_bounces IS
  'Addresses that have bounced. An uncleared hard bounce makes every album owned by that address permanently un-notifiable, and therefore permanently undeletable, until a person resolves it.';

COMMENT ON COLUMN email_bounces.kind IS
  'hard = permanent failure, blocks notice and deletion. soft = transient, recorded only.';

-- The notice sender asks "which addresses are blocked?" on every run; the
-- partial index keeps that to the handful of rows that are actually blocking.
CREATE INDEX IF NOT EXISTS idx_email_bounces_active
    ON email_bounces(email)
    WHERE cleared_at IS NULL AND kind = 'hard';

-- Any album already stamped on the strength of a mail that later bounced must
-- be un-armed, not merely prevented from being stamped again. There is no data
-- to repair today — nothing has ever been sent — but a deployment that enables
-- SMTP, sends, bounces and then applies this migration would otherwise carry
-- armed albums past it. Recording a bounce does this going forward (see
-- server/lib/emailBounces.ts); this covers anything that predates the table.
UPDATE events e
   SET retention_notified_at = NULL
  FROM email_bounces b
 WHERE lower(e.host_email) = b.email
   AND b.kind = 'hard'
   AND b.cleared_at IS NULL
   AND e.retention_notified_at IS NOT NULL;
