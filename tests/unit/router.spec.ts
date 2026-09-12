import { describe, it, expect, vi } from 'vitest';
import { AppRouter } from '../../src/router';

describe('Client Router Spec', () => {
  const router = new AppRouter();

  it('parses root / path to guest feed', () => {
    const r = router.parseUrl('/');
    expect(r.view).toBe('guest');
    expect(r.subTab).toBe('feed');
    expect(r.slug).toBeUndefined();
  });

  it('parses /e/:slug to guest view', () => {
    const r = router.parseUrl('/e/maria-alex-2026');
    expect(r.view).toBe('guest');
    expect(r.slug).toBe('maria-alex-2026');
    expect(r.subTab).toBe('feed');
  });

  it('parses /e/:slug/quests and /e/:slug/audio subtabs', () => {
    const rQuests = router.parseUrl('/e/maria-alex-2026/quests');
    expect(rQuests.view).toBe('guest');
    expect(rQuests.subTab).toBe('quests');

    const rAudio = router.parseUrl('/e/maria-alex-2026/audio');
    expect(rAudio.view).toBe('guest');
    expect(rAudio.subTab).toBe('audio');
  });

  it('parses /e/:slug/tv and /e/:slug/projector to projector screen', () => {
    const r = router.parseUrl('/e/maria-alex-2026/tv');
    expect(r.view).toBe('projector');
    expect(r.slug).toBe('maria-alex-2026');

    const rProj = router.parseUrl('/e/maria-alex-2026/projector');
    expect(rProj.view).toBe('projector');
    expect(rProj.slug).toBe('maria-alex-2026');
  });

  it('parses host and pricing routes with event query parameters', () => {
    const rHost = router.parseUrl('/host?event=maria-alex-2026');
    expect(rHost.view).toBe('host');
    expect(rHost.slug).toBe('maria-alex-2026');

    const rDash = router.parseUrl('/dashboard?event=maria-alex-2026');
    expect(rDash.view).toBe('host');

    const rPricing = router.parseUrl('/pricing?event=maria-alex-2026');
    expect(rPricing.view).toBe('pricing');
    expect(rPricing.slug).toBe('maria-alex-2026');

    const rPricingBare = router.parseUrl('/pricing');
    expect(rPricingBare.view).toBe('pricing');
    expect(rPricingBare.slug).toBeUndefined();
  });

  it('handles legacy ?event=slug query format and unknown paths', () => {
    const r = router.parseUrl('/?event=legacy-slug&view=guest');
    expect(r.view).toBe('guest');
    expect(r.slug).toBe('legacy-slug');

    const unknown = router.parseUrl('/unknown-random-route');
    expect(unknown.view).toBe('host');
  });

  it('navigates to all route combinations and updates window history', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');

    router.navigate('projector', 'event-proj');
    expect(pushSpy).toHaveBeenCalledWith({}, '', '/e/event-proj/tv');

    router.navigate('guest', 'event-q', 'quests');
    expect(pushSpy).toHaveBeenCalledWith({}, '', '/e/event-q/quests');

    router.navigate('guest', 'event-a', 'audio');
    expect(pushSpy).toHaveBeenCalledWith({}, '', '/e/event-a/audio');

    router.navigate('guest', 'event-g');
    expect(pushSpy).toHaveBeenCalledWith({}, '', '/e/event-g');

    router.navigate('host');
    expect(pushSpy).toHaveBeenCalledWith({}, '', '/host');

    router.navigate('pricing');
    expect(pushSpy).toHaveBeenCalledWith({}, '', '/pricing');
  });

  it('uses replaceState instead of pushState when options.replace is true (FE-07)', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');

    // A live-typing preview (the host slug field, say) calling this on every
    // keystroke must not push a new history entry each time.
    router.navigate('host', 'typed-slug', undefined, { replace: true });

    expect(replaceSpy).toHaveBeenCalledWith({}, '', '/host?event=typed-slug');
    expect(pushSpy).not.toHaveBeenCalledWith({}, '', '/host?event=typed-slug');
  });

  it('still uses pushState by default (no options), unaffected by the replace option', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');

    router.navigate('host', 'normal-nav');

    expect(pushSpy).toHaveBeenCalledWith({}, '', '/host?event=normal-nav');
  });

  it('notifies subscribers on navigate and allows unsubscription', () => {
    const listener = vi.fn();
    const unsub = router.subscribe(listener);

    router.navigate('host', 'event-1');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ view: 'host', slug: 'event-1' }));

    router.navigate('pricing', 'event-1');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ view: 'pricing', slug: 'event-1' }));

    unsub();
    router.navigate('guest', 'event-2');
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ slug: 'event-2' }));
  });
});
