# OAuth Setup

Authentication uses GitHub App OAuth as the primary sign-in and repo-access path, and optionally Google OAuth.

## GitHub App (Required)

Valet uses a single GitHub App. Do not create a separate classic GitHub OAuth App.

The GitHub App supplies both:

- User-to-server OAuth tokens from the App's OAuth web flow. These are stored as user `github` credentials with `credentialType: oauth2`, expire after roughly 8 hours, and are refreshed through the GitHub App OAuth refresh endpoint.
- Installation tokens minted from GitHub App installations. These are used as a fallback for installed org/user accounts when a user has not linked GitHub, expire after roughly 1 hour, and are not stored as user OAuth credentials.

Classic OAuth scopes such as `repo`, `read:user`, and `user:email` are not configured separately. User tokens inherit the GitHub App's permissions, intersected with the repositories and organizations the user can access.

### 1. Configure Worker URLs

Set these before creating the GitHub App so generated callback and webhook URLs use the public worker origin.

Local dev (`packages/worker/.dev.vars`):

```bash
ENCRYPTION_KEY=any-string-at-least-32-characters-long
FRONTEND_URL=http://localhost:5173
API_PUBLIC_URL=http://localhost:8787
```

Production secrets:

```bash
cd packages/worker
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put FRONTEND_URL
npx wrangler secret put API_PUBLIC_URL
```

`FRONTEND_URL` is where login and setup flows redirect after completion. `API_PUBLIC_URL` should be the public worker/API origin, for example `https://<your-worker>.workers.dev` or `https://api.example.com`.

Do not set `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET`; the GitHub App OAuth client ID/secret are stored through the GitHub App setup flow.

### 2. Create the GitHub App

Preferred setup is from Valet's admin GitHub settings:

1. Start the worker and frontend.
2. Sign in as an admin.
3. Open the admin GitHub settings page.
4. Enter the GitHub organization where the app should be created.
5. Click `Create GitHub App` and complete GitHub's manifest flow.

The admin flow calls `POST /api/admin/github/app/manifest`, sends a GitHub App manifest to GitHub, and receives the callback at:

| Flow | Dev | Production |
|------|-----|------------|
| Manifest setup callback | `http://localhost:8787/github/app/setup` | `https://<your-worker>/github/app/setup` |

The callback converts GitHub's manifest code and stores the App ID, slug, private key, webhook secret, OAuth client ID, and OAuth client secret encrypted in D1 service config.

For a manual GitHub App setup, use these URLs:

| Field | Dev | Production |
|-------|-----|------------|
| Homepage URL | `http://localhost:5173` | `https://<your-frontend-domain>` |
| User authorization callback URL | `http://localhost:8787/auth/github/callback` | `https://<your-worker>/auth/github/callback` |
| Setup URL | `http://localhost:8787/github/app/setup` | `https://<your-worker>/github/app/setup` |
| Webhook URL | `http://localhost:8787/webhooks/github` | `https://<your-worker>/webhooks/github` |

The worker's actual unauthenticated webhook handler is `POST /webhooks/github`. The current manifest generator sets the webhook URL to `/api/webhooks/github`, so after GitHub creates the App, update the webhook URL in GitHub App settings to `/webhooks/github`.

### 3. Permissions and Events

Default permissions used by the admin manifest:

| Permission | Access |
|------------|--------|
| Contents | Read and write |
| Metadata | Read |
| Pull requests | Read and write |
| Issues | Read and write |
| Actions | Read and write |
| Checks | Read |

Default subscribed events:

- `push`
- `pull_request`

The admin UI can add more events if needed, including `issues`, `issue_comment`, `create`, `delete`, `release`, `workflow_run`, `check_run`, `check_suite`, and `status`.

### 4. Install and Link

Install the GitHub App on the organization or user account that owns the repositories Valet should access. Org installs are listed in the admin GitHub settings and can be refreshed with `POST /api/admin/github/app/refresh`.

Users link their GitHub account through `POST /api/me/github/link`, which redirects to the GitHub App OAuth web flow and returns to `GET /auth/github/callback`. GitHub sign-in starts at `GET /auth/github` and uses the same callback.

### 5. Verify GitHub Locally

1. Start the worker (`make dev-worker` or `make dev-all`).
2. Start the frontend.
3. Create the GitHub App from admin settings and confirm the browser returns to `/settings/admin?created=true`.
4. Confirm the App is installed and visible in admin GitHub settings.
5. In GitHub App settings, confirm:
   - Callback URL is `http://localhost:8787/auth/github/callback`
   - Webhook URL is `http://localhost:8787/webhooks/github`
   - Webhook deliveries to `/webhooks/github` return `200`
6. Link a user account from the GitHub integration card and confirm it returns to `/integrations?github=linked`.
7. Start a session against a GitHub repo and confirm repo access works through either the linked user token or the App installation fallback.

## Google OAuth (Optional)

Google OAuth is used for two separate flows with different redirect URIs:

1. **Sign-in** - User login via `GET /auth/google` with callback to the **worker**
2. **Integration OAuth** - Connecting Google services (Drive, Gmail, Sheets, etc.) with callback to the **frontend**

The sign-in flow requests scopes: `openid`, `email`, `profile`.
Integration flows request service-specific scopes, for example `https://www.googleapis.com/auth/drive.readonly`.

Both flows use the same Google OAuth Client ID/Secret.

### 1. Enable Google APIs

Each Google integration requires its corresponding API to be enabled. Go to `APIs & Services` -> `Library` and enable:

- **Google Drive API** - required for Google Drive integration
- **Google Sheets API** - required for Google Sheets integration
- **Gmail API** - required for Gmail integration
- **Google Calendar API** - required for Google Calendar integration
- **Google Docs API** - required for Google Docs integration

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
4. Add all authorized redirect URIs - both sign-in (worker) and integration (frontend) callbacks:

   | Flow | Dev | Production |
   |------|-----|------------|
   | Sign-in | `http://localhost:8787/auth/google/callback` | `https://<your-worker>/auth/google/callback` |
   | Integrations | `http://localhost:5173/integrations/callback` | `https://<your-frontend-domain>/integrations/callback` |

   The sign-in callback goes to the worker URL. The integrations callback goes to the frontend URL; the client-side app handles the OAuth redirect and forwards the code to the worker.

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

### 5. Verify Google Locally

1. Start the worker (`make dev-worker` or `make dev-all`).
2. Visit `http://localhost:8787/auth/google`.
3. Complete Google sign-in and confirm redirect back through:
   - `http://localhost:8787/auth/google/callback`
   - then to frontend `/auth/callback?...&provider=google`

## Local Credentials Summary

Create `packages/worker/.dev.vars`:

```bash
ENCRYPTION_KEY=any-string-at-least-32-characters-long
FRONTEND_URL=http://localhost:5173
API_PUBLIC_URL=http://localhost:8787
GOOGLE_CLIENT_ID=your_google_client_id              # optional
GOOGLE_CLIENT_SECRET=your_google_client_secret      # optional
```

GitHub App credentials are not listed here because they are stored encrypted in D1 by the GitHub App setup callback.

## Production Secrets Summary

```bash
cd packages/worker
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put FRONTEND_URL
npx wrangler secret put API_PUBLIC_URL
npx wrangler secret put GOOGLE_CLIENT_ID      # optional
npx wrangler secret put GOOGLE_CLIENT_SECRET  # optional
```

After deploying, create or refresh the GitHub App from the admin GitHub settings so the encrypted App config exists in the production D1 database.
