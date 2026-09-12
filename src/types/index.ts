export type PhotoStatus = 'pending' | 'approved' | 'rejected' | 'featured';

export type CanvasSize = 'A2' | 'A3' | 'A4' | 'TABLE_CARD' | 'SQUARE_BANNER';

export type FrameStyle = 'minimal_gold' | 'floral_vintage' | 'modern_clean' | 'boho_arch' | 'double_border' | 'art_deco';

export type ThemePalette = 'champagne_gold' | 'rose_blush' | 'sage_green' | 'classic_noir';

export type PhotoFilter = 'original' | 'vintage_warmth' | 'golden_glow' | 'black_white' | 'film_grain';

export type PhotoReactionKind = 'heart' | 'clap' | 'cheers' | 'laugh' | 'party';

export interface PhotoReaction {
  reaction: PhotoReactionKind;
  guestId: string;
}

export type PlanTier = 'free' | 'celebration_pass' | 'deluxe_keepsake' | 'pro_planner';

export interface HostUser {
  id: string;
  email: string;
  fullName: string;
  role: 'couple' | 'planner' | 'venue' | 'photographer';
  companyName?: string;
  avatarUrl?: string;
  createdAt: string;
}

export interface Subscription {
  id: string;
  userId: string;
  tier: PlanTier;
  status: 'active' | 'canceled' | 'past_due';
  billingType: 'one_time' | 'monthly' | 'annual';
  amountPaidCents: number;
  currency: string;
  eventLimit: number;
  storageLimitGb: number;
  expiresAt?: string;
  createdAt: string;
}

export interface WeddingEvent {
  id: string;
  slug: string;
  title: string;
  hostName: string;
  hostEmail: string;
  hostUserId?: string;
  planTier?: PlanTier;
  eventDate: string; // ISO string
  venueName: string;
  coverImageUrl: string;
  themePalette: ThemePalette;
  welcomeMessage: string;
  isModerationEnabled: boolean;
  isDisposableMode: boolean;
  /** Host opt-in to the public showcase (H6). Defaults false; never set on their behalf. */
  isPublic: boolean;
  revealAt: string | null;
  maxPhotosPerGuest: number;
  createdAt: string;
  updatedAt: string;
}

export interface Guest {
  id: string;
  eventId: string;
  name: string;
  avatarUrl?: string;
  tableNumber?: string;
  isVip?: boolean;
  createdAt: string;
  /** Proves this browser is this guest — sent with every like/comment/quest/upload. */
  guestToken?: string;
}

export interface PhotoComment {
  id: string;
  photoId: string;
  guestId: string;
  guestName: string;
  commentText: string;
  createdAt: string;
}

export interface Photo {
  id: string;
  eventId: string;
  guestId: string;
  guestName: string;
  guestAvatar?: string;
  guestTable?: string;
  questId?: string;
  questTitle?: string;
  storagePath: string;
  thumbnailUrl: string;
  fullUrl: string;
  /** Untouched upload kept for the high-resolution export. Null for photos captured before migration 007. */
  originalUrl?: string | null;
  caption?: string;
  status: PhotoStatus;
  isLocked?: boolean;
  filterApplied: PhotoFilter;
  likesCount: number;
  commentsCount: number;
  comments?: PhotoComment[];
  likedByGuestIds?: string[];
  reactions?: PhotoReaction[];
  createdAt: string;
  localId?: string;
  source?: 'guest' | 'photographer';
  priority?: number;
  photographerName?: string;
}

export interface ScavengerQuest {
  id: string;
  eventId: string;
  title: string;
  description: string;
  iconName: string;
  points: number;
  isActive: boolean;
  completedByGuestIds: string[];
}

export interface AudioGuestbookEntry {
  id: string;
  eventId: string;
  guestId: string;
  guestName: string;
  guestAvatar?: string;
  audioUrl: string;
  durationSeconds: number;
  note?: string;
  createdAt: string;
}

export type QRCenterIcon = 'heart' | 'rings' | 'camera' | 'sparkle' | 'none';

export interface QRCanvasConfig {
  id: string;
  eventId: string;
  canvasSize: CanvasSize;
  frameStyle: FrameStyle;
  headline: string;
  subtext: string;
  accentColor: string;
  centerIcon: QRCenterIcon;
}

export type ActiveView = 'guest' | 'host' | 'projector' | 'pricing' | 'events_list' | 'ingest';
export type GuestTab = 'feed' | 'quests' | 'audio';
