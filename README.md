# 💍 WedMoments — Live Wedding Photo Aggregator & Guestbook Platform

> **Всеки сватбен миг, уловен от очите на вашите гости.**
> Гостите сканират QR код от масата или входа, снимат в реално време с романтични ретро филтри, изпълняват фото предизвикателства (мисии), оставят гласови аудио пожелания и виждат кадрите си прожектирани на живо на ТВ екран в ресторанта. Без инсталиране на приложения.

---

## 🌟 Ключови възможности (Key Features)

1. **Без инсталиране на приложения (Zero-Friction Mobile Web App)**:
   - 0 сваляния от App Store/Google Play и 0 пароли за гостите.
   - Вградена камера с 5 романтични филтъра (*Golden Glow*, *Vintage Warmth*, *B&W Noir*, *Film Grain*, *Original*).
   - Клиентска компресия за мигновено показване в галерията; оригиналът се качва паралелно и се пази за архива.
   - Сървърът генерира отделни thumbnail изображения (400px), така че лентата на галерията не тегли пълните кадри.
   - Офлайн буфер: Снимките се пазят в опашка на телефона и се качват автоматично при възстановяване на връзката.

2. **Прожекция на живо на ТВ екран (`/e/:slug/tv`)**:
   - Пълноекранно слайдшоу с плавна Ken-Burns анимация (изключва се автоматично при `prefers-reduced-motion`).
   - Постоянен плаващ QR код в ъгъла за новопристигнали гости.
   - Интерактивни анимирани реакции на живо — гостите натискат емоджи в галерията и то изплува на големия екран.

3. **Сватбени фото мисии & лов (Scavenger Quests)**:
   - Забавни предизвикателства за гостите (*"Първата целувка"*, *"Луди танци на дансинга"*, *"Празничен тост с шампанско"*).
   - Точкова система, значки за изпълнение и напредък за гостите.

4. **Ретро аудио книга за гости (Vintage Audio Guestbook)**:
   - Запис на гласови тостове, спомени и брачни съвети директно през микрофона на телефона с аудио визуализация.

5. **QR Canvas Print Studio (Печат на плакати и табели)**:
   - Интерактивен дизайнер за **A2/A3 плакати за стативи** и **A5/A6 табелки за масите на гостите**.
   - Експорт в **PDF с точни физически размери (mm)** и **PNG при 300 dpi**, готови за печатница.

6. **Студио за младоженци и организатори (Host & Planner Studio)**:
   - Панел за модерация в реално време (Одобрение / Скриване / Изпращане на екран).
   - Сваляне на пълен ZIP архив с **оригиналните файлове** (несвитата снимка, както е излязла от телефона или фотоапарата).
   - Многосъбитийно табло за сватбени агенти, фотографи и координатори.

7. **Модерна начална страница (Landing Home Page)**:
   - 8-секционна конвертираща страница на главния адрес (`/`).
   - Лента с демонстрационни сватби на живо за социално доказателство (*Social Proof Multi-Wedding Showcase*).
   - Прозрачни ценови планове в Евро (**€**) с контрол на достъпа (*Tier Gating*).

---

## 💶 Ценови планове (SaaS Pricing in Euro)

- **Безплатен старт (`0 €`)**: До 50 снимки, мобилно заснемане чрез QR, галерия на живо (7 дни архив).
- **Celebration Pass (`49 €` еднократно)**: Неограничени снимки, Live TV екран, фото мисии, QR студио за печат, 3 месеца архив, High-Res ZIP.
- **VIP Пакет "Луксозен спомен" (`89 €` еднократно)**: Всичко в Celebration Pass + Ретро аудио книга за гости, Еднократна камера с нощно разкриване, 1 година архив, 20% отстъпка за фотокнига.
- **Pro Planner (`49 €/мес.` абонамент)**: За сватбени агенти и диджеи — до 10 активни сватби едновременно, White-label, многосъбитийно табло.

---

## 🚀 Бърз старт (Quick Start)

### Стартиране чрез Docker Compose (Production-ready)

```bash
docker compose up --build -d
```

- **Приложение (Уеб & API & WebSockets)**: [http://localhost:6501](http://localhost:6501)
- **PostgreSQL 16 база данни**: `localhost:6532` (`wedmoments_db`)

### Стартиране в режим за разработка (Development Mode)

```bash
# 1. Инсталиране на зависимостите
npm install

# 2. Стартиране на базата данни (Docker)
docker compose up -d db

# 3. Прилагане на схемата на базата данни
npm run migrate

# 4. Стартиране на бекенд сървъра (Port 6501)
npm run server

# 5. Стартиране на Vite фронтенда (Port 6500)
npm run dev
```

### ⚠️ Камера и микрофон изискват HTTPS

Браузърите позволяват достъп до камера и микрофон **само** през `https://` или
`http://localhost`. Ако гостите сканират QR код към `http://192.168.x.x:6500`,
камерата няма да се отвори на техните телефони.

```bash
npm run build          # порт 6501 сервира и SPA-то
npm run server
node start-tunnel.cjs  # дава публичен https:// адрес
```

Насочете QR кодовете към отпечатания `https://` адрес.
Подробности: [docs/HTTPS_AND_PERMISSIONS.md](docs/HTTPS_AND_PERMISSIONS.md).

---

## 🧪 Тестове & Валидация (Test Suite)

```bash
npm run lint         # ESLint (src, server, shared, tests)
npm run typecheck    # tsc over src, server + shared, and tests
npm run test         # unit specs + full-stack E2E (needs PostgreSQL)
npm run test:unit    # Vitest only
npm run test:coverage
```

> Стартирайте базата преди тестовете: `docker compose up -d db`.
> Подробности: [docs/TEST_SPEC_COVERAGE.md](docs/TEST_SPEC_COVERAGE.md).

---

## 📁 Структура на проекта (Project Structure)

```
Wedding_album/
├── docker-compose.yml           # PostgreSQL 16 + Unified Fullstack Container
├── Dockerfile                   # Multi-stage production build (Node 22 + Alpine)
├── package.json                 # React 18, Vite, Tailwind CSS, Lucide React, Vitest
├── database/migrations/         # Forward-only SQL migrations (npm run migrate)
├── shared/                      # Code shared by client and server (slug generation)
├── server/                      # Express 5 REST API & WebSockets Server
│   ├── routes/                  # Auth, Events, Photos, Guests, Quests, Audio, Ingest
│   ├── middleware/              # JWT Auth, Zod Validation, UUID guards, Rate Limit, Tier Gate
│   ├── lib/                     # DB pool, migrations, storage adapters, image derivatives
│   └── ws/                      # Event-scoped real-time WebSocket rooms
├── src/
│   ├── api/                     # Typed API Client layer
│   ├── components/
│   │   ├── home/                # LandingHomePage, PublicWeddingsShowcase
│   │   ├── layout/              # Navbar, WeddingHero, BottomNav
│   │   ├── camera/              # CameraCaptureModal (live filters & compression)
│   │   ├── gallery/             # LiveFeed, PhotoCard, LightboxModal
│   │   ├── quests/              # ScavengerHunt challenges
│   │   ├── audio/               # AudioGuestbook
│   │   ├── host/                # HostDashboard, HostEventsList, PricingPlansModal, QRCanvasStudio
│   │   └── projector/           # LiveProjectorScreen (TV presentation mode)
│   ├── config/                  # SaaS plans, tier gating rules, themes, env
│   ├── i18n/                    # Native Bulgarian & multilingual dictionaries
│   ├── router/                  # SPA Hash & Path router
│   ├── services/                # AuthService, StorageService, OfflineQueue, PDFPrint
│   └── utils/                   # EU Date formatting (DD.MM.YYYY), transliteration
├── docs/                        # Complete technical and architectural documentation
└── STORAGE_AND_FINANCIAL_PLAN.md # Detailed Storage Architecture, Unit Economics & DSLR Blueprint
```

---

## 📚 Допълнителна документация (Further Documentation)

- 📊 **[Storage, Unit Economics & Financial Plan](STORAGE_AND_FINANCIAL_PLAN.md)**: Детайлен анализ на разходите за Cloudflare R2, маржове на печалба (98%+), интеграция за фотографи и B2B модел за сватбени агенции.
- 🏛️ **[Системна архитектура (docs/ARCHITECTURE.md)](docs/ARCHITECTURE.md)**: Структура на слоевете, WebSockets протокол и компонентен дизайн.
- 📡 **[API Справочник (docs/API_REFERENCE.md)](docs/API_REFERENCE.md)**: Пълен списък с REST endpoints и примерни заявки.
- 🖨️ **[Ръководство за печат на QR плакати (docs/QR_PRINT_GUIDE.md)](docs/QR_PRINT_GUIDE.md)**: Спецификации за A2/A3 стативи и табели за масите.
- 🔐 **[HTTPS, камера и микрофон (docs/HTTPS_AND_PERMISSIONS.md)](docs/HTTPS_AND_PERMISSIONS.md)**: Защо камерата не работи по HTTP и как да пуснете тунел.
- 🛠️ **[Операции и поддръжка (docs/OPERATIONS.md)](docs/OPERATIONS.md)**: Планираните sweep задачи (retention, grace), почистване на осиротели файлове, тестови данни и конфигурацията, която спира стартирането при грешка.
- 📈 **[Бенчмарк за капацитет G2 (docs/G2_CAPACITY_BENCHMARK_RUNBOOK.md)](docs/G2_CAPACITY_BENCHMARK_RUNBOOK.md)**: Как се измерва колко едновременни гости издържа един инстанс срещу реален R2.

