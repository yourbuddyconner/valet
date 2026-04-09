---
name: github
description: How to use GitHub integration tools — list repos, create PRs, manage issues, read files. Covers credential routing (personal vs org), available actions, and common patterns.
---

# GitHub Integration Tools

You interact with GitHub through integration actions, NOT the `gh` CLI (which is not available in sandboxes).

## Quick Start

```
list_tools service=github    # Discover available GitHub actions
call_tool github:github.<action_id> params={...} summary="..."
```

## Credential Routing

GitHub tools support two credential sources:

- **`source=personal`** — your personal OAuth token. Access to your own repos (public + private).
- **`source=org`** — org GitHub App install token. Access to repos in organizations where the App is installed.

Every GitHub action accepts an optional `source` parameter. If omitted, the system auto-resolves:
1. If the action has an `owner` param matching an org the App covers, uses org credential
2. Otherwise: org credential preferred, personal fallback
3. On auth failure, automatically retries with the other credential

**When to specify `source` explicitly:**
- `list_repos source=personal` — list your personal repos
- `list_repos source=org` — list org-accessible repos
- For repo-specific actions (get_repository, create_pull_request, etc.), auto-resolution usually works — just pass `owner` and `repo`

## Available Actions

### Repository
- `github.list_repos` — list repositories (use `source` to choose personal vs org)
- `github.get_repository` — get repo details by owner/name
- `github.create_repository` — create a new repository
- `github.fork_repository` — fork a repository
- `github.read_repo_file` — read a file from a repository

### Issues
- `github.list_issues` — list issues for a repo
- `github.get_issue` — get a specific issue by number
- `github.create_issue` — create a new issue
- `github.update_issue` — update an issue (title, body, state, labels)

### Pull Requests
- `github.list_pull_requests` — list PRs for a repo
- `github.get_pull_request` — get a specific PR by number
- `github.inspect_pull_request` — get detailed PR info (files, comments, check runs)
- `github.create_pull_request` — create a new PR
- `github.update_pull_request` — update a PR (title, body, state, labels)
- `github.merge_pull_request` — merge a PR
- `github.create_comment` — comment on an issue or PR

### Branches & Commits
- `github.create_branch` — create a branch from a ref
- `github.delete_branch` — delete a branch
- `github.list_commits` — list commits on a branch

### Search
- `github.search_code` — search code across repositories
- `github.search_issues` — search issues and PRs

### Releases & CI
- `github.create_release` — create a release with tag
- `github.list_workflow_runs` — list GitHub Actions workflow runs

## Common Patterns

### Create a PR after committing changes
```
# Use git CLI for local operations
git checkout -b feature/my-change
# ... make changes, commit ...
git push -u origin feature/my-change

# Use integration tool for PR creation (not gh CLI)
call_tool github:github.create_pull_request \
  owner=<owner> repo=<repo> \
  title="My change" body="Description" \
  head="feature/my-change" base="main" \
  summary="Create PR for feature/my-change"
```

### List all repos you have access to
```
# Personal repos
call_tool github:github.list_repos source=personal summary="List personal repos"

# Org repos (via GitHub App)
call_tool github:github.list_repos source=org summary="List org repos"
```

### Read a file without cloning
```
call_tool github:github.read_repo_file \
  owner=<owner> repo=<repo> path="README.md" \
  summary="Read README from owner/repo"
```

## Important Notes

- The `gh` CLI is NOT available. Always use `call_tool` with GitHub actions.
- Use git CLI for local operations (checkout, add, commit, push, pull).
- Use `report_git_state` after checking out branches or making commits.
- The `summary` parameter on `call_tool` is required for medium/high risk actions (like creating PRs). Make it descriptive.
