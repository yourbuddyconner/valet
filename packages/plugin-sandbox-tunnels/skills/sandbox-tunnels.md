---
name: sandbox-tunnels
description: Expose sandboxed services via public Cloudflare Quick Tunnels. Each tunnel gets a unique hostname with no path prefix — apps work as if hosted at root.
---

# Sandbox Tunnels

## Goal
Expose sandboxed services through public Cloudflare Quick Tunnels. Each tunnel gets its own unique `*.trycloudflare.com` hostname — no path prefix, no base URL configuration needed.

## Quick Path
1. Start services bound to `0.0.0.0` inside the sandbox.
2. Register tunnels via `register_tunnel`.
3. Use the returned public URL directly — no CORS, no base path.

## Tunnel Workflow
1. Start backend:
   - Example: `python backend.py --host 0.0.0.0 --port 3000`
2. Start frontend:
   - Example: `pnpm dev --host 0.0.0.0 --port 3001`
3. Register tunnels:
   - `register_tunnel { name: "api", port: 3000 }`
   - `register_tunnel { name: "frontend", port: 3001 }`
4. Each tunnel returns a unique public URL like `https://random-words.trycloudflare.com`
5. Share the URL — no token or auth needed for public access.

## Key Differences from Gateway Tunnels
- **No path prefix**: Apps are served at `/`, not `/t/<name>/`.
- **No base path config**: No need to set `base`, `basePath`, `PUBLIC_URL`, or `assetPrefix`.
- **No JWT/token**: Cloudflare Quick Tunnels are publicly accessible (no gateway auth).
- **Independent hostnames**: Each tunnel is a separate origin — no CORS between tunnels.

## Cross-Origin Between Tunnels
Since each tunnel is its own origin, frontend-to-backend calls are cross-origin. Options:
- **Enable CORS** on the backend (recommended for APIs).
- **Proxy through the frontend** (e.g., Vite proxy, Next.js rewrites).
- **Use the gateway fallback**: The old `/t/<name>` paths still work through the gateway for same-origin access.

## Frontend Integration
```js
// Use the tunnel URL directly
const API_URL = "https://backend-words.trycloudflare.com"
fetch(`${API_URL}/health`)

// Or set via environment variable
// API_URL=https://backend-words.trycloudflare.com
```

## WebSocket Support
Cloudflare Quick Tunnels support WebSockets natively:
```js
const ws = new WebSocket("wss://backend-words.trycloudflare.com/ws")
```

## Debugging Checklist
- `ss -tlnp | rg <port>`: confirm service is listening on 0.0.0.0.
- `curl -sS http://127.0.0.1:<port>/health`: confirm service responds locally.
- If tunnel URL returns 502, the local service isn't reachable on that port.
- `list_tunnels` to see all active tunnels and their URLs.

## Deleting Tunnels
- `unregister_tunnel { name: "api" }` kills the cloudflared process.
- Users can also delete tunnels from the session UI.

## Gateway Fallback
The gateway `/t/<name>` paths still work for same-origin access within the sandbox. These require JWT auth and are useful for internal service-to-service calls.

## API Access
- `GET /api/sessions/:id/tunnels` → `{ gatewayUrl, tunnels }` (tunnels include cloudflared URLs)
