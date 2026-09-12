-- Migration 005: Performance Indexes, Foreign Key SET NULL, and Triggers

-- 1. Fix FK cascade on guest quest completions so deleting a photo does not delete the completion record
ALTER TABLE guest_quest_completions 
  DROP CONSTRAINT IF EXISTS guest_quest_completions_photo_id_fkey,
  ADD CONSTRAINT guest_quest_completions_photo_id_fkey 
    FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE SET NULL;

-- 2. Add missing index on events host_user_id (prevents full-table scans on host auth checks)
CREATE INDEX IF NOT EXISTS idx_events_host_user_id ON events(host_user_id);

-- 3. Add composite index for main photo feed pagination
CREATE INDEX IF NOT EXISTS idx_photos_event_created ON photos(event_id, created_at DESC);

-- 4. Add unique constraint on qr_canvas_configs(event_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_qr_canvas_event'
    ) THEN
        ALTER TABLE qr_canvas_configs ADD CONSTRAINT uq_qr_canvas_event UNIQUE (event_id);
    END IF;
EXCEPTION
    WHEN duplicate_table THEN null;
END $$;

-- 5. Add missing updated_at triggers for users & subscriptions
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at') THEN
        CREATE TRIGGER trg_users_updated_at
          BEFORE UPDATE ON users
          FOR EACH ROW
          EXECUTE PROCEDURE update_updated_at_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_subscriptions_updated_at') THEN
        CREATE TRIGGER trg_subscriptions_updated_at
          BEFORE UPDATE ON subscriptions
          FOR EACH ROW
          EXECUTE PROCEDURE update_updated_at_column();
    END IF;
END $$;
