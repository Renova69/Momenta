/**
 * Bounced addresses — the operator's side of migration 025.
 *
 *   npm run bounce:list                              what is currently blocking
 *   npm run bounce:list -- --all                     including cleared ones
 *   npm run bounce:record -- --email a@b.bg          record a hard bounce
 *   npm run bounce:record -- --email a@b.bg --soft   record a transient one
 *   npm run bounce:clear -- --email a@b.bg           the address works again
 *
 * This exists because bounce handling has two halves and only one of them can
 * be built without knowing the provider. The half that protects photographs —
 * a bounce disarms the album, and a blocked address can never re-arm it — is
 * provider-independent and lives in server/lib/emailBounces.ts. The half that
 * *learns* about bounces is a webhook whose payload shape, signature scheme and
 * event vocabulary belong to whichever provider is chosen.
 *
 * So until that choice is made, this is how a bounce gets in: read the
 * provider's dashboard, record what it says. Tedious at scale, entirely
 * adequate at the scale where nobody has picked a provider yet, and it means
 * the protection is real today rather than waiting on plumbing.
 *
 * Recording a hard bounce is not a neutral act — it makes every album owned by
 * that address permanently undeletable until someone clears it. That is the
 * safe direction, and it is stated plainly in the output rather than left to be
 * discovered.
 */
import { pool } from '../server/lib/db';
import { recordBounce, clearBounce, listBounces, normaliseEmail } from '../server/lib/emailBounces';

type Command = 'list' | 'record' | 'clear';

export interface Args {
  command: Command;
  email: string | null;
  kind: 'hard' | 'soft';
  detail: string | null;
  all: boolean;
}

/** Small enough to hand-roll, and worth having as a pure function to test. */
export function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | null => {
    const equals = argv.find((a) => a.startsWith(`${flag}=`));
    if (equals) return equals.slice(flag.length + 1).trim() || null;
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const next = argv[i + 1];
    // A flag with its value forgotten must not swallow the following flag.
    return next === undefined || next.startsWith('-') ? null : next.trim() || null;
  };

  const raw = argv.find((a) => !a.startsWith('-')) ?? 'list';
  const command: Command = raw === 'record' || raw === 'clear' ? raw : 'list';

  return {
    command,
    email: value('--email'),
    kind: argv.includes('--soft') ? 'soft' : 'hard',
    detail: value('--detail'),
    all: argv.includes('--all'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log('');

  if (args.command === 'list') {
    const rows = await listBounces(args.all);
    if (rows.length === 0) {
      console.log(args.all ? 'No bounces have ever been recorded.' : 'No addresses are currently blocked.');
      console.log('');
      return;
    }
    for (const row of rows) {
      const state = row.clearedAt ? `cleared ${row.clearedAt.slice(0, 10)}` : 'BLOCKING';
      console.log(
        `  ${row.email.padEnd(36).slice(0, 36)}  ${row.kind.padEnd(4)}  ` +
          `${row.bouncedAt.slice(0, 10)}  ${state.padEnd(18)}  ${row.source}`
      );
      if (row.detail) console.log(`      ${row.detail}`);
    }
    console.log('');
    const blocking = rows.filter((r) => !r.clearedAt && r.kind === 'hard').length;
    if (blocking > 0) {
      console.log(`${blocking} address(es) blocking. Albums owned by these cannot be notified,`);
      console.log('and therefore cannot be deleted, until the address is fixed or cleared.');
      console.log('');
    }
    return;
  }

  if (!args.email) {
    console.error(`bounce:${args.command} needs --email <address>`);
    process.exitCode = 1;
    return;
  }

  if (args.command === 'clear') {
    const cleared = await clearBounce(args.email);
    console.log(
      cleared
        ? `Cleared ${normaliseEmail(args.email)}. Its albums can be notified again on the next run.`
        : `${normaliseEmail(args.email)} had no active bounce — nothing to clear.`
    );
    console.log('');
    return;
  }

  const result = await recordBounce({
    email: args.email,
    kind: args.kind,
    detail: args.detail,
    source: 'manual',
  });

  console.log(`Recorded a ${result.kind} bounce for ${result.email}.`);
  if (result.kind === 'soft') {
    console.log('Soft bounces are transient, so this does not block anything — the next run retries.');
    console.log('');
    return;
  }

  console.log('');
  if (result.unarmedEventIds.length > 0) {
    // The reason this command exists. Say so explicitly, because it is the
    // difference between photographs surviving and not.
    console.log(
      `${result.unarmedEventIds.length} album(s) had been stamped as notified on the strength of`
    );
    console.log('a message that bounced. That stamp has been cleared, so they are no longer');
    console.log('eligible for deletion:');
    for (const id of result.unarmedEventIds) console.log(`    ${id}`);
    console.log('');
  }
  console.log('This address is now blocked. Its albums stay undeletable and will appear in');
  console.log('every retention report until someone corrects the address or clears the bounce.');
  console.log('');
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    console.error('[bounces] failed:', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
