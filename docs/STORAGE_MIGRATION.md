# 📦 Storage: Local Disk ↔ Cloudflare R2

`server/lib/storage.ts` already ships both storage providers behind one
`StorageAdapter` interface — there is no code to write here. Switching from
local disk to Cloudflare R2 is a **configuration change**, not an
implementation task. For the R2 dashboard walkthrough (creating the bucket,
generating API credentials, enabling public access), see
`docs/CLOUDFLARE_R2_SETUP_GUIDE.md`.

---

## 1. The `StorageAdapter` interface

```typescript
export interface StorageAdapter {
  save(buffer: Buffer, filename: string, mimetype?: string, eventId?: string): Promise<{ publicUrl: string; storagePath: string }>;
  delete(storagePath: string): Promise<void>;
  getAbsolutePath(storagePath: string): string | null;
  getStream(storagePath: string): Promise<Readable | null>;
  /** Optional — local-disk only. Best-effort cleanup after a retention purge (G4). */
  removeEventDirectory?(eventId: string): Promise<void>;
}
```

`getStream()` backs the ZIP export path (`GET /api/events/:id/export-zip`) —
both adapters implement it, so export streams straight from whichever
backend is active without the route knowing which one that is.

## 2. `createStorageAdapter()` chooses the provider

```typescript
export function createStorageAdapter(): StorageAdapter {
  if (CONFIG.STORAGE_PROVIDER === 'r2' && CONFIG.R2_ACCOUNT_ID && CONFIG.R2_ACCESS_KEY_ID) {
    return new R2StorageAdapter();
  }
  return new LocalStorageAdapter();
}
```

`STORAGE_PROVIDER` is validated in `server/lib/config.ts` at startup: any
value other than `local` or `r2`, or `r2` with any of `R2_ACCOUNT_ID` /
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` missing, **crashes the process
immediately** (OPEN_ITEMS.md G6) rather than silently falling back to local
disk. That fallback used to be the failure mode that lost every photo on the
next redeploy of an ephemeral production container — refusing to start is
the fix.

## 3. What each adapter actually does

- **`LocalStorageAdapter`** — writes under `UPLOADS_DIR/events/<eventId>/`,
  containing every path strictly inside the uploads root (blocks traversal),
  and confirms a delete target is a real file, not a directory, before
  unlinking (SEC-M6).
- **`R2StorageAdapter`** — partitions objects under an `events/<eventId>/`
  key prefix the same way, using the AWS S3 SDK against R2's S3-compatible
  endpoint. `getStream()` distinguishes a genuine `NoSuchKey`/404 (returns
  `null`, "no such file") from any other failure — network error, bad
  credentials, a 5xx — which it re-throws instead of treating identically
  (MED-06); before that fix, a real R2 outage during a ZIP export looked
  exactly like a missing photo and was silently skipped.

Both adapters are covered by `tests/unit/storageAdapter.spec.ts`.

## 4. Switching a running deployment to R2

1. Follow `docs/CLOUDFLARE_R2_SETUP_GUIDE.md` to create the bucket and API
   token.
2. Set in `.env` (or your platform's environment variables):
   ```env
   STORAGE_PROVIDER=r2
   R2_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET_NAME=wedmoments-photos
   R2_PUBLIC_URL=https://pub-....r2.dev
   ```
3. Restart the server. Existing rows pointing at local `/uploads/...` paths
   are **not** migrated automatically — this only changes where *new*
   uploads land. Migrating already-stored files is a manual, one-time copy
   (walk `UPLOADS_DIR`, `PutObjectCommand` each file to R2, update the
   corresponding `storage_path`/`original_storage_path`/`thumbnail_url`
   columns) that this repository does not ship a script for.

There is no Supabase Storage adapter. Supabase is usable here only as a
Postgres *database* host (any standard connection string works) — not as a
file store; a Supabase Storage adapter would need to be written from
scratch, following the same interface above.
