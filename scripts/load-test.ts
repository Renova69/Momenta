/**
 * Upload load test.
 *
 *   npm run loadtest -- --concurrency 20 --uploads 200
 *
 * Answers the question the financial plan hand-waves: weddings cluster on
 * Saturday evenings, so the sizing constraint is not the monthly average but how
 * many guests can upload *at once*. Every guest upload decodes a JPEG and runs
 * three sharp operations, which is CPU-bound — so this measures throughput and
 * latency against a real server and a real database, then extrapolates how many
 * simultaneous receptions one instance can carry.
 *
 * It writes real photos to storage. Point it at a disposable environment, and
 * let it clean up (it deletes the event it created, which cascades).
 */
import { performance } from 'perf_hooks';
import sharp from 'sharp';
import { pool } from '../server/lib/db';
import { CONFIG } from '../server/lib/config';
import { purgeEventMedia } from '../server/lib/retention';

interface Options {
  baseUrl: string;
  concurrency: number;
  uploads: number;
  wsClients: number;
  devices: number;
  megapixels: number;
  keep: boolean;
}

function parseArgs(): Options {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };

  return {
    baseUrl: arg('url', process.env.LOADTEST_URL || 'http://localhost:6501').replace(/\/+$/, ''),
    concurrency: parseInt(arg('concurrency', '10'), 10),
    uploads: parseInt(arg('uploads', '100'), 10),
    wsClients: parseInt(arg('ws-clients', '0'), 10),
    // A burst at a wedding comes from many different phones, not one. Default to
    // a device per upload so the per-device rate limit does not skew the run.
    devices: parseInt(arg('devices', '0'), 10),
    megapixels: parseFloat(arg('megapixels', '12')),
    keep: process.argv.includes('--keep'),
  };
}

/**
 * Build a photo that compresses like a real one.
 *
 * A flat colour compresses to almost nothing and would flatter the results; pure
 * noise compresses worse than reality. Structured noise over a gradient lands in
 * the right ballpark, and the actual byte size is reported so the numbers stay
 * honest.
 */
async function makePhoto(megapixels: number): Promise<{ original: Buffer; display: Buffer }> {
  const width = Math.round(Math.sqrt((megapixels * 1_000_000 * 4) / 3));
  const height = Math.round((width * 3) / 4);

  const pixels = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    const t = (i / pixels.length) * 255;
    pixels[i] = (t + Math.random() * 90) & 0xff;
    pixels[i + 1] = (200 - t * 0.4 + Math.random() * 90) & 0xff;
    pixels[i + 2] = (120 + Math.random() * 90) & 0xff;
  }

  const original = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();

  // What the client sends as the display copy after its own compression pass.
  const display = await sharp(original)
    .resize(1600, 1600, { fit: 'inside' })
    .jpeg({ quality: 85 })
    .toBuffer();

  return { original, display };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

async function setUp(opts: Options) {
  const email = `loadtest-${Date.now()}@test.local`;
  const res = await fetch(`${opts.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Load Test Host', password: 'Password123!' }),
  });

  if (!res.ok) {
    throw new Error(`Could not register a load-test host (HTTP ${res.status}). Is the server up?`);
  }

  const data = (await res.json()) as {
    user: { id: string };
    event: { id: string };
  };

  // Pro Planner so the plan's storage allowance does not cut the run short.
  await pool.query("UPDATE subscriptions SET tier = 'pro_planner' WHERE user_id = $1", [
    data.user.id,
  ]);

  return { eventId: data.event.id as string, userId: data.user.id as string };
}

interface Sample {
  ms: number;
  ok: boolean;
  status: number;
}

async function run() {
  const opts = parseArgs();

  console.log('\nWedMoments upload load test');
  console.log('-'.repeat(64));
  console.log(`target        ${opts.baseUrl}`);
  console.log(`uploads       ${opts.uploads}`);
  console.log(`concurrency   ${opts.concurrency}`);
  console.log(`photo size    ${opts.megapixels} MP`);
  console.log(`devices       ${opts.devices > 0 ? opts.devices : 'one per upload'}`);

  const { original, display } = await makePhoto(opts.megapixels);
  const originalUrl = `data:image/jpeg;base64,${original.toString('base64')}`;
  const fullUrl = `data:image/jpeg;base64,${display.toString('base64')}`;
  const payloadBytes = original.length + display.length;

  console.log(
    `payload       ${fmtBytes(original.length)} original + ${fmtBytes(display.length)} display ` +
      `= ${fmtBytes(payloadBytes)} per upload`
  );

  const { eventId, userId } = await setUp(opts);
  console.log(`event         ${eventId}\n`);

  // Build the body so the varying fields sit in a short head and the two
  // multi-megabyte data URLs sit in a constant tail.
  //
  // The previous version serialised once but then ran two .replace() calls over
  // the whole 12 MB string per request, allocating roughly 36 MB each time. The
  // generator was still the busiest thing on the box, and run-to-run variance
  // (+/-30%) swamped the difference between concurrency levels. Now the tail is
  // encoded to bytes once and each request costs one small stringify plus a
  // single copy.
  const bodyTail = Buffer.from(
    JSON.stringify({ eventId, fullUrl, originalUrl }).slice(1), // drop the leading '{'
    'utf8'
  );

  const buildBody = (deviceId: number, index: number): Buffer => {
    const head = JSON.stringify({
      guestName: `Guest ${deviceId}`,
      deviceFingerprint: `loadtest-${deviceId}`,
      caption: `load ${index}`,
    });
    // head ends with '}' - swap it for ',' and glue the constant tail on.
    return Buffer.concat([Buffer.from(head.slice(0, -1) + ',', 'utf8'), bodyTail]);
  };

  const samples: Sample[] = [];
  let issued = 0;

  const worker = async () => {
    // `for (;;)` rather than `while (true)`: same loop, and the idiom ESLint
    // accepts for a deliberate infinite loop with an internal exit.
    for (;;) {
      const mine = issued++;
      if (mine >= opts.uploads) return;

      // One phone per upload unless --devices narrows it deliberately.
      const deviceId = opts.devices > 0 ? mine % opts.devices : mine;

      const started = performance.now();
      try {
        const res = await fetch(`${opts.baseUrl}/api/photos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody(deviceId, mine),
        });
        samples.push({ ms: performance.now() - started, ok: res.ok, status: res.status });
        if (!res.ok) await res.text();
      } catch {
        samples.push({ ms: performance.now() - started, ok: false, status: 0 });
      }

      if (samples.length % 25 === 0) {
        process.stdout.write(`  ${samples.length}/${opts.uploads} uploaded\r`);
      }
    }
  };

  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, opts.uploads) }, () => worker())
  );
  const elapsedMs = performance.now() - startedAt;

  const ok = samples.filter((s) => s.ok);
  const failed = samples.filter((s) => !s.ok);
  const latencies = ok.map((s) => s.ms).sort((a, b) => a - b);
  const throughput = (ok.length / elapsedMs) * 1000;

  console.log(' '.repeat(40) + '\r');
  console.log('Results');
  console.log('-'.repeat(64));
  console.log(`succeeded     ${ok.length} / ${samples.length}`);
  if (failed.length) {
    const byStatus = failed.reduce<Record<number, number>>((acc, f) => {
      acc[f.status] = (acc[f.status] || 0) + 1;
      return acc;
    }, {});
    console.log(`failed        ${failed.length}  ${JSON.stringify(byStatus)}`);
  }
  console.log(`wall time     ${fmtMs(elapsedMs)}`);
  console.log(`throughput    ${throughput.toFixed(2)} uploads/sec`);
  console.log(`data in       ${fmtBytes(ok.length * payloadBytes)}`);
  console.log();
  console.log(`latency p50   ${fmtMs(percentile(latencies, 50))}`);
  console.log(`latency p95   ${fmtMs(percentile(latencies, 95))}`);
  console.log(`latency p99   ${fmtMs(percentile(latencies, 99))}`);
  console.log(`latency max   ${fmtMs(latencies[latencies.length - 1] || 0)}`);

  const { rows } = await pool.query('SELECT storage_bytes FROM events WHERE id = $1', [eventId]);
  console.log(`\naccounted     ${fmtBytes(Number(rows[0]?.storage_bytes) || 0)} charged to the plan`);

  // ---- What this means for a Saturday ----
  // A guest uploads perhaps 15 photos across a five-hour reception, and they
  // cluster: assume a third of them land in the busiest hour.
  const photosPerGuest = 15;
  const guestsPerWedding = 80;
  const peakFraction = 1 / 3;
  const peakSeconds = 3600;
  const perWeddingPeakRate = (guestsPerWedding * photosPerGuest * peakFraction) / peakSeconds;
  const concurrentWeddings = throughput / perWeddingPeakRate;

  // Every upload writes the original plus two derivatives. On local disk that is
  // usually the binding constraint, not CPU or the database - so say so, rather
  // than letting the capacity line below get read as a limit of the application.
  const writeMBps = (throughput * payloadBytes * 1.07) / (1024 * 1024);
  console.log(
    `\nimplied write  ${writeMBps.toFixed(0)} MB/s sustained to ${CONFIG.STORAGE_PROVIDER} storage`
  );
  if (CONFIG.STORAGE_PROVIDER === 'local') {
    console.log(
      'note          local disk is normally the ceiling here, and on a Docker\n' +
        '              Desktop volume it drifts 25-50% between runs. Treat the\n' +
        '              throughput and capacity numbers as a floor for this machine,\n' +
        '              not as a property of the application. For a figure worth\n' +
        '              quoting, run against STORAGE_PROVIDER=r2 with the generator\n' +
        '              on a different host.'
    );
  }

  console.log('\nExtrapolation');
  console.log('-'.repeat(64));
  console.log(`assumes ${guestsPerWedding} guests x ${photosPerGuest} photos, a third inside the busiest hour`);
  console.log(`per wedding   ${perWeddingPeakRate.toFixed(2)} uploads/sec at peak`);
  console.log(
    `capacity      ~${Math.floor(concurrentWeddings)} simultaneous receptions on this machine ` +
      `at ${opts.concurrency} concurrent uploads`
  );

  if (!opts.keep) {
    // Storage first, then the row. Deleting the event cascades its photo rows,
    // and with them the only record of which files to remove - every earlier run
    // of this script leaked its uploads onto disk that way.
    const freed = await purgeEventMedia(eventId);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    console.log(`\ncleaned up the load-test event and host (freed ${fmtBytes(freed)}).`);
  } else {
    console.log(`\nkept event ${eventId} (--keep).`);
  }

  await pool.end();
}

run().catch(async (err) => {
  console.error('\nLoad test failed:', err instanceof Error ? err.message : err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
