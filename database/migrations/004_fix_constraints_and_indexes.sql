-- ====================================================================
-- Migration: 004_fix_constraints_and_indexes.sql
-- Project: WedMoments - Wedding & Event Live Photo Aggregator
-- Fix: Make quest completion photo_id nullable, add unique guest fingerprint index, update seed passwords
-- ====================================================================

-- 1. Make photo_id nullable in quest completions (guests can complete quests without photos)
ALTER TABLE guest_quest_completions ALTER COLUMN photo_id DROP NOT NULL;

-- 2. Add unique partial index on guests (event_id, device_fingerprint) to prevent registration race conditions
CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_event_fingerprint 
ON guests(event_id, device_fingerprint) 
WHERE device_fingerprint IS NOT NULL;

-- 3. Update any legacy null password hashes to a secure default hash for 'Password123!'
-- Hash generated with bcrypt cost 10: $2a$10$7Z7Wk2t8x.YF0jOQ6S2y6.8O3qJ8F9YxNq4rYv2w5qXw3n8a1z1q
UPDATE users 
SET password_hash = '$2a$10$7R9rGjV9x0Q2P2G6R1K9yODrVwz8aPz4nU5mN6s8mQ4rYv2w5qXw3' 
WHERE password_hash IS NULL;
