# 🚀 WedMoments — Free-Tier Production Deployment Guide

This guide outlines how to deploy WedMoments 100% on free cloud tiers (Neon / Supabase, Google Cloud Run, Vercel, and Cloudflare R2).

---

## 1. Database Deployment (Neon / Supabase)

### Option A: Neon Serverless PostgreSQL (Recommended)
1. Sign up at [neon.tech](https://neon.tech) (Free tier includes 0.5 GB storage, serverless connection pooling).
2. Create a project named `wedmoments-prod`.
3. Copy your Pooled Connection String:
   `postgresql://username:password@ep-cool-pooler.us-east-2.aws.neon.tech/wedmoments_db?sslmode=require`
4. Apply the schema. The app ships a forward-only migration runner that records
   what it has applied in a `schema_migrations` table:

   ```bash
   DATABASE_URL="postgresql://..." npm run migrate
   ```

   The server also runs pending migrations on boot unless `AUTO_MIGRATE=false`,
   so a container that starts against an older database repairs itself instead
   of serving 500s. Migrations are idempotent, so an existing database created
   before the runner existed can be brought under it safely.

   Do not paste the SQL files into a console by hand — nothing records that they
   ran, which is exactly how a database ends up several migrations behind.

---

## 2. Backend Deployment (Google Cloud Run)

Google Cloud Run provides 2 Million free container requests per month, auto-scaling to zero when idle.

### Step 1: Build & Deploy Container
Using Google Cloud CLI (`gcloud`):
```bash
# 1. Authenticate with Google Cloud
gcloud auth login
gcloud config set project your-gcp-project-id

# 2. Build and deploy container directly from source
gcloud run deploy wedmoments-api \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars DATABASE_URL="postgresql://user:pass@ep-pooler.neon.tech/wedmoments_db?sslmode=require" \
  --set-env-vars JWT_SECRET="your-production-high-entropy-secret-key-32-chars" \
  --set-env-vars NODE_ENV="production"
```

Cloud Run will output your live HTTPS backend URL (e.g. `https://wedmoments-api-xyz-uc.a.run.app`).

---

## 3. Frontend Deployment (Vercel)

1. Push this repository to GitHub / GitLab.
2. Sign in to [vercel.com](https://vercel.com) and click **"Add New Project"**.
3. Import the `Wedding_album` repository.
4. Set Environment Variables:
   - `VITE_API_URL`: `https://wedmoments-api-xyz-uc.a.run.app`
   - `VITE_WS_URL`: `wss://wedmoments-api-xyz-uc.a.run.app`
5. Click **"Deploy"**.

Vercel automatically detects Vite and deploys your SPA to a global Edge Network with instant SSL.

> **Hobby plan is non-commercial only.** Vercel's Hobby tier terms restrict
> it to personal, non-commercial projects — it also caps at 1M function
> invocations and 100 GB data transfer per month, not "unlimited." This app
> charges guests real money (see `STORAGE_AND_FINANCIAL_PLAN.md`'s 49 €/89 €
> plans), so once you take a paying customer, host the frontend on a Pro
> seat ($20/mo) instead. Hobby is fine only for development or a private
> demo you never charge for.

---

## 4. Image Storage (Cloudflare R2)

To move image storage from local disk to Cloudflare R2 (10 GB free storage, **0 egress fees**):
1. Create a Bucket in Cloudflare R2 named `wedmoments-photos`.
2. Generate an R2 S3 API Token (Access Key ID & Secret Access Key).
3. Add Cloudflare credentials to your Cloud Run environment variables:
   - `STORAGE_PROVIDER=r2`
   - `R2_ACCESS_KEY_ID=...`
   - `R2_SECRET_ACCESS_KEY=...`
   - `R2_BUCKET_NAME=wedmoments-photos`
   - `R2_PUBLIC_URL=https://photos.wedmoments.app`

---

## 5. Summary of Free-Tier Limits & Capacities

| Component | Provider | Free Monthly Allocation | Estimated Capacity |
| :--- | :--- | :--- | :--- |
| **Frontend** | Vercel (Hobby) | 1M function invocations + 100 GB data transfer / month | ~100,000 guest visits |
| **Backend** | Google Cloud Run | 2,000,000 container requests | ~15 large weddings |
| **Database** | Neon Serverless | 0.5 GB storage + autoscaling compute | ~20,000 photo records |
| **Image Storage** | Cloudflare R2 | 10 GB storage, 0 egress fees | ~3,500 high-res photos |
