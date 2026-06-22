---
name: slack-tools
description: How to effectively use Slack tools to read, understand, and interact with Slack channels and threads
---

# Using Slack Tools

## Reading Channels

Use `slack.list_channels` to find channel IDs. Use `slack.read_history` to read messages. Key parameters:

- **`filter`** -- case-insensitive keyword filter, useful for finding specific topics in noisy channels
- **`threads_only`** -- only return messages with thread replies, good for finding discussions in alert channels
- **`oldest` / `latest`** -- narrow to a time window instead of paging through everything
- System messages (joins, topic changes) are filtered out by default. Pass `include_subtypes: true` if you need them.

## Understanding Context Signals

Messages include **reactions** (name + count) that signal consensus and attention. A message with 5 thumbsup is important; one with no reactions may not be. Use reactions to prioritize what to read deeper.

**Pins** are channel-curated important items. Use `slack.get_pins` to see what a channel considers worth preserving.

## Threads

`read_history` shows thread parents with `reply_count`. Use `slack.read_thread` to read replies on threads that matter. Don't read every thread -- prioritize by:

1. High `reply_count` -- active discussions
2. Reactions on the parent -- signals importance
3. Relevance to your current task

## Images and Files

Messages include a `files` array with metadata: name, mimetype, size, and URL. Use `slack.fetch_file` with the URL to view images (mockups, screenshots, diagrams, error screenshots) or read text files.

Don't fetch every file. Read the filename and surrounding message context first -- only fetch when visual understanding actually matters for the task.

## Channel Research

First time reading a channel, use `slack.get_channel_info` to understand its topic, purpose, and who created it. Check `slack.get_pins` for curated important messages.

**Save what you learn to memory** -- channel purpose, norms, key context. Don't re-fetch this every time you read the channel. Only re-check if the channel content seems inconsistent with what you remember.

## People

Messages include `user_display` (e.g., `@conner <Conner Swann> (U123)`) and `bot_display` fields. These tell you who said what without needing to call `slack.list_users`.

Use `slack.list_users` with `filter` when you need to find a Slack user ID by name, handle, or email. The tool searches the whole workspace and includes deactivated human users with `deleted: true`, which is useful when resolving historical messages or references.

Use `slack.get_reactions` when you need to know **who specifically** agreed or acknowledged something, not just the count.

## User Groups

Use `slack.list_usergroups` to find user group IDs and handles. Use `slack.list_usergroup_users` to inspect current membership.

Prefer `slack.add_usergroup_users` and `slack.remove_usergroup_users` for membership changes. They are idempotent: existing users are skipped on add, missing users are skipped on remove, and Slack is only updated when membership actually changes. `remove_usergroup_users` refuses to remove the final member; disable the user group in Slack if it needs to become empty.

Use `slack.update_usergroup` only for metadata changes such as name, handle, description, or default channels.

## Private Channels

Access is scoped to channels the session owner is a member of. If access is denied, tell the user rather than guessing at content.

## Pagination

Large channels require paging via `cursor` / `next_cursor`. Prefer narrowing with `oldest` / `latest` over paging through the full history.
