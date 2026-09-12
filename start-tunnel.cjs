/**
 * WedMoments — HTTPS Tunnel Launcher
 * 
 * WHY THIS EXISTS:
 * Browsers block microphone + camera access on plain HTTP for any IP that 
 * isn't "localhost". Your guests scan QR codes on their phones → phone sees 
 * http://192.168.x.x → mic/camera get blocked. This script starts a free 
 * Cloudflare Tunnel (via cloudflared) that gives you a real https:// URL 
 * for all guests automatically.
 * 
 * SETUP (one time only):
 *   1. Download cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
 *      Or run: winget install Cloudflare.cloudflared
 *   2. Run this script: node start-tunnel.cjs
 *   3. Copy the https://xxx.trycloudflare.com URL and put it in your QR code
 * 
 * No account needed. Free. Works on all guests' phones immediately.
 * The URL changes every time you start a new tunnel (it's random).
 * For a permanent URL, create a free Cloudflare account.
 */

const { spawn } = require('child_process');

const PORT = process.env.PORT || 6501;

console.log('\n🎊 WedMoments — Starting HTTPS Tunnel\n');
console.log(`Tunneling to: http://localhost:${PORT}`);
console.log('---------------------------------------');
console.log('Waiting for tunnel URL...\n');

// Try cloudflared first (Cloudflare Tunnel — no account needed, free)
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});

let urlFound = false;

function extractUrl(data) {
  const text = data.toString();
  // Cloudflare outputs the URL to stderr
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !urlFound) {
    urlFound = true;
    const url = match[0];
    console.log('\n✅ HTTPS Tunnel Ready!\n');
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║                                                    ║');
    console.log(`║   🔗 Share this URL with guests:                   ║`);
    console.log(`║   ${url.padEnd(48)}  ║`);
    console.log('║                                                    ║');
    console.log('║   ✅ Microphone works on all phones               ║');
    console.log('║   ✅ Camera works on all phones                   ║');
    console.log('║   ✅ No "Not Secure" warnings                     ║');
    console.log('║                                                    ║');
    console.log('╚════════════════════════════════════════════════════╝\n');
    console.log('Update your QR Code URL to:', url);
    console.log('\n(Press Ctrl+C to stop the tunnel)\n');
  }
}

tunnel.stdout.on('data', extractUrl);
tunnel.stderr.on('data', extractUrl);

tunnel.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.log('❌ cloudflared not found. Trying ngrok...\n');
    tryNgrok();
  } else {
    console.error('Tunnel error:', err.message);
    process.exit(1);
  }
});

tunnel.on('close', (code) => {
  if (code !== 0 && !urlFound) {
    console.log('cloudflared failed. Trying ngrok...\n');
    tryNgrok();
  }
});

function tryNgrok() {
  const ngrok = spawn('ngrok', ['http', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  ngrok.stdout.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.ngrok[a-z.-]+/);
    if (match && !urlFound) {
      urlFound = true;
      console.log('\n✅ HTTPS Tunnel Ready (ngrok)!');
      console.log('Share this with guests:', match[0]);
    }
  });

  ngrok.stderr.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.ngrok[a-z.-]+/);
    if (match && !urlFound) {
      urlFound = true;
      console.log('\n✅ HTTPS Tunnel Ready (ngrok)!');
      console.log('Share this with guests:', match[0]);
    }
  });

  ngrok.on('error', () => {
    console.log('❌ Neither cloudflared nor ngrok found.\n');
    console.log('To install cloudflared (recommended):');
    console.log('  winget install Cloudflare.cloudflared');
    console.log('  -- or --');
    console.log('  Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n');
    console.log('To install ngrok:');
    console.log('  winget install Ngrok.Ngrok');
    console.log('  -- or --');
    console.log('  Download from: https://ngrok.com/download\n');
    process.exit(1);
  });
}

process.on('SIGINT', () => {
  console.log('\n\nTunnel stopped. Goodbye! 👋');
  process.exit(0);
});
