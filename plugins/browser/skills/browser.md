---
name: browser
description: Control the Chromium browser using the agent-browser CLI. Navigate, click, type, fill forms, take snapshots, extract content, and more.
---

# Browser Control via agent-browser CLI

You have `agent-browser` installed globally. It controls a real Chromium browser on display `:99` (visible in the user's VNC panel).

**Always use `--headed` flag** so the browser renders on the VNC display:

```bash
agent-browser --headed <command>
```

## Core Workflow

1. **Open a URL**: `agent-browser --headed open <url>`
2. **Take a snapshot** to see page structure: `agent-browser --headed snapshot -i -c`
3. **Interact** using element refs from the snapshot: `agent-browser --headed click @e3`
4. **Verify visually**: Use the `browser_screenshot` tool to capture the VNC display and show it in chat.

## Navigation

```bash
agent-browser --headed open <url>          # Navigate to URL
agent-browser --headed back                # Go back
agent-browser --headed forward             # Go forward
agent-browser --headed reload              # Reload page
agent-browser --headed close               # Close browser
```

## Clicking & Focus

```bash
agent-browser --headed click <selector>    # Click element (CSS selector or @ref)
agent-browser --headed dblclick <selector> # Double-click
agent-browser --headed focus <selector>    # Focus element
agent-browser --headed hover <selector>    # Hover over element
```

## Text Input

```bash
agent-browser --headed type <selector> <text>   # Type into element (appends)
agent-browser --headed fill <selector> <text>    # Clear field and fill with text
agent-browser --headed press <key>               # Press key (Enter, Tab, Control+a, etc.)
```

## Form Controls

```bash
agent-browser --headed select <selector> <value> # Select dropdown option
agent-browser --headed check <selector>           # Check checkbox
agent-browser --headed uncheck <selector>         # Uncheck checkbox
agent-browser --headed upload <selector> <files>  # Upload files
```

## Scrolling

```bash
agent-browser --headed scroll down [px]           # Scroll down (default ~page)
agent-browser --headed scroll up [px]             # Scroll up
agent-browser --headed scrollintoview <selector>  # Scroll element into view
```

## Snapshots (Accessibility Tree)

Snapshots give you a structured view of the page with element refs (`@e1`, `@e2`, etc.) you can use in subsequent commands.

```bash
agent-browser --headed snapshot              # Full accessibility tree
agent-browser --headed snapshot -i           # Interactive elements only
agent-browser --headed snapshot -c           # Compact output
agent-browser --headed snapshot -i -c        # Interactive + compact (recommended)
agent-browser --headed snapshot -d 3         # Limit depth to 3
agent-browser --headed snapshot -s "main"    # Scope to a CSS selector
```

After a snapshot, use the `@ref` identifiers to interact:

```bash
agent-browser --headed click @e3
agent-browser --headed fill @e7 "search query"
```

## Getting Page Information

```bash
agent-browser --headed get title             # Page title
agent-browser --headed get url               # Current URL
agent-browser --headed get text <selector>   # Text content of element
agent-browser --headed get html <selector>   # innerHTML of element
agent-browser --headed get value <selector>  # Input value
agent-browser --headed get attr <sel> <attr> # Element attribute
agent-browser --headed get count <selector>  # Count matching elements
```

## Checking Element State

```bash
agent-browser --headed is visible <selector>  # Check visibility
agent-browser --headed is enabled <selector>  # Check if enabled
agent-browser --headed is checked <selector>  # Check if checked
```

## Waiting

```bash
agent-browser --headed wait <selector>         # Wait for element to appear
agent-browser --headed wait 2000               # Wait 2 seconds
agent-browser --headed wait --text "Success"   # Wait for text to appear
agent-browser --headed wait --url "**/dashboard" # Wait for URL pattern
```

**NEVER use `wait --load networkidle`** — many sites never reach network idle (analytics, websockets, polling). It will hang indefinitely and can break the session.

## Semantic Finding

Find elements by role, text, label, etc. and perform actions:

```bash
agent-browser --headed find role button click              # Click first button
agent-browser --headed find text "Submit" click            # Click element with text
agent-browser --headed find label "Email" fill "a@b.com"   # Fill by label
agent-browser --headed find placeholder "Search" fill "q"  # Fill by placeholder
agent-browser --headed find testid "login-btn" click       # Click by data-testid
```

## Tabs

```bash
agent-browser --headed tab                   # List open tabs
agent-browser --headed tab new [url]         # Open new tab
agent-browser --headed tab 2                 # Switch to tab 2
agent-browser --headed tab close [n]         # Close tab
```

## JavaScript Evaluation

```bash
agent-browser --headed eval "document.title"
agent-browser --headed eval "window.scrollTo(0, document.body.scrollHeight)"
```

## Dialogs

```bash
agent-browser --headed dialog accept [text]  # Accept alert/confirm/prompt
agent-browser --headed dialog dismiss        # Dismiss dialog
```

## Cookies & Storage

```bash
agent-browser --headed cookies               # List cookies
agent-browser --headed cookies clear         # Clear cookies
agent-browser --headed storage local         # List localStorage
agent-browser --headed storage local <key>   # Get specific key
```

## Common Workflow Examples

### Navigate and extract content

```bash
timeout 15 agent-browser --headed open "https://example.com"
agent-browser --headed snapshot -i -c
agent-browser --headed get title
```

### Fill a form

```bash
timeout 15 agent-browser --headed open "https://example.com/login"
agent-browser --headed snapshot -i -c
timeout 10 agent-browser --headed fill @e3 "user@example.com"
timeout 10 agent-browser --headed fill @e5 "password123"
timeout 15 agent-browser --headed click @e7
agent-browser --headed wait 2000
agent-browser --headed snapshot -i -c
```

### Using snapshot refs

```bash
agent-browser --headed open "https://news.ycombinator.com"
agent-browser --headed snapshot -i -c
# Output shows refs like @e1, @e2, @e3...
agent-browser --headed click @e5    # Click the 5th interactive element
agent-browser --headed get title    # Verify navigation
```

## Avoiding Hangs

Browser commands can hang if a page never finishes loading or a click triggers an unexpected navigation. **Always wrap browser commands with `timeout`** to prevent blocking the session:

```bash
timeout 15 agent-browser --headed click @e3
timeout 15 agent-browser --headed open "https://example.com"
timeout 15 agent-browser --headed fill @e7 "text"
```

Use `timeout 15` (15 seconds) as a sensible default. If a command times out, take a snapshot to see what happened and adjust your approach.

**Never use `wait --load networkidle`** — it hangs on most real-world sites. Instead, wait for specific elements:

```bash
timeout 10 agent-browser --headed wait "input[name=email]"  # Wait for a specific element
timeout 10 agent-browser --headed wait --text "Welcome"     # Wait for specific text
```

## Tips

- **Always take a screenshot** with `browser_screenshot` after navigating or clicking so you and the user can see the result.
- Use `snapshot -i -c` as your go-to for understanding page structure.
- Prefer `fill` over `type` for form fields (it clears first).
- The browser persists between commands within a session. No need to reopen it.
- If the browser isn't running, `agent-browser --headed open <url>` will start it.
