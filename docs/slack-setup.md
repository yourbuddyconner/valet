# Slack App Setup Guide

This guide walks through creating a Slack app and connecting it to Valet.

## Overview

Valet uses an org-level Slack integration. One admin installs the app for the entire workspace, then individual users link their Slack accounts via a DM verification code.

## Step 1: Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Choose **From a manifest**.
3. Select your workspace.
4. Paste the manifest from `packages/worker/slack-app-manifest.json`, replacing `YOUR_WORKER_URL` with your deployed worker URL (e.g. `https://valet.conner-7e8.workers.dev`):

```json
{
  "display_information": {
    "name": "Valet",
    "description": "AI coding agent — send prompts, get results",
    "background_color": "#1a1a2e"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Valet",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "chat:write.public",
        "files:read",
        "groups:history",
        "im:history",
        "im:read",
        "im:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://YOUR_WORKER_URL/channels/slack/events",
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im"
      ]
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

5. Click **Create**.

## Step 2: Install the App to Your Workspace

1. In the app settings sidebar, go to **Install App**.
2. Click **Install to Workspace**.
3. Review the permissions and click **Allow**.

## Step 3: Get the Bot Token and Signing Secret

### Bot Token

1. After installing, go to **Install App** in the sidebar.
2. Copy the **Bot User OAuth Token** — it starts with `xoxb-`.

### Signing Secret

1. Go to **Basic Information** in the sidebar.
2. Under **App Credentials**, find and copy the **Signing Secret**.

## Step 4: Configure Valet

Everything is configured through the admin UI — no environment variables needed.

1. Log in to Valet as an admin.
2. Go to **Settings > Organization**.
3. Find the **Slack** section.
4. Click **Install Slack App**.
5. Paste the **Bot User OAuth Token** (`xoxb-...`).
6. Paste the **Signing Secret** (from Basic Information > App Credentials).
7. Click **Install**.

Both values are encrypted at rest using AES-256-GCM (same as org LLM API keys).

## Step 5: Verify Events URL

After setting the signing secret and deploying:

1. Go back to your Slack app settings at [api.slack.com/apps](https://api.slack.com/apps).
2. Go to **Event Subscriptions**.
3. The Request URL should show as **Verified**. If not, click **Retry** — Slack sends a `url_verification` challenge that Valet handles automatically.

## Step 6: Link User Accounts

Each Valet user links their own Slack identity:

1. Go to **Integrations** in the Valet sidebar.
2. The **Slack** card appears (only visible if an admin has installed the app).
3. Click **Link Account**.
4. Search for your Slack username in the typeahead.
5. Select yourself — the bot will DM you a 6-character verification code.
6. Enter the code in Valet.

Once linked, messages you send in Slack channels where the bot is present will route to your orchestrator.

## Required Bot Scopes

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | React to @Valet mentions in channels |
| `channels:history` | Read messages in public channels the bot is in |
| `groups:history` | Read messages in private channels the bot is invited to |
| `im:history` | Read direct messages to the bot |
| `im:read` | List DM conversations (for verification flow) |
| `im:write` | Open DMs with users (for verification code delivery) |
| `chat:write` | Send messages and replies |
| `chat:write.public` | Post in channels the bot hasn't joined |
| `files:read` | Access file attachments shared in messages |
| `users:read` | List workspace members (for the link typeahead) |

## Troubleshooting

**Events URL won't verify**: Make sure `SLACK_SIGNING_SECRET` is set in the worker environment and the worker is deployed. The events endpoint is at `/channels/slack/events`.

**Bot token rejected**: Ensure you're using the **Bot User OAuth Token** (starts with `xoxb-`), not a user token or app-level token.

**User messages not routing**: The user must have completed the identity link flow. Check that their Slack user ID appears in the `user_identity_links` table with `provider = 'slack'`.

**Bot not receiving messages in a channel**: The bot must be invited to the channel first. In Slack, type `/invite @Valet` in the channel.
