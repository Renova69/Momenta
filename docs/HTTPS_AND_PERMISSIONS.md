# 🔐 HTTPS, Camera & Microphone Permissions

## The short version

**Camera and microphone do not work over `http://` on anything except
`localhost`.** If guests scan a QR code pointing at `http://192.168.0.35:6500`,
their phone will refuse to open the camera — not because permission was denied,
but because the API does not exist on that page at all.

Run a tunnel to get an `https://` URL:

```bash
node start-tunnel.cjs
```

---

## Why it happens

Browsers expose `navigator.mediaDevices.getUserMedia` only in a **secure
context**. A page qualifies when it is served from:

| Origin | Secure context? | Camera / mic |
| :--- | :---: | :---: |
| `https://anything` | ✅ | works |
| `http://localhost:6500` | ✅ | works |
| `http://127.0.0.1:6500` | ✅ | works |
| `http://192.168.0.35:6500` | ❌ | **blocked** |
| `http://your-laptop.local:6500` | ❌ | **blocked** |

This is why capture works when you test on your own laptop and fails on every
guest's phone: your laptop is on `localhost`, the phone is on a LAN IP.

Outside a secure context `navigator.mediaDevices` is `undefined`, so the failure
is a missing API rather than a denied permission. The app detects this
explicitly (`src/utils/mediaSupport.ts`) and tells the guest that an `https://`
address is required, instead of asking them to grant a permission that was never
requested.

Affected features:

- Camera capture (`CameraCaptureModal`)
- Audio guestbook recording (`AudioGuestbook`)
- Screen Wake Lock on the projector screen (degrades quietly)

---

## Development: Cloudflare Tunnel

`start-tunnel.cjs` wraps `cloudflared` and prints a public `https://` URL. No
account is needed and the tunnel is free; the URL is random and changes each
time you start it.

```bash
# once
winget install Cloudflare.cloudflared

# every session
npm run build          # the tunnelled port serves the built SPA
npm run server         # API + SPA + WebSockets on 6501
node start-tunnel.cjs  # prints https://<random>.trycloudflare.com
```

Point your QR codes at the printed URL. Camera, microphone and WebSockets all
work from it.

**Tunnel port 6501, not 6500.** Port 6501 serves the API, the WebSocket server
*and* the built SPA from `dist/`, so a single tunnel covers everything. Port 6500
is the Vite dev server, which has no API behind it.

### Why WebSockets survive the tunnel

`src/config/env.ts` derives the WebSocket origin from the page:

```ts
const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
```

An `https://` page therefore connects over `wss://` on the same origin. A
hardcoded `ws://host:6501` would be blocked as mixed content and realtime would
fail silently behind the tunnel.

### Alternatives

- **ngrok** — `start-tunnel.cjs` falls back to it if `cloudflared` is missing.
- **Chrome flag (desktop debugging only)** —
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
  `http://192.168.0.35:6500`. Does not help guests' phones.
- **Self-signed certificate** — works, but every guest sees a scary warning.
  Not viable at a real wedding.

---

## Production

Serve the app over HTTPS. Every documented deployment path already does:

- **Vercel** (SPA) — HTTPS by default.
- **Google Cloud Run** (API) — HTTPS by default.
- **Own domain / reverse proxy** — terminate TLS at the proxy and set
  `PUBLIC_BASE_URL=https://your-domain` so stored media URLs are absolute and
  correct.

Also set `CORS_ORIGIN` to the exact https origin, or leave it empty for a
same-origin deployment. `CORS_ORIGIN` also gates WebSocket upgrades
(`server/ws/wsServer.ts`), so a mismatch shows up as a working page with dead
realtime.

---

## Checklist when capture fails

1. Is the address `https://` or `localhost`? If not, that is the cause.
2. Does the app show the "secure connection required" message? Then it detected
   an insecure origin — no permission prompt was ever shown.
3. Did the guest previously deny permission? Android: site settings → Permissions
   → Camera → Allow. iOS Safari: Settings → Safari → Camera → Ask.
4. In-app browsers (Instagram, Facebook, Messenger) restrict `getUserMedia`.
   "Open in browser" usually fixes it.
5. Check `PUBLIC_BASE_URL` matches the address guests actually use, or uploaded
   photos will point at an unreachable host.
