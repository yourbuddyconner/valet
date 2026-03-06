---
name: sandbox-tunnels
description: Configure frontend/backend apps to work through Valet sandbox tunnels. Use when wiring dev servers (frontend + API + websocket) to /t/<name> routes, avoiding CORS/mixed-content, or debugging tunnel connectivity in a sandbox.
---

# Sandbox Tunnels

## Goal
Expose sandboxed services through the gateway and ensure apps talk to each other using same‑origin tunnel URLs (`/t/<name>`), avoiding CORS and mixed‑content failures.

## Quick Path (Recommended)
1. Start services bound to `0.0.0.0` inside the sandbox.
2. Register tunnels via `register_tunnel`.
3. Wire frontend to the backend using same‑origin `/t/<backend>` paths (no CORS).
4. Open tunnel URL via the UI or `GET /api/sessions/:id/tunnels`.

## Required Patterns
- **Always use same origin**: From the frontend, call the backend using `/t/<backend>` (relative URL).  
  Example:
  - `const API_BASE = "/t/api"`  
  - `fetch(`${API_BASE}/health`)`
- **Avoid `http://127.0.0.1` or `localhost` in browser** — it will fail from an HTTPS tunnel page.
- **Bind to all interfaces**: `--host 0.0.0.0` or `0.0.0.0` in dev servers.

## Tunnel Workflow
1. Start backend:
   - Example: `python backend.py --host 0.0.0.0 --port 3000`
2. Start frontend:
   - Example: `pnpm dev --host 0.0.0.0 --port 3001`
3. Register tunnels:
   - `register_tunnel { name: "api", port: 3000 }`
   - `register_tunnel { name: "frontend", port: 3001 }`
4. Use:
   - Frontend URL: `/t/frontend`
   - Backend URL: `/t/api`

## Token/Gateway Notes
- Tunnel URLs require a **one‑time JWT** to set the gateway cookie.
- UI “Open” links append the token; after first load, the cookie is set.
- If you see `Missing token`, the first request didn’t include it.

## Frontend Integration Patterns
Use **relative URLs** to keep same‑origin:
- REST: `fetch("/t/api/health")`
- WS: `new WebSocket(`${location.origin.replace("http", "ws")}/t/api/ws`)`
- SSE: `new EventSource("/t/api/events")`

If a framework needs an env var, use:
- `API_URL=/t/api`
- `FRONTEND_URL=/t/frontend` (if embedding or linking)

## Debugging Checklist
- `ss -tlnp | rg <port>`: confirm service is listening.
- `curl -sS http://127.0.0.1:<port>/health`: confirm service responds.
- If tunnel shows **“Unable to connect”**, the service isn’t reachable on that port.
- If assets 404 under `/t/<name>/static/...`, ensure the app’s public path works under a prefix (see below).

## Framework Notes (Public Path / Base URL)
Many frontends assume `/` root. When served from `/t/<name>`, set base/public path:
- Vite: `base: "/t/<name>/"` or `--base=/t/<name>/`
- Next.js: `basePath` and `assetPrefix`
- CRA: `PUBLIC_URL=/t/<name>`

If you can’t set base path, use the gateway **fallback** (only when a single tunnel exists) or rewrite assets to be relative.

## Deleting Tunnels
Users can turn off tunnels from the session UI.  
The runner receives a `tunnel-delete` event and unregisters it.

## API Access (for apps / automation)
- `GET /api/sessions/:id` → `session.tunnels` + `doStatus.tunnels`
- `GET /api/sessions/:id/tunnels` → `{ gatewayUrl, tunnels }`

