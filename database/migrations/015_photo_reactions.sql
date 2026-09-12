-- Per-photo emoji reactions, alongside the existing single-purpose "like".
-- A guest can react to the same photo with several different emoji kinds
-- (heart, clap, cheers, laugh, party — the same vocabulary the ambient
-- event-level reaction already uses), each toggled independently, mirroring
-- how photo_likes works but keyed on (photo_id, guest_id, reaction) instead
-- of just (photo_id, guest_id).
CREATE TABLE IF NOT EXISTS photo_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    photo_id UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    reaction TEXT NOT NULL CHECK (reaction IN ('heart', 'clap', 'cheers', 'laugh', 'party')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_photo_guest_reaction UNIQUE (photo_id, guest_id, reaction)
);

CREATE INDEX IF NOT EXISTS idx_photo_reactions_photo ON photo_reactions(photo_id);
CREATE INDEX IF NOT EXISTS idx_photo_reactions_guest ON photo_reactions(guest_id);
