import { describe, it, expect, afterAll } from 'vitest';
import { PLANS } from '../../src/config/plans';
import { FEATURE_GATES } from '../../src/config/tierGating';
import { PlanTier } from '../../src/types';
import { i18n } from '../../src/i18n';

/**
 * N-53 — the pricing page sold custom colour palettes as a Deluxe Keepsake
 * feature, while the gate on both the client and the server unlocks them at
 * Celebration Pass. A Celebration Pass buyer was not told they had them, and
 * a Deluxe buyer was sold something the cheaper plan already included.
 *
 * Read from the English copy rather than from a key, so the test checks what
 * a customer actually reads on the card.
 */
describe('the pricing copy and the gates agree (N-53)', () => {
  afterAll(() => i18n.setLanguage('bg'));

  function plansAdvertising(pattern: RegExp): PlanTier[] {
    i18n.setLanguage('en');
    return (Object.keys(PLANS) as PlanTier[]).filter((tier) =>
      PLANS[tier].features.some((key) => pattern.test(i18n.t(key)))
    );
  }

  it('lists custom palettes on the card of the plan that unlocks them', () => {
    expect(plansAdvertising(/palette/i)).toEqual([FEATURE_GATES.custom_themes.minimumTier]);
  });
});
