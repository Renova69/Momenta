-- ====================================================================
-- Migration: 006_pro_photographer_ingest.sql
-- Project: WedMoments — Professional Photographer Ingest
-- Adds photo provenance/priority columns and an event-scoped ingest
-- API-key table for the photographer upload pipeline.
-- ====================================================================

-- 1. Photo provenance & projector priority
ALTER TABLE photos ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'guest';
ALTER TABLE photos ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS photographer_name VARCHAR(150);

CREATE INDEX IF NOT EXISTS idx_photos_event_priority_created
  ON photos(event_id, priority DESC, created_at DESC);

-- 2. Event-scoped photographer ingest API keys (revocable, optionally expiring)
CREATE TABLE IF NOT EXISTS photographer_ingest_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    label VARCHAR(100) NOT NULL DEFAULT 'Photographer',
    key_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingest_keys_event ON photographer_ingest_keys(event_id);
CREATE INDEX IF NOT EXISTS idx_ingest_keys_hash ON photographer_ingest_keys(key_hash);
