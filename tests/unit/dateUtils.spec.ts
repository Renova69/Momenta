import { describe, it, expect } from 'vitest';
import { formatTimeAgo } from '../../src/utils/date';
import { i18n } from '../../src/i18n';

/**
 * formatTimeAgo was extracted out of PhotoCard.tsx so LightboxModal's
 * comment list could use the same relative-time formatting instead of a
 * raw clock time — the "internal social media" feed pattern (a comment says
 * "2m ago", not "14:32").
 */
describe('formatTimeAgo', () => {
  it('reports "just now" for anything under a minute old', () => {
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatTimeAgo(thirtySecondsAgo)).toBe(i18n.t('feed.just_now'));
  });

  it('reports minutes for under an hour', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatTimeAgo(fiveMinutesAgo)).toBe(i18n.t('feed.mins_ago', { n: 5 }));
  });

  it('reports hours for under a day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(threeHoursAgo)).toBe(i18n.t('feed.hours_ago', { n: 3 }));
  });

  it('reports days beyond 24 hours', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(twoDaysAgo)).toBe(i18n.t('feed.days_ago', { n: 2 }));
  });

  it('returns an empty string for a missing or invalid date', () => {
    expect(formatTimeAgo(null)).toBe('');
    expect(formatTimeAgo('not-a-date')).toBe('');
  });
});
