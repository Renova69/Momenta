# ☁️ Cloudflare R2 Step-by-Step API Key & Setup Guide

This guide walks you through getting all 5 required values from your Cloudflare R2 dashboard.

---

## 📋 Overview of What You Need

You will collect 5 values and paste them into your `.env` file:

```ini
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=your_account_id_here
R2_ACCESS_KEY_ID=your_access_key_id_here
R2_SECRET_ACCESS_KEY=your_secret_access_key_here
R2_BUCKET_NAME=wedmoments-photos
R2_PUBLIC_URL=https://pub-yourbucketurl.r2.dev
```

---

## 🛠️ Step-by-Step Instructions

### Step 1: Log in to Cloudflare & Navigate to R2
1. Go to [https://dash.cloudflare.com/](https://dash.cloudflare.com/) and log in.
2. In the **left-hand sidebar**, click **Storage & Databases** ➔ **R2 Object Storage**.

---

### Step 2: Get your `R2_ACCOUNT_ID`
1. While on the **R2 Overview** page, look at the **right-hand sidebar**.
2. Under the section titled **Account ID**, click the copy icon.
3. Paste this into your `.env` file as `R2_ACCOUNT_ID`:
   ```ini
   R2_ACCOUNT_ID=abc1234567890def1234567890abcdef
   ```

---

### Step 3: Create an R2 Bucket (`R2_BUCKET_NAME`)
1. On the **R2** page, click the blue **"Create bucket"** button.
2. **Bucket name**: enter `wedmoments-photos` (or any name you prefer).
3. **Location**: select **Automatic** (or your closest region).
4. Click **"Create Bucket"**.
5. Put this name in your `.env`:
   ```ini
   R2_BUCKET_NAME=wedmoments-photos
   ```

---

### Step 4: Enable Public Access for the Bucket (`R2_PUBLIC_URL`)
*This allows guests to view and load photos via the live gallery without complex presigned URLs.*

1. Click on your newly created bucket (`wedmoments-photos`).
2. Click on the **"Settings"** tab at the top.
3. Scroll down to the **"Public access"** section.
4. Under **"R2.dev subdomain"**, click **"Allow Access"**.
   - A modal will pop up; type `allow` to confirm.
5. Cloudflare will give you a public URL (e.g. `https://pub-a1b2c3d4e5f6.r2.dev`).
6. Copy this URL and paste it in your `.env` as `R2_PUBLIC_URL`:
   ```ini
   R2_PUBLIC_URL=https://pub-a1b2c3d4e5f6.r2.dev
   ```
*(Optional: If you connect a custom domain like `photos.yourdomain.com`, you can use that as your `R2_PUBLIC_URL` instead).*

---

### Step 5: Generate API Token (`R2_ACCESS_KEY_ID` & `R2_SECRET_ACCESS_KEY`)
1. In the left-hand sidebar, go back to **Storage & Databases** ➔ **R2 Object Storage** (the main R2 page).
2. On the **right-hand sidebar**, click **"Manage R2 API Tokens"** (under Account Details).
3. Click the blue **"Create API token"** button in the top right.
4. Configure the token:
   - **Token name**: `WedMoments-Backend`
   - **Permissions**: Select **Admin Read & Write** (or *Object Read & Write*).
   - **Specify bucket(s)**: Select **Apply to specific buckets only** ➔ choose `wedmoments-photos`.
   - **TTL**: Leave as default (Permanent or set your expiration).
5. Click **"Create API Token"** at the bottom.
6. A screen will appear showing your credentials **(Save these immediately, they are only shown once!)**:
   - Copy **Access Key ID** ➔ paste as `R2_ACCESS_KEY_ID`.
   - Copy **Secret Access Key** ➔ paste as `R2_SECRET_ACCESS_KEY`.

---

## ⚡ Final `.env` Example

Your completed `.env` file should look like this:

```ini
PORT=6501
DATABASE_URL=postgresql://postgres:postgrespassword@127.0.0.1:6532/wedmoments_db
JWT_SECRET=wedmoments_jwt_super_secret_key_2026_change_in_prod
JWT_EXPIRES_IN=7d

# Switch from 'local' to 'r2'
STORAGE_PROVIDER=r2

R2_ACCOUNT_ID=abc1234567890def1234567890abcdef
R2_ACCESS_KEY_ID=1a2b3c4d5e6f7g8h9i0j
R2_SECRET_ACCESS_KEY=9z8y7x6w5v4u3t2s1r0qponmlkjihgfedcba
R2_BUCKET_NAME=wedmoments-photos
R2_PUBLIC_URL=https://pub-a1b2c3d4e5f6.r2.dev
```

Once you save `.env` and restart your backend (`npx tsx server.ts`), all newly uploaded wedding photos and audio recordings will stream straight to Cloudflare's global CDN!
