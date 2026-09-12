import { BackendPlanTier } from '../middleware/tierGate';
import { FREE_TIER_MAX_PHOTOS } from '../../shared/planCaps';

/**
 * Server-side plan allowances.
 *
 * These are the numbers the pricing page sells, expressed where they can
 * actually be enforced. The client has its own copy for display
 * (`src/config/plans.ts`); this one is the authority.
 */
export interface PlanLimits {
  /** Hard storage ceiling in bytes. */
  storageBytes: number;
  /** Maximum photos, or null for unlimited. */
  maxPhotos: number | null;
  /**
   * How long the album is kept after the celebration, in days.
   * null keeps it indefinitely (Pro Planner, billed monthly).
   */
  retentionDays: number | null;
  /** Storage is pooled across all of a host's events rather than per event. */
  pooled: boolean;
}

const GB = 1024 * 1024 * 1024;

export const PLAN_LIMITS: Record<BackendPlanTier, PlanLimits> = {
  free: {
    storageBytes: 0.5 * GB,
    maxPhotos: FREE_TIER_MAX_PHOTOS,
    retentionDays: 7,
    pooled: false,
  },
  celebration_pass: {
    storageBytes: 10 * GB,
    maxPhotos: null,
    retentionDays: 90,
    pooled: false,
  },
  deluxe_keepsake: {
    storageBytes: 25 * GB,
    maxPhotos: null,
    retentionDays: 365,
    pooled: false,
  },
  pro_planner: {
    // Pooled across up to 10 concurrent weddings.
    storageBytes: 100 * GB,
    maxPhotos: null,
    retentionDays: null,
    pooled: true,
  },
};

export function limitsFor(tier: BackendPlanTier): PlanLimits {
  return PLAN_LIMITS[tier] || PLAN_LIMITS.free;
}

/** Human-readable size for error messages and dashboards. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
