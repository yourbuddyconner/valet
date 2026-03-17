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

Google OAuth is used for two separate flows with different redirect URIs:

1. **Sign-in** — User login via `GET /auth/google` → callback to the **worker**
2. **Integration OAuth** — Connecting Google services (Drive, Gmail, Sheets, etc.) → callback to the **frontend**

The sign-in flow requests scopes: `openid`, `email`, `profile`.
Integration flows request service-specific scopes (e.g., `https://www.googleapis.com/auth/drive.readonly`).

Both flows use the **same** Google OAuth Client ID/Secret.

### 1. Enable Google APIs

Each Google integration requires its corresponding API to be enabled. Go to `APIs & Services` -> `Library` and enable:

- **Google Drive API** — required for Google Drive integration
- **Google Sheets API** — required for Google Sheets integration
- **Gmail API** — required for Gmail integration
- **Google Calendar API** — required for Google Calendar integration
- **Google Docs API** — required for Google Docs integration

Google returns a misleading `redirect_uri_mismatch` error if the requested scope's API is not enabled, even when the redirect URI is correctly configured.

### 2. Configure OAuth Consent Screen

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
   - Any Google API scopes needed by integrations (Drive, Gmail, Sheets, Calendar, etc.)
7. If app type is `External` and publishing status is `Testing`, add test users who are allowed to sign in.

### 3. Create OAuth Client Credentials

1. Go to `APIs & Services` -> `Credentials`.
2. Click `Create Credentials` -> `OAuth client ID`.
3. Application type: `Web application`.
4. Add **all** authorized redirect URIs — both sign-in (worker) and integration (frontend) callbacks:

   | Flow | Dev | Production |
   |------|-----|------------|
   | Sign-in | `http://localhost:8787/auth/google/callback` | `https://<your-worker>.workers.dev/auth/google/callback` |
   | Integrations | `http://localhost:5173/integrations/callback` | `https://<your-frontend-domain>/integrations/callback` |

   The sign-in callback goes to the **worker** URL. The integrations callback goes to the **frontend** URL (the client-side app handles the OAuth redirect and forwards the code to the worker).

5. Save and copy:
   - `Client ID`
   - `Client Secret`

### 4. Set Worker Credentials

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

### 5. Verify Locally

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
