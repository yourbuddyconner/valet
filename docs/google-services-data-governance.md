# RFC: Google Drive/Docs access model for Valet

**Status:** Draft

**Author:** Conner Swann

**Date:** 2026-03-17

## Problem

We want to connect Google Drive and Docs to Valet so agents can read and reference documents on behalf of users. Google Drive has a large blast radius because files tend to contain more sensitive data than chat messages, and Google's sharing model makes it easy for files to be accessible more broadly than intended. We need an access model that makes Drive useful without giving agents unconstrained access to everything a user can see.

## Authentication method

| Option | How it works | Pros | Cons |
|--------|-------------|------|------|
| Per-user OAuth | Each user connects their own Google account. Credentials encrypted per-user in D1. Agent calls Google APIs with its owner's token only. | Natural permission boundary (Google's own ACLs). No shared credential risk. Users already understand the model. | Each user must individually connect. Token refresh overhead. |
| Google Service Account | Single credential with domain-wide delegation acts on behalf of all users. Admin grants it access to shared drives/folders. | Central control. No per-user OAuth flow. Can scope to specific shared drives. | One compromised credential = access to everything delegated. Hard to audit per-user. All-or-nothing access. |
| Service Account + per-user impersonation | Service account impersonates individual users via domain-wide delegation. | Combines central management with per-user scoping. | Requires Workspace admin setup. Impersonation is a broad permission — if the service account is compromised, it can impersonate anyone. More complex to audit. |

**Recommendation:** Per-user OAuth. It's already wired up for Drive, Sheets, Gmail, Calendar, and Docs. The service account models create a shared-credential surface that's hard to reason about and harder to scope down after the fact.

## Permissions model

### OAuth scope

| Option | How it works | Pros | Cons |
|--------|-------------|------|------|
| `drive.file` scope | Token limited to files the user explicitly opened or created through Valet. | Smallest possible surface. Agent can't browse arbitrary files. | Every new file requires the user to go through a Google Picker or grant flow. Works in the web UI (popup picker), but from Slack there's no good way to show that — the user would have to follow a link to a browser, pick files, and come back. Non-starter for our primary channel. |
| Full `drive` scope, no filtering | Token can access anything the user can access in Google Drive. No application-level restrictions. | Maximum functionality. Agent can browse, search, read anything. | Maximum blast radius. Agent can access files the user has access to but wouldn't intentionally share with an AI agent. |
| Full `drive` scope + shared drive allowlist | Token has full access, but the plugin layer restricts the agent to files in admin-approved shared drives only. | Explicit opt-in at the org level. Works from any channel (Slack, web, Telegram) since there's no per-file consent flow. Admin controls the boundary. Shared drives already have clear membership and boundaries. | Doesn't cover files in personal "My Drive" folders. Requires admin setup. |
| Full `drive` scope + two-tier allowlist | Token has full access, but the plugin layer restricts the agent to: (1) org-level shared drives allowlisted by an admin, and (2) user-level My Drive folders allowlisted by the individual user. | Covers both shared team docs and individual work files. Each tier is managed by the right person (admin for shared drives, user for their own folders). Works from any channel. | Slightly more complex config UI — two surfaces instead of one. User must update their allowlist if they reorganize folders. |
| Google Drive labels | Use Google Workspace Labels API to tag files as "valet-accessible." Filter to only labeled files. | Visible in Google Drive UI. Admins can manage without touching Valet. | Requires Google Workspace (not personal accounts). Labels API is newer. Extra step for every file/folder. |

**Recommendation:** Full `drive` scope + two-tier allowlist. The `drive.file` scope is too restrictive for Slack (our primary channel) since it requires a browser-based picker flow for every new file. A two-tier allowlist gives us the right granularity: admins control which shared drives are available org-wide, and individual users can opt in specific My Drive folders for their own agent. The plugin-layer access check verifies that any file the agent touches is in an allowed shared drive or an allowed user folder.

### How the allowlist works

**Org-level (shared drives):**

1. Admin opens Valet settings in the web UI, navigates to Google Drive configuration
2. Valet calls `drives.list` with the admin's OAuth token to enumerate shared drives they can see
3. Admin selects which shared drives Valet is allowed to access
4. Selected drive IDs are stored in org settings (D1)

**User-level (My Drive folders):**

1. User opens their Valet integration settings, clicks "add folder"
2. A Google Picker (scoped to their My Drive) lets them select folders
3. Selected folder IDs are stored per-user in D1

**At runtime**, when any user's agent tries to access a file, the plugin-layer guard checks two things: is the file's `driveId` in the org-level shared drive allowlist, or is the file a descendant of one of this user's allowlisted folders? If neither, the request is denied before data reaches the agent.

The `files.get` response includes a `driveId` field for files in shared drives, so that check is cheap. For My Drive files, the guard checks the file's `parents` chain against the user's allowlisted folder IDs.

## Rollout

1. Enable Google Drive/Docs with per-user OAuth and full `drive` scope
2. Ship the org-level shared drive allowlist in admin settings
3. Ship the user-level My Drive folder allowlist in user integration settings
4. Ship the plugin-layer access guard (`checkFileAccess`) that enforces both tiers
