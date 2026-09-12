import { describe, it, expect } from 'vitest';
import { PLANS, PlanTier } from '../../src/config/plans';
import { THEMES } from '../../src/config/themes';
import { CONFIG } from '../../server/lib/config';

describe('Config & Pricing Plans Spec', () => {
  it('defines all required SaaS plan tiers and pricing', () => {
    const tiers: PlanTier[] = ['free', 'celebration_pass', 'deluxe_keepsake', 'pro_planner'];
    for (const tier of tiers) {
      expect(PLANS[tier]).toBeDefined();
      expect(PLANS[tier].name).toBeDefined();
      expect(PLANS[tier].maxPhotos).toBeDefined();
      expect(PLANS[tier].price).toBeDefined();
    }
  });

  it('defines aesthetic wedding themes and color palettes', () => {
    const themeKeys = Object.keys(THEMES) as (keyof typeof THEMES)[];
    expect(themeKeys.length).toBeGreaterThanOrEqual(4);
    for (const key of themeKeys) {
      const theme = THEMES[key];
      expect(theme.name).toBeDefined();
      expect(theme.accent).toMatch(/^#/);
    }
  });

  it('server CONFIG provides valid defaults and environment overrides', () => {
    expect(CONFIG.PORT).toBeDefined();
    expect(CONFIG.JWT_SECRET.length).toBeGreaterThanOrEqual(16);
    expect(CONFIG.MAX_UPLOAD_SIZE_MB).toBeGreaterThan(0);
  });
});
