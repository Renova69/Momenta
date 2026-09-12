import { ActiveView } from '../types';

export interface RouteState {
  view: ActiveView;
  slug?: string;
  subTab?: 'feed' | 'quests' | 'audio';
}

export class AppRouter {
  private listeners: Set<(route: RouteState) => void> = new Set();
  private currentRoute: RouteState = { view: 'guest' };

  constructor() {
    if (typeof window !== 'undefined') {
      this.currentRoute = this.parseCurrentUrl();
      window.addEventListener('popstate', () => {
        this.currentRoute = this.parseCurrentUrl();
        this.notify();
      });
    }
  }

  public parseUrl(url: string): RouteState {
    let pathname = url;
    let search = '';
    const qIndex = url.indexOf('?');
    if (qIndex !== -1) {
      pathname = url.substring(0, qIndex);
      search = url.substring(qIndex);
    }
    const searchParams = new URLSearchParams(search);
    const eventParam = searchParams.get('event');

    // 1. Path: /e/:slug/tv or /e/:slug/projector
    const tvMatch = pathname.match(/^\/e\/([a-zA-Z0-9_-]+)\/(tv|projector)/);
    if (tvMatch) {
      return { view: 'projector', slug: tvMatch[1] };
    }

    // 2. Path: /e/:slug/quests
    const questsMatch = pathname.match(/^\/e\/([a-zA-Z0-9_-]+)\/quests/);
    if (questsMatch) {
      return { view: 'guest', slug: questsMatch[1], subTab: 'quests' };
    }

    // 3. Path: /e/:slug/audio
    const audioMatch = pathname.match(/^\/e\/([a-zA-Z0-9_-]+)\/audio/);
    if (audioMatch) {
      return { view: 'guest', slug: audioMatch[1], subTab: 'audio' };
    }

    // 3b. Path: /e/:slug/ingest (VIP Photographer Ingest Portal)
    const ingestMatch = pathname.match(/^\/e\/([a-zA-Z0-9_-]+)\/ingest/);
    if (ingestMatch) {
      return { view: 'ingest', slug: ingestMatch[1] };
    }

    // 4. Path: /e/:slug
    const eventMatch = pathname.match(/^\/e\/([a-zA-Z0-9_-]+)/);
    if (eventMatch) {
      return { view: 'guest', slug: eventMatch[1], subTab: 'feed' };
    }

    // 5. Path: /host or /dashboard
    if (pathname.startsWith('/host') || pathname.startsWith('/dashboard')) {
      return { view: 'host', slug: eventParam || undefined };
    }

    // 6. Path: /pricing
    if (pathname.startsWith('/pricing')) {
      return { view: 'pricing', slug: eventParam || undefined };
    }

    // 7. Legacy query parameter fallback: /?event=slug
    if (eventParam) {
      const viewParam = searchParams.get('view') as ActiveView;
      return {
        view: viewParam || 'guest',
        slug: eventParam,
        subTab: 'feed',
      };
    }

    // 8. Root path defaults to guest view
    if (pathname === '/' || pathname === '') {
      return { view: 'guest', subTab: 'feed' };
    }

    return { view: 'host' };
  }

  public parseCurrentUrl(): RouteState {
    if (typeof window === 'undefined' || !window.location) return { view: 'guest', subTab: 'feed' };
    const fullUrl = (window.location.pathname || '/') + (window.location.search || '');
    return this.parseUrl(fullUrl);
  }

  public getRoute(): RouteState {
    return this.currentRoute;
  }

  public navigate(
    view: ActiveView,
    slug?: string,
    subTab?: 'feed' | 'quests' | 'audio',
    options?: { replace?: boolean }
  ) {
    this.currentRoute = { view, slug, subTab };

    if (typeof window !== 'undefined') {
      let targetPath = '/';
      if (slug) {
        if (view === 'projector') {
          targetPath = `/e/${slug}/tv`;
        } else if (subTab === 'quests') {
          targetPath = `/e/${slug}/quests`;
        } else if (subTab === 'audio') {
          targetPath = `/e/${slug}/audio`;
        } else if (view === 'guest') {
          targetPath = `/e/${slug}`;
        } else if (view === 'ingest') {
          targetPath = `/e/${slug}/ingest`;
        } else if (view === 'host') {
          targetPath = `/host?event=${slug}`;
        } else if (view === 'pricing') {
          targetPath = `/pricing?event=${slug}`;
        }
      } else {
        if (view === 'host') targetPath = '/host';
        else if (view === 'pricing') targetPath = '/pricing';
      }

      // FE-07: a live preview (the slug field, say) that calls this on every
      // keystroke must not push a new history entry each time - a handful of
      // keystrokes would otherwise take dozens of back-button taps to undo.
      if (options?.replace && window.history?.replaceState) {
        window.history.replaceState({}, '', targetPath);
      } else if (window.history?.pushState) {
        window.history.pushState({}, '', targetPath);
      }
    }

    this.notify();
  }

  public subscribe(listener: (route: RouteState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((fn) => fn(this.currentRoute));
  }
}

export const router = new AppRouter();

/**
 * Absolute URL of the host dashboard, for a round trip through an external
 * site that has to send the browser back here — Stripe Checkout, today.
 *
 * Deliberately NOT derived from `window.location.pathname`. The host opens the
 * pricing modal from wherever they happen to be, which is very often
 * `/e/:slug` — their own album's GUEST-facing view. Building the return URL
 * from that path meant paying for a plan dropped the host back on the guest
 * page, with no dashboard and no sign the purchase had worked. Where a host
 * belongs after checkout is a property of the app's routing, not of the page
 * they happened to click from, so it is built here alongside the route shapes
 * it has to match (see `navigate`'s `/host?event=` case).
 *
 * Absolute because Stripe rejects relative `success_url`/`cancel_url`, and the
 * origin must be one the server allows — see `isAllowedRedirect` in
 * server/routes/billing.ts, which pins it to CORS_ORIGIN/PUBLIC_BASE_URL.
 */
export function hostReturnUrl(slug?: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams();
  if (slug) search.set('event', slug);
  for (const [key, value] of Object.entries(params)) search.set(key, value);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const query = search.toString();
  return `${origin}/host${query ? `?${query}` : ''}`;
}
