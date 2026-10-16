import { Guest, Photo, ScavengerQuest, AudioGuestbookEntry, QRCanvasConfig } from '../types';
import { INITIAL_EVENT } from './defaultEvent';

export const INITIAL_GUESTS: Guest[] = [
  {
    id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    eventId: INITIAL_EVENT.id,
    name: 'Силвия Георгиева',
    avatarUrl: '/demo/guest-1.jpg',
    tableNumber: 'Маса 4',
    isVip: true,
    createdAt: '2026-09-18T17:00:00.000Z',
  },
  {
    id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    eventId: INITIAL_EVENT.id,
    name: 'Мартин Василев',
    avatarUrl: '/demo/guest-2.jpg',
    tableNumber: 'Маса 2',
    isVip: false,
    createdAt: '2026-09-18T17:15:00.000Z',
  },
  {
    id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
    eventId: INITIAL_EVENT.id,
    name: 'Елена и Димитър',
    avatarUrl: '/demo/guest-5.jpg',
    tableNumber: 'Маса 5',
    isVip: false,
    createdAt: '2026-09-18T17:30:00.000Z',
  },
  {
    id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a04',
    eventId: INITIAL_EVENT.id,
    name: 'Чичо Иван',
    avatarUrl: '/demo/guest-3.jpg',
    tableNumber: 'Маса 1',
    isVip: true,
    createdAt: '2026-09-18T17:45:00.000Z',
  }
];

export const INITIAL_QUESTS: ScavengerQuest[] = [
  {
    id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    eventId: INITIAL_EVENT.id,
    title: 'Първата целувка',
    description: 'Уловете магическия миг, когато младоженците си разменят първата целувка като съпруг и съпруга.',
    iconName: 'heart',
    points: 25,
    isActive: true,
    completedByGuestIds: ['c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01'],
  },
  {
    id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    eventId: INITIAL_EVENT.id,
    title: 'Луди танци на дансинга',
    description: 'Снимайте някой, който взривява дансинга с много страст и енергия.',
    iconName: 'music',
    points: 15,
    isActive: true,
    completedByGuestIds: ['c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03'],
  },
  {
    id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
    eventId: INITIAL_EVENT.id,
    title: 'Сълзи от радост',
    description: 'Уловете емоционален и трогателен момент от речите на кумовете и родителите.',
    iconName: 'smile',
    points: 20,
    isActive: true,
    completedByGuestIds: [],
  },
  {
    id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a04',
    eventId: INITIAL_EVENT.id,
    title: 'Селфи с Маса 4',
    description: 'Намерете някой седнал на Маса 4 и си направете весело общо селфи!',
    iconName: 'camera',
    points: 10,
    isActive: true,
    completedByGuestIds: [],
  },
  {
    id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a05',
    eventId: INITIAL_EVENT.id,
    title: 'Празничен тост с шампанско',
    description: 'Снимайте звъна на чашите и искрящите усмивки по време на празничния тост!',
    iconName: 'wine',
    points: 15,
    isActive: true,
    completedByGuestIds: ['c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02'],
  },
];

export const INITIAL_PHOTOS: Photo[] = [
  {
    id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    eventId: INITIAL_EVENT.id,
    guestId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    guestName: 'Силвия Георгиева',
    guestAvatar: '/demo/guest-1.jpg',
    guestTable: 'Маса 4',
    storagePath: '/uploads/sample-1.jpg',
    thumbnailUrl: '/demo/wedding-2-1200.jpg',
    fullUrl: '/demo/wedding-2-1200.jpg',
    caption: 'Най-красивата булка на света! Толкова се радваме за вас двамата!',
    status: 'featured',
    isLocked: false,
    filterApplied: 'golden_glow',
    likesCount: 14,
    commentsCount: 2,
    likedByGuestIds: ['c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02', 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03'],
    comments: [
      {
        id: 'comm-1',
        photoId: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
        guestId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
        guestName: 'Мартин Василев',
        commentText: 'Истинска приказна магия! Роклята е зашеметяваща!',
        createdAt: '2026-09-18T17:15:00.000Z',
      }
    ],
    createdAt: '2026-09-18T17:05:00.000Z',
  },
  {
    id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    eventId: INITIAL_EVENT.id,
    guestId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
    guestName: 'Мартин Василев',
    guestAvatar: '/demo/guest-2.jpg',
    guestTable: 'Маса 2',
    storagePath: '/uploads/sample-2.jpg',
    thumbnailUrl: '/demo/wedding-4-1200.jpg',
    fullUrl: '/demo/wedding-4-1200.jpg',
    caption: 'Наздраве за любовта, щастието и безбройните пътешествия заедно!',
    status: 'approved',
    isLocked: false,
    filterApplied: 'vintage_warmth',
    likesCount: 8,
    commentsCount: 0,
    likedByGuestIds: ['c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01'],
    comments: [],
    createdAt: '2026-09-18T17:35:00.000Z',
  }
];

export const INITIAL_AUDIO_ENTRIES: AudioGuestbookEntry[] = [
  {
    id: 'aud-001',
    eventId: INITIAL_EVENT.id,
    guestId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a04',
    guestName: 'Чичо Иван',
    guestAvatar: '/demo/guest-3.jpg',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    durationSeconds: 24,
    note: 'Скъпи младоженци, винаги се смейте заедно и пазете искрата в сърцата си!',
    createdAt: '2026-09-18T17:50:00.000Z',
  },
  {
    id: 'aud-002',
    eventId: INITIAL_EVENT.id,
    guestId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
    guestName: 'Силвия Георгиева',
    guestAvatar: '/demo/guest-1.jpg',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    durationSeconds: 18,
    note: 'Обичаме ви безкрайно! Честито семейство!',
    createdAt: '2026-09-18T18:10:00.000Z',
  }
];

export const INITIAL_QR_CANVAS_CONFIG: QRCanvasConfig = {
  id: 'qr-canvas-001',
  eventId: INITIAL_EVENT.id,
  canvasSize: 'A2',
  frameStyle: 'minimal_gold',
  headline: 'Запечатайте любовта',
  subtext: 'Сканирайте QR кода с камерата на телефона си, за да споделите снимки и пожелания на живо на големия екран.',
  accentColor: '#D4AF37',
  centerIcon: 'heart',
};
