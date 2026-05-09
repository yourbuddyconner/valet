import type { Env } from '../env.js';
import type { EventBusEvent, EventBusEventType } from '@valet/shared';

/**
 * EventBusDO — centralized real-time event broadcasting hub.
 *
 * Singleton per deployment (accessed via `EVENT_BUS.idFromName('global')`).
 * Accepts WebSocket connections tagged by userId. Receives events from
 * SessionAgentDO and other sources, then broadcasts to relevant users.
 *
 * Uses Cloudflare Durable Object hibernation for WebSocket management.
 */
export class EventBusDO {
  private ctx: DurableObjectState;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // ─── Entry Point ─────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for browser clients
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(url);
    }

    // Internal HTTP endpoints (called by other DOs / worker routes)
    if (url.pathname === '/publish' && request.method === 'POST') {
      return this.handlePublish(request);
    }

    if (url.pathname === '/health') {
      const sockets = this.ctx.getWebSockets();
      return Response.json({ connected: sockets.length });
    }

    return new Response('Not found', { status: 404 });
  }

  // ─── WebSocket Upgrade ───────────────────────────────────────────────────

  private handleWebSocketUpgrade(url: URL): Response {
    const userId = url.searchParams.get('userId');
    if (!userId) {
      return new Response('Missing userId parameter', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag with user:{userId} for targeted broadcasting
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Publish Endpoint ────────────────────────────────────────────────────

  /**
   * Receives events from other DOs/services via HTTP POST.
   * Body: { userId?: string, event: EventBusEvent }
   * If userId is provided, broadcasts to that user only. Otherwise broadcasts to all.
   */
  private async handlePublish(request: Request): Promise<Response> {
    const body = await request.json() as {
      userId?: string;
      event: EventBusEvent;
    };

    const { userId, event } = body;

    if (!event || !event.type) {
      return Response.json({ error: 'Missing event or event.type' }, { status: 400 });
    }

    // Add timestamp if not present
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }

    if (userId) {
      this.broadcast(userId, event);
    } else {
      this.broadcastAll(event);
    }

    return Response.json({ ok: true });
  }

  // ─── Broadcasting ────────────────────────────────────────────────────────

  /** Send an event to all WebSockets tagged with a specific userId. */
  private broadcast(userId: string, event: EventBusEvent): void {
    const sockets = this.ctx.getWebSockets(`user:${userId}`);
    const payload = JSON.stringify(event);

    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Socket likely closed — hibernation will clean it up
      }
    }
  }

  /** Send an event to all connected WebSockets. */
  private broadcastAll(event: EventBusEvent): void {
    const sockets = this.ctx.getWebSockets();
    const payload = JSON.stringify(event);

    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Socket likely closed
      }
    }
  }

  // ─── Hibernation Handlers ────────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const parsed = JSON.parse(message);

      // Handle client ping
      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Clients can subscribe to specific event types
      if (parsed.type === 'subscribe' && Array.isArray(parsed.eventTypes)) {
        // Store subscription as attachment metadata on the WebSocket
        const tags = this.ctx.getTags(ws);
        // We encode subscriptions in the tags - not ideal but simplest approach
        // The actual filtering happens in a future iteration if needed
        // For now, all events are broadcast to all user's connections
        return;
      }
    } catch {
      // Invalid JSON, ignore
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('EventBus WebSocket error:', error);
    ws.close(1011, 'Internal error');
  }
}
