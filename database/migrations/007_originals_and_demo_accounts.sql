-- ====================================================================
-- Migration: 007_originals_and_demo_accounts.sql
-- Project: WedMoments
--
-- 1. Store the untouched original alongside the display and thumbnail
--    derivatives, so the paid "high-resolution ZIP" ships what it promises.
-- 2. Replace the frontend's fabricated demo session with real, seeded demo
--    accounts that authenticate through the normal login route.
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Original-quality photo retention
-- --------------------------------------------------------------------
-- original_url / original_storage_path hold the file exactly as the camera
-- produced it. full_url remains the display copy (long edge 1600px) and
-- thumbnail_url the feed copy (long edge 400px).
ALTER TABLE photos ADD COLUMN IF NOT EXISTS original_url TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS original_storage_path TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS original_bytes BIGINT;

-- Existing rows never had an original uploaded; leaving these NULL lets the ZIP
-- export fall back to the display copy for historical photos.
COMMENT ON COLUMN photos.original_url IS
  'Absolute URL of the unmodified upload. NULL for photos captured before migration 007.';

-- --------------------------------------------------------------------
-- 2. Seeded demo host accounts
-- --------------------------------------------------------------------
-- Password for both accounts: WedMomentsDemo2026!
-- These are intentionally public demo logins with no real data behind them.
INSERT INTO users (id, email, full_name, password_hash, role, company_name, avatar_url) VALUES
    (
      '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
      'demo.couple@wedmoments.bg',
      'Моника и Александър',
      '$2b$10$jtLm/C/NuYZmOCN.tfF8TOulqqDTi6Gn0S9cEcymVVnYsu6cZ.j5.',
      'couple',
      NULL,
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
    ),
    (
      '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
      'demo.planner@wedmoments.bg',
      'Гергана Димитрова',
      '$2b$10$jtLm/C/NuYZmOCN.tfF8TOulqqDTi6Gn0S9cEcymVVnYsu6cZ.j5.',
      'planner',
      'Сватбена Агенция "Димитрова & Ко."',
      'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=200&q=80'
    )
ON CONFLICT (id) DO UPDATE SET
    email         = EXCLUDED.email,
    full_name     = EXCLUDED.full_name,
    password_hash = EXCLUDED.password_hash,
    role          = EXCLUDED.role,
    company_name  = EXCLUDED.company_name,
    avatar_url    = EXCLUDED.avatar_url;

-- Free-tier subscriptions so the demo accounts exercise the real tier gates
-- rather than being silently privileged.
INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency, event_limit)
SELECT u.id, 'free', 'active', 'one_time', 0, 'EUR', 1
FROM users u
WHERE u.id IN (
    '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a02'
)
AND NOT EXISTS (
    SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active'
);

-- Attach the existing seeded demo wedding to the demo couple so the dashboard
-- has content to show.
UPDATE events
SET host_user_id = '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    host_email   = 'demo.couple@wedmoments.bg'
WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
  AND host_user_id IS NULL;
