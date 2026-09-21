import { describe, it, expect } from 'vitest';
import { formatEuDate, formatTimeAgo } from '../../src/utils/date';
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

describe('formatEuDate', () => {
  it('formats a Date object, not only a string', () => {
    // Both are passed in: the event date arrives as an ISO string from the
    // server and as a Date from the picker.
    expect(formatEuDate(new Date('2026-09-18T16:30:00.000Z'))).toBe('18.09.2026');
  });

  it('passes an ISO date through in European order', () => {
    expect(formatEuDate('2026-09-18')).toBe('18.09.2026');
  });

  it('leaves a date already in European order alone', () => {
    expect(formatEuDate('18.09.2026')).toBe('18.09.2026');
  });

  it('hands back text it cannot read rather than blanking the field', () => {
    // A host typing into the date field sees their own half-typed input, not
    // an empty box that looks like it ate what they wrote.
    expect(formatEuDate('next Saturday')).toBe('next Saturday');
  });

  it('is empty for nothing at all', () => {
    expect(formatEuDate(null)).toBe('');
    expect(formatEuDate(undefined)).toBe('');
  });
});
