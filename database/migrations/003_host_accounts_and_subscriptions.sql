-- ====================================================================
-- Migration: 003_host_accounts_and_subscriptions.sql
-- Add Host Users, Multi-Event Management, and Subscriptions / Event Passes
-- ====================================================================

-- 1. Table: users (Host / Client Accounts)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(50) DEFAULT 'couple', -- 'couple', 'planner', 'venue', 'photographer'
    company_name VARCHAR(150),
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 2. Table: subscriptions & event passes
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier VARCHAR(50) DEFAULT 'celebration_pass', -- 'free', 'celebration_pass', 'deluxe_keepsake', 'pro_planner'
    status VARCHAR(50) DEFAULT 'active', -- 'active', 'canceled', 'past_due'
    billing_type VARCHAR(50) DEFAULT 'one_time', -- 'one_time', 'monthly', 'annual'
    amount_paid_cents INT DEFAULT 4900,
    currency VARCHAR(10) DEFAULT 'EUR',
    event_limit INT DEFAULT 1,
    storage_limit_gb INT DEFAULT 10,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);

-- 3. Update events table to link to host_user_id and plan tier
DO $$ BEGIN
    ALTER TABLE events ADD COLUMN host_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE events ADD COLUMN plan_tier VARCHAR(50) DEFAULT 'celebration_pass';
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

-- 4. Seed a Demo Host Account (Моника и Александър + Гергана Димитрова с парола 'Password123!')
INSERT INTO users (id, email, full_name, password_hash, role, company_name, avatar_url) VALUES
    (
        '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
        'monika.alexander@wedmoments.bg',
        'Моника и Александър',
        '$2a$10$7R9rGjV9x0Q2P2G6R1K9yODrVwz8aPz4nU5mN6s8mQ4rYv2w5qXw3',
        'couple',
        NULL,
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
    ),
    (
        '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
        'gergana.dimitrova@weddings.bg',
        'Гергана Димитрова',
        '$2a$10$7R9rGjV9x0Q2P2G6R1K9yODrVwz8aPz4nU5mN6s8mQ4rYv2w5qXw3',
        'planner',
        'Сватбена Агенция "Димитрова & Ко."',
        'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=200&q=80'
    )
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    company_name = EXCLUDED.company_name;

-- 5. Seed Subscriptions
INSERT INTO subscriptions (id, user_id, tier, status, billing_type, amount_paid_cents, event_limit, storage_limit_gb) VALUES
    (
        '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
        '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
        'deluxe_keepsake',
        'active',
        'one_time',
        9900,
        1,
        25
    ),
    (
        '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
        '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
        'pro_planner',
        'active',
        'monthly',
        4900,
        10,
        100
    )
ON CONFLICT (id) DO NOTHING;

-- 6. Link sample event to host account
UPDATE events SET host_user_id = '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', plan_tier = 'deluxe_keepsake'
WHERE slug = 'monika-and-alexander-2026';
