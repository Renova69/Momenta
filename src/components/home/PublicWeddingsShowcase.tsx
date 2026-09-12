import React, { useEffect, useState } from 'react';
import { eventsApi } from '../../api/eventsApi';
import { formatEuDate } from '../../utils/date';
import { i18n } from '../../i18n';
import {
  Sparkles,
  Calendar,
  MapPin,
  Camera,
  Heart,
  Tv,
  PlusCircle,
  Crown,
  Users
} from 'lucide-react';

interface ShowcaseWedding {
  id: string;
  slug: string;
  title: string;
  hostName: string;
  eventDate: string;
  venueName: string;
  coverImageUrl: string;
  photosCount: number;
  guestsCount: number;
  previewPhotos: {
    id: string;
    thumbnailUrl: string;
    fullUrl: string;
    caption: string;
  }[];
}

const FALLBACK_SHOWCASE_WEDDINGS: ShowcaseWedding[] = [
  {
    id: 'showcase-1',
    slug: 'monika-and-alexander-2026',
    title: 'Сватбата на Моника и Александър',
    hostName: 'Моника и Александър',
    eventDate: '2026-09-18',
    venueName: 'Резиденция Бояна, София',
    coverImageUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80',
    photosCount: 54,
    guestsCount: 88,
    previewPhotos: [
      {
        id: 'p1',
        thumbnailUrl: 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=1200&q=80',
        caption: 'Вече сме семейство! Най-вълнуващата церемония!',
      },
      {
        id: 'p2',
        thumbnailUrl: 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=1200&q=80',
        caption: 'За цял живот изпълнен с любов и смях! Наздраве!',
      },
      {
        id: 'p3',
        thumbnailUrl: 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=1200&q=80',
        caption: 'Дансингът официално е открит!',
      },
    ],
  },
  {
    id: 'showcase-2',
    slug: 'elena-and-dimitar-2026',
    title: 'Сватбата на Елена и Димитър',
    hostName: 'Елена и Димитър',
    eventDate: '2026-07-24',
    venueName: 'Вила Екатерина, Вакарел',
    coverImageUrl: 'https://images.unsplash.com/photo-1583939003579-730e3918a45a?auto=format&fit=crop&w=1200&q=80',
    photosCount: 42,
    guestsCount: 65,
    previewPhotos: [
      {
        id: 'p4',
        thumbnailUrl: 'https://images.unsplash.com/photo-1532712938310-34cb3982ef74?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1532712938310-34cb3982ef74?auto=format&fit=crop&w=1200&q=80',
        caption: 'Романтика под залеза във вилата',
      },
      {
        id: 'p5',
        thumbnailUrl: 'https://images.unsplash.com/photo-1520854221256-17451cc331bf?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1520854221256-17451cc331bf?auto=format&fit=crop&w=1200&q=80',
        caption: 'Първият танц на младоженците',
      },
      {
        id: 'p6',
        thumbnailUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80',
        caption: 'Вдигаме тост за младото семейство!',
      },
    ],
  },
  {
    id: 'showcase-3',
    slug: 'viktoriya-and-kristiyan-2026',
    title: 'Сватбата на Виктория и Кристиян',
    hostName: 'Виктория и Кристиян',
    eventDate: '2026-08-15',
    venueName: 'Гранд Хотел Милениум, София',
    coverImageUrl: 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=1200&q=80',
    photosCount: 89,
    guestsCount: 110,
    previewPhotos: [
      {
        id: 'p7',
        thumbnailUrl: 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=1200&q=80',
        caption: 'Неповторима атмосфера и много усмивки!',
      },
      {
        id: 'p8',
        thumbnailUrl: 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=1200&q=80',
        caption: 'Партито на годината!',
      },
      {
        id: 'p9',
        thumbnailUrl: 'https://images.unsplash.com/photo-1520854221256-17451cc331bf?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1520854221256-17451cc331bf?auto=format&fit=crop&w=1200&q=80',
        caption: 'Сватбената торта и празничната заря',
      },
    ],
  },
  {
    id: 'showcase-4',
    slug: 'desislava-and-kaloyan-2026',
    title: 'Сватбата на Десислава и Калоян',
    hostName: 'Десислава и Калоян',
    eventDate: '2026-06-05',
    venueName: 'Комплекс "Старосел", Хисаря',
    coverImageUrl: 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=1200&q=80',
    photosCount: 68,
    guestsCount: 92,
    previewPhotos: [
      {
        id: 'p10',
        thumbnailUrl: 'https://images.unsplash.com/photo-1583939003579-730e3918a45a?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1583939003579-730e3918a45a?auto=format&fit=crop&w=1200&q=80',
        caption: 'Традиционен ритуал с много настроение',
      },
      {
        id: 'p11',
        thumbnailUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80',
        caption: 'Оркестърът свири за младоженците!',
      },
      {
        id: 'p12',
        thumbnailUrl: 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=1200&q=80',
        caption: 'Прекрасни спомени сред природата',
      },
    ],
  },
  {
    id: 'showcase-5',
    slug: 'silviya-and-georgi-2026',
    title: 'Сватбата на Силвия и Георги',
    hostName: 'Силвия и Георги',
    eventDate: '2026-09-12',
    venueName: 'Голф Клуб "Света София", Равно поле',
    coverImageUrl: 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=1200&q=80',
    photosCount: 76,
    guestsCount: 95,
    previewPhotos: [
      {
        id: 'p13',
        thumbnailUrl: 'https://images.unsplash.com/photo-1532712938310-34cb3982ef74?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1532712938310-34cb3982ef74?auto=format&fit=crop&w=1200&q=80',
        caption: 'Вълшебен изнесен ритуал под арката',
      },
      {
        id: 'p14',
        thumbnailUrl: 'https://images.unsplash.com/photo-1520854221256-17451cc331bf?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1520854221256-17451cc331bf?auto=format&fit=crop&w=1200&q=80',
        caption: 'Булчинският букет лети!',
      },
      {
        id: 'p15',
        thumbnailUrl: 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=1200&q=80',
        caption: 'Незабравими емоции и топъл залез',
      },
    ],
  },
  {
    id: 'showcase-6',
    slug: 'gabriela-and-nikola-2026',
    title: 'Сватбата на Габриела и Никола',
    hostName: 'Габриела и Никола',
    eventDate: '2026-08-28',
    venueName: 'Замъкът "Влюбен във вятъра", Равадиново',
    coverImageUrl: 'https://images.unsplash.com/photo-1520854221256-17451cc331bf?auto=format&fit=crop&w=1200&q=80',
    photosCount: 94,
    guestsCount: 130,
    previewPhotos: [
      {
        id: 'p16',
        thumbnailUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80',
        caption: 'Истинска приказна сватба на брега на морето',
      },
      {
        id: 'p17',
        thumbnailUrl: 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=1200&q=80',
        caption: 'Празничен тост с шампанско и заря',
      },
      {
        id: 'p18',
        thumbnailUrl: 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=600&q=80',
        fullUrl: 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=1200&q=80',
        caption: 'Цяла нощ танци под звездите',
      },
    ],
  },
];

interface PublicWeddingsShowcaseProps {
  onSelectWedding: (slug: string) => void;
  onOpenCreateEvent: () => void;
  onOpenPricing: () => void;
}

export const PublicWeddingsShowcase: React.FC<PublicWeddingsShowcaseProps> = ({
  onSelectWedding,
  onOpenCreateEvent,
  onOpenPricing,
}) => {
  const [weddings, setWeddings] = useState<ShowcaseWedding[]>(FALLBACK_SHOWCASE_WEDDINGS);

  useEffect(() => {
    let isMounted = true;
    eventsApi.getShowcaseFeed()
      .then((data) => {
        if (isMounted && Array.isArray(data) && data.length > 0) {
          const mapped: ShowcaseWedding[] = data.map((ev, index) => {
            const raw = ev as unknown as Record<string, unknown>;
            const fallback = FALLBACK_SHOWCASE_WEDDINGS[index % FALLBACK_SHOWCASE_WEDDINGS.length];
            const rawPhotos = (raw.previewPhotos as Array<Record<string, unknown>>) || [];
            
            const previewPhotos = rawPhotos.length > 0
              ? rawPhotos.map((p, pIdx) => ({
                  id: String(p.id || `p-${pIdx}`),
                  thumbnailUrl: String(p.thumbnail_url || p.thumbnailUrl || p.full_url || p.fullUrl || fallback.previewPhotos[0].thumbnailUrl),
                  fullUrl: String(p.full_url || p.fullUrl || fallback.previewPhotos[0].fullUrl),
                  caption: String(p.caption || i18n.t('showcase.default_caption')),
                }))
              : fallback.previewPhotos;

            return {
              id: String(ev.id || fallback.id),
              slug: String(ev.slug || fallback.slug),
              title: String(ev.title || fallback.title),
              hostName: String(ev.hostName || (raw.host_name as string) || fallback.hostName),
              eventDate: String(ev.eventDate || (raw.event_date as string) || fallback.eventDate),
              venueName: String(ev.venueName || (raw.venue_name as string) || fallback.venueName),
              coverImageUrl: String(ev.coverImageUrl || (raw.cover_image_url as string) || fallback.coverImageUrl),
              photosCount: Number(raw.photos_count || raw.photosCount || fallback.photosCount),
              guestsCount: Number(raw.guests_count || raw.guestsCount || fallback.guestsCount),
              previewPhotos,
            };
          });

          setWeddings(mapped);
        }
      })
      .catch((err) => {
        console.warn('Failed to load live showcase feed, using default showcases:', err);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <section className="space-y-6 sm:space-y-8 animate-fade-in my-2">
      {/* Section Header */}
      <div className="text-center max-w-3xl mx-auto space-y-2.5 px-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gold-400/10 border border-gold-400/30 text-gold-300 text-xs font-semibold">
          <Sparkles className="w-3.5 h-3.5 text-gold-400" />
          <span>{i18n.t('showcase.badge')}</span>
        </div>
        <h2 className="font-serif text-2xl sm:text-4xl font-bold text-cream-100 leading-tight">
          {i18n.t('showcase.title')}
        </h2>
        <p className="text-xs sm:text-sm text-cream-300/80 max-w-2xl mx-auto">
          {i18n.t('showcase.subtitle')}
        </p>
      </div>

      {/* Wedding Showcase Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
        {weddings.map((wedding) => (
          <div
            key={wedding.id}
            onClick={() => onSelectWedding(wedding.slug)}
            className="group relative bg-noir-800/90 rounded-2xl sm:rounded-3xl border border-cream-400/15 hover:border-gold-400/50 shadow-polaroid hover:shadow-glow transition-all duration-300 overflow-hidden flex flex-col cursor-pointer"
          >
            {/* Wedding Cover & Header */}
            <div className="relative h-44 sm:h-48 w-full overflow-hidden bg-noir-950">
              <img
                src={wedding.coverImageUrl}
                alt={wedding.title}
                loading="lazy"
                className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-700"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-noir-900 via-noir-900/40 to-transparent" />

              {/* Status Badge */}
              <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-noir-900/80 backdrop-blur-md border border-gold-400/40 text-gold-300 text-[10px] font-bold uppercase tracking-wider">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>{i18n.t('showcase.active_album')}</span>
              </div>

              {/* Photos & Guests count */}
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-xs text-cream-200">
                <div className="flex items-center gap-1.5 bg-noir-950/70 backdrop-blur-sm px-2.5 py-1 rounded-lg border border-cream-400/10">
                  <Camera className="w-3.5 h-3.5 text-gold-400" />
                  <span className="font-semibold">{i18n.t('showcase.photos_count', { n: wedding.photosCount })}</span>
                </div>
                <div className="flex items-center gap-1.5 bg-noir-950/70 backdrop-blur-sm px-2.5 py-1 rounded-lg border border-cream-400/10">
                  <Users className="w-3.5 h-3.5 text-gold-400" />
                  <span className="font-semibold">{i18n.t('showcase.guests_count', { n: wedding.guestsCount })}</span>
                </div>
              </div>
            </div>

            {/* Wedding Info Body */}
            <div className="p-4 sm:p-5 flex-1 flex flex-col justify-between space-y-4">
              <div>
                <h3 className="font-serif text-base sm:text-lg font-bold text-cream-100 group-hover:text-gold-300 transition-colors line-clamp-1">
                  {wedding.title}
                </h3>
                
                <div className="mt-2 space-y-1 text-xs text-cream-400/80">
                  <div className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-gold-400/80 shrink-0" />
                    <span className="truncate">{wedding.venueName}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-gold-400/80 shrink-0" />
                    <span>{formatEuDate(wedding.eventDate)}</span>
                  </div>
                </div>
              </div>

              {/* Photo Previews Ribbon */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-cream-400/70 mb-2 flex items-center gap-1">
                  <Heart className="w-3 h-3 text-gold-400 fill-gold-400/30" />
                  <span>{i18n.t('showcase.event_shots')}</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {wedding.previewPhotos.slice(0, 3).map((photo) => (
                    <div
                      key={photo.id}
                      className="aspect-square rounded-xl overflow-hidden bg-noir-950 border border-cream-400/10 group-hover:border-gold-400/30 transition-colors relative"
                    >
                      <img
                        src={photo.thumbnailUrl}
                        alt={photo.caption}
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Social Proof & Host Invitation Banner */}
      <div className="relative rounded-3xl bg-gradient-to-r from-noir-850 via-noir-800 to-noir-850 border border-gold-400/30 p-6 sm:p-8 overflow-hidden shadow-2xl">
        <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-6 text-center md:text-left">
          <div className="space-y-2 max-w-xl">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-gold-400/20 text-gold-300 text-xs font-semibold">
              <Crown className="w-3.5 h-3.5 text-gold-400" />
              <span>{i18n.t('showcase.start_free')}</span>
            </div>
            <h3 className="font-serif text-xl sm:text-2xl font-bold text-cream-100">
              {i18n.t('showcase.cta_title')}
            </h3>
            <p className="text-xs sm:text-sm text-cream-300/80">
              {i18n.t('showcase.cta_subtitle')}
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-3 shrink-0">
            <button
              onClick={onOpenCreateEvent}
              className="w-full sm:w-auto px-6 py-3.5 rounded-2xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-xs sm:text-sm shadow-glow hover:brightness-110 active:scale-98 transition-all flex items-center justify-center gap-2"
            >
              <PlusCircle className="w-4 h-4" />
              <span>{i18n.t('showcase.create_album_button')}</span>
            </button>

            <button
              onClick={onOpenPricing}
              className="w-full sm:w-auto px-5 py-3.5 rounded-2xl bg-noir-800 hover:bg-noir-700 border border-cream-400/20 text-cream-200 font-semibold text-xs sm:text-sm transition-all flex items-center justify-center gap-2"
            >
              <Tv className="w-4 h-4 text-gold-400" />
              <span>{i18n.t('showcase.view_pricing_button')}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
