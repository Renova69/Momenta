-- ====================================================================
-- Migration: 001_initial_schema.sql
-- Project: WedMoments - Wedding & Event Live Photo Aggregator
-- Compatible with: PostgreSQL 14+, Supabase, Neon
-- ====================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- --------------------------------------------------------------------
-- 1. ENUM TYPES
-- --------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE photo_status AS ENUM ('pending', 'approved', 'rejected', 'featured');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE canvas_size_type AS ENUM ('A2', 'A3', 'A4', 'TABLE_CARD', 'SQUARE_BANNER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE frame_style_type AS ENUM ('minimal_gold', 'floral_vintage', 'modern_clean', 'boho_arch');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- --------------------------------------------------------------------
-- 2. TABLE: events
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(100) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    host_name VARCHAR(150) NOT NULL,
    host_email VARCHAR(255) NOT NULL,
    event_date TIMESTAMPTZ NOT NULL,
    venue_name VARCHAR(255),
    cover_image_url TEXT,
    theme_palette VARCHAR(50) DEFAULT 'champagne_gold',
    welcome_message TEXT DEFAULT 'Welcome to our special day! Scan, snap, and share your favorite moments with us.',
    is_moderation_enabled BOOLEAN DEFAULT FALSE,
    is_disposable_mode BOOLEAN DEFAULT FALSE,
    reveal_at TIMESTAMPTZ,
    max_photos_per_guest INT DEFAULT 50,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_event_date ON events(event_date);

-- --------------------------------------------------------------------
-- 3. TABLE: guests
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    avatar_url TEXT,
    table_number VARCHAR(50),
    device_fingerprint VARCHAR(255),
    is_vip BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guests_event_id ON guests(event_id);
CREATE INDEX IF NOT EXISTS idx_guests_created_at ON guests(created_at);

-- --------------------------------------------------------------------
-- 4. TABLE: scavenger_quests
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scavenger_quests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    icon_name VARCHAR(50) DEFAULT 'camera',
    points INT DEFAULT 10,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quests_event_id ON scavenger_quests(event_id);

-- --------------------------------------------------------------------
-- 5. TABLE: photos
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    quest_id UUID REFERENCES scavenger_quests(id) ON DELETE SET NULL,
    storage_path TEXT NOT NULL,
    thumbnail_url TEXT,
    full_url TEXT NOT NULL,
    caption TEXT,
    status photo_status DEFAULT 'approved',
    is_locked BOOLEAN DEFAULT FALSE,
    filter_applied VARCHAR(50) DEFAULT 'original',
    likes_count INT DEFAULT 0,
    comments_count INT DEFAULT 0,
    width INT,
    height INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_photos_event_id ON photos(event_id);
CREATE INDEX IF NOT EXISTS idx_photos_guest_id ON photos(guest_id);
CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status);
CREATE INDEX IF NOT EXISTS idx_photos_event_status_created ON photos(event_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_quest_id ON photos(quest_id);

-- --------------------------------------------------------------------
-- 6. TABLE: photo_likes
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photo_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    photo_id UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_photo_guest_like UNIQUE (photo_id, guest_id)
);

CREATE INDEX IF NOT EXISTS idx_photo_likes_photo ON photo_likes(photo_id);

-- --------------------------------------------------------------------
-- 7. TABLE: photo_comments
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photo_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    photo_id UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    comment_text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_photo_comments_photo ON photo_comments(photo_id, created_at ASC);

-- --------------------------------------------------------------------
-- 8. TABLE: guest_quest_completions
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guest_quest_completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quest_id UUID NOT NULL REFERENCES scavenger_quests(id) ON DELETE CASCADE,
    guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    photo_id UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_guest_quest_completion UNIQUE (quest_id, guest_id)
);

CREATE INDEX IF NOT EXISTS idx_quest_completions_guest ON guest_quest_completions(guest_id);

-- --------------------------------------------------------------------
-- 9. TABLE: audio_guestbook
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audio_guestbook (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    audio_url TEXT NOT NULL,
    duration_seconds INT NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audio_guestbook_event ON audio_guestbook(event_id, created_at DESC);

-- --------------------------------------------------------------------
-- 10. TABLE: qr_canvas_configs
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qr_canvas_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    canvas_size canvas_size_type DEFAULT 'A2',
    frame_style frame_style_type DEFAULT 'minimal_gold',
    headline VARCHAR(255) DEFAULT 'Capture the Love',
    subtext TEXT DEFAULT 'Scan the QR code with your phone camera to share your photos and messages to our live wedding gallery.',
    accent_color VARCHAR(50) DEFAULT '#D4AF37',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qr_canvas_event ON qr_canvas_configs(event_id);

-- --------------------------------------------------------------------
-- 11. HELPER TRIGGERS (Automatic counts & timestamps)
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER trg_events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_qr_canvas_updated_at
    BEFORE UPDATE ON qr_canvas_configs
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();

-- Update photo likes_count automatically
CREATE OR REPLACE FUNCTION update_photo_likes_count()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        UPDATE photos SET likes_count = likes_count + 1 WHERE id = NEW.photo_id;
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE photos SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.photo_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_photo_likes_count
    AFTER INSERT OR DELETE ON photo_likes
    FOR EACH ROW
    EXECUTE PROCEDURE update_photo_likes_count();

-- Update photo comments_count automatically
CREATE OR REPLACE FUNCTION update_photo_comments_count()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        UPDATE photos SET comments_count = comments_count + 1 WHERE id = NEW.photo_id;
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE photos SET comments_count = GREATEST(0, comments_count - 1) WHERE id = OLD.photo_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_photo_comments_count
    AFTER INSERT OR DELETE ON photo_comments
    FOR EACH ROW
    EXECUTE PROCEDURE update_photo_comments_count();
