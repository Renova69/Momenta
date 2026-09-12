-- Two new decorative QR-poster frame styles, alongside the existing four.
-- ALTER TYPE ... ADD VALUE cannot run inside the same transaction as a
-- statement that uses the new value, but this migration only adds the
-- values — nothing in this file references them yet — so it is safe to run
-- inside this runner's normal transaction wrapper.
ALTER TYPE frame_style_type ADD VALUE IF NOT EXISTS 'double_border';
ALTER TYPE frame_style_type ADD VALUE IF NOT EXISTS 'art_deco';
