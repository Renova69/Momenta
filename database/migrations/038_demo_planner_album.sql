-- 038 — The demo planner has an album of its own (N-206)
--
-- Migration 007 seeded two demo logins, but an album only for the couple.
-- Signing in creates an album for an account that has none, and that runs
-- before the demo's view-only guard (N-166), so the first visitor to pick the
-- planner demo wrote one into the shared demo account. Sign-in now creates
-- nothing for a demo account, and this gives the planner the album that
-- sign-in used to make, with the same text.
--
-- Its deadline is left to the next expiry refresh, which counts it from the
-- account's plan like any other album (Pro Planner keeps it open).

INSERT INTO events (title, slug, host_name, host_email, host_user_id, plan_tier, event_date, venue_name, welcome_message)
SELECT 'Сватбата на ' || u.full_name,
       'demo-planner-gergana',
       u.full_name,
       u.email,
       u.id,
       'free',
       NOW() + INTERVAL '30 days',
       'Голяма зала за тържества',
       'Добре дошли на нашия сватбен ден! Сканирайте QR кода, снимайте весели и неподправени моменти и ни помогнете да запечатаме всеки миг заедно.'
  FROM users u
 WHERE u.id = '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a02'
   AND NOT EXISTS (SELECT 1 FROM events e WHERE e.host_user_id = u.id)
ON CONFLICT (slug) DO NOTHING;
