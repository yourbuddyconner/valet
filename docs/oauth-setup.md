# OAuth Setup

Authentication uses GitHub OAuth (primary) and optionally Google OAuth.

## GitHub OAuth (Required)

1. Go to [GitHub > Settings > Developer settings > OAuth Apps](https://github.com/settings/developers)
2. Create a new OAuth App:

   | Field | Dev | Production |
   |-------|-----|------------|
   | Homepage URL | `http://localhost:5173` | `https://your-domain.com` |
   | Callback URL | `http://localhost:8787/auth/github/callback` | `https://<your-worker>.workers.dev/auth/github/callback` |

3. Copy the **Client ID** and generate a **Client Secret**

Scopes requested: `repo read:user user:email` (needed for repo cloning and PR creation inside sandboxes).

## Google OAuth (Optional)

Google OAuth in Valet is handled by the Worker routes:
- `GET /auth/google`
- `GET /auth/google/callback`

The app currently requests these scopes:
- `openid`
- `email`
- `profile`

### 1. Configure OAuth Consent Screen

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select or create a Google Cloud project for Valet.
3. Go to `APIs & Services` -> `OAuth consent screen`.
4. Choose your user type:
   - `Internal` for Google Workspace org-only use.
   - `External` for non-Workspace/public users.
5. Fill required app info (app name, support email, developer contact email).
6. In `Scopes`, add:
   - `openid`
   - `email`
   - `profile`
7. If app type is `External` and publishing status is `Testing`, add test users who are allowed to sign in.

### 2. Create OAuth Client Credentials

1. Go to `APIs & Services` -> `Credentials`.
2. Click `Create Credentials` -> `OAuth client ID`.
3. Application type: `Web application`.
4. Add authorized redirect URIs:
   - Dev: `http://localhost:8787/auth/google/callback`
   - Production: `https://<your-worker>.workers.dev/auth/google/callback`
5. Save and copy:
   - `Client ID`
   - `Client Secret`

### 3. Set Worker Credentials

Local dev (`packages/worker/.dev.vars`):

```bash
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```

Production secrets:

```bash
cd packages/worker
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 4. Verify Locally

1. Start the worker (`make dev-worker` or `make dev-all`).
2. Visit `http://localhost:8787/auth/google`.
3. Complete Google sign-in and confirm redirect back through:
   - `http://localhost:8787/auth/google/callback`
   - then to frontend `/auth/callback?...&provider=google`

## Local Credentials

Create `packages/worker/.dev.vars`:

```
ENCRYPTION_KEY=any-string-at-least-32-characters-long
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GOOGLE_CLIENT_ID=your_google_client_id        # optional
GOOGLE_CLIENT_SECRET=your_google_client_secret  # optional
```

## Production Secrets

```bash
cd packages/worker
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put FRONTEND_URL
npx wrangler secret put GOOGLE_CLIENT_ID      # optional
npx wrangler secret put GOOGLE_CLIENT_SECRET  # optional
```
