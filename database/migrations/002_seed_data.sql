-- ====================================================================
-- Migration: 002_seed_data.sql
-- Seed sample wedding data for demo and initial testing (Bulgarian Native)
-- ====================================================================

-- 1. Create a sample wedding event
INSERT INTO events (
    id,
    slug,
    title,
    host_name,
    host_email,
    event_date,
    venue_name,
    cover_image_url,
    theme_palette,
    welcome_message,
    is_moderation_enabled,
    is_disposable_mode,
    reveal_at,
    max_photos_per_guest
) VALUES (
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'monika-and-alexander-2026',
    'Сватбата на Моника и Александър',
    'Моника и Александър',
    'monika.alexander@wedmoments.bg',
    '2026-09-18 16:30:00+00',
    'Резиденция Бояна, София',
    'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1600&q=80',
    'champagne_gold',
    'Добре дошли на нашия сватбен ден! Сканирайте QR кода, снимайте весели и неподправени моменти и ни помогнете да запечатаме всеки миг заедно.',
    FALSE,
    FALSE,
    NULL,
    50
) ON CONFLICT (id) DO UPDATE SET
    slug = EXCLUDED.slug,
    title = EXCLUDED.title,
    host_name = EXCLUDED.host_name,
    host_email = EXCLUDED.host_email,
    venue_name = EXCLUDED.venue_name,
    welcome_message = EXCLUDED.welcome_message;

-- 2. Create Scavenger Quests
INSERT INTO scavenger_quests (id, event_id, title, description, icon_name, points) VALUES
    ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Първата целувка', 'Уловете магическия миг, когато младоженците си разменят първата целувка като съпруг и съпруга.', 'heart', 25),
    ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Луди танци на дансинга', 'Снимайте някой, който взривява дансинга с много страст и енергия.', 'music', 15),
    ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Сълзи от радост', 'Уловете емоционален и трогателен момент от речите на кумовете и родителите.', 'smile', 20),
    ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a04', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Селфи с Маса 7', 'Намерете някой седнал на Маса 7 и си направете весело общо селфи!', 'camera', 10),
    ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a05', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Празничен тост с шампанско', 'Снимайте звъна на чашите и искрящите усмивки по време на празничния тост!', 'wine', 15)
ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    description = EXCLUDED.description;

-- 3. Create Sample Guests
INSERT INTO guests (id, event_id, name, avatar_url, table_number, is_vip) VALUES
    ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Силвия Георгиева', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80', 'Маса 4', TRUE),
    ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Мартин Василев', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&q=80', 'Маса 2', FALSE),
    ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Елена и Димитър', 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=200&q=80', 'Маса 5', FALSE)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    table_number = EXCLUDED.table_number;

-- 4. Create Sample Photos
INSERT INTO photos (
    id, event_id, guest_id, quest_id, storage_path, full_url, thumbnail_url, caption, status, filter_applied, likes_count, comments_count
) VALUES
    (
        'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
        'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
        'events/a0eebc99/photo1.jpg',
        'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=600&q=80',
        'Най-красивата булка на света! Толкова се радваме за вас двамата! ✨💍',
        'featured',
        'vintage_warmth',
        24,
        2
    ),
    (
        'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
        'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a05',
        'events/a0eebc99/photo2.jpg',
        'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=600&q=80',
        'Наздраве за любовта, щастието и безбройните пътешествия заедно! 🥂',
        'approved',
        'original',
        18,
        1
    ),
    (
        'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
        'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
        'events/a0eebc99/photo3.jpg',
        'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=600&q=80',
        'Дансингът официално е взривен! 🔥🕺💃',
        'approved',
        'golden_glow',
        31,
        0
    )
ON CONFLICT (id) DO UPDATE SET
    caption = EXCLUDED.caption,
    filter_applied = EXCLUDED.filter_applied;

-- 5. Create Sample QR Canvas Config
INSERT INTO qr_canvas_configs (
    id, event_id, canvas_size, frame_style, headline, subtext, accent_color
) VALUES (
    'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'A2',
    'minimal_gold',
    'Запечатайте любовта',
    'Сканирайте QR кода с камерата на телефона си, за да споделите снимки и пожелания на живо на големия екран.',
    '#D4AF37'
) ON CONFLICT (id) DO UPDATE SET
    headline = EXCLUDED.headline,
    subtext = EXCLUDED.subtext;
