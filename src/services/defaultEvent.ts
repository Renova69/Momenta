import { WeddingEvent } from '../types';

/**
 * The unconditional default event shape — used whenever no real event is
 * cached yet (a fresh visitor, before any slug resolves).
 *
 * Deliberately its own module, exporting nothing else (OPEN_ITEMS.md G7).
 * `mockData.ts`'s demo-only arrays (INITIAL_GUESTS, INITIAL_PHOTOS, ...) are
 * meant to ship only via a dynamic `import()` gated on demo mode, but as long
 * as anything needing this default event statically imported it *from
 * mockData.ts*, Rollup could not split that dynamic import into its own
 * chunk — the whole module, fixtures included, ended up in the main bundle
 * regardless of demo mode. Isolating this constant here means nothing that
 * needs it also has to statically drag in the rest.
 */
export const INITIAL_EVENT: WeddingEvent = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  slug: 'monika-and-alexander-2026',
  title: 'Сватбата на Моника и Александър',
  hostName: 'Моника и Александър',
  hostEmail: 'monika.alexander@wedmoments.bg',
  eventDate: '2026-09-18T16:30:00.000Z',
  venueName: 'Резиденция Бояна, София',
  coverImageUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1600&q=80',
  themePalette: 'champagne_gold',
  welcomeMessage: 'Добре дошли на нашия сватбен ден! Сканирайте QR кода, снимайте весели и неподправени моменти и ни помогнете да запечатаме всеки миг заедно.',
  isModerationEnabled: false,
  isDisposableMode: false,
  isPublic: false,
  revealAt: null,
  maxPhotosPerGuest: 50,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-25T12:00:00.000Z',
};
