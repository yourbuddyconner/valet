import { useEffect, useRef, useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/auth';
import { getWebSocketUrl } from '@/api/client';

type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
}

export function useWebSocket(url: string | null, options: UseWebSocketOptions = {}) {
  const {
    onMessage,
    onConnect,
    onDisconnect,
    onError,
    reconnect = true,
    maxReconnectAttempts = 10,
  } = options;

  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<number | null>(null);

  // Store callbacks in refs to avoid triggering reconnection when they change
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  // Update refs when callbacks change (doesn't trigger reconnect)
  useEffect(() => {
    onMessageRef.current = onMessage;
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [onMessage, onConnect, onDisconnect, onError]);

  const token = useAuthStore((state) => state.token);

  const connect = useCallback(() => {
    if (!url || !token) return;

    setStatus('connecting');

    const wsUrlStr = getWebSocketUrl(url);
    const wsUrl = new URL(wsUrlStr);

    const ws = new WebSocket(wsUrl.toString(), ['valet', `bearer.${token}`]);

    ws.onopen = () => {
      setStatus('connected');
      reconnectAttemptsRef.current = 0;
      onConnectRef.current?.();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;
        onMessageRef.current?.(message);
      } catch {
        console.error('Failed to parse WebSocket message:', event.data);
      }
    };

    ws.onerror = (event) => {
      setStatus('error');
      onErrorRef.current?.(event);
    };

    ws.onclose = () => {
      // If a newer WebSocket has already replaced this one (e.g. session navigation
      // triggered disconnect + reconnect), skip all handling to avoid clobbering the
      // new connection's state and triggering a stale reconnect to the old URL.
      if (wsRef.current !== null && wsRef.current !== ws) return;

      setStatus('disconnected');
      wsRef.current = null;
      onDisconnectRef.current?.();

      if (reconnect && reconnectAttemptsRef.current < maxReconnectAttempts) {
        const attempt = reconnectAttemptsRef.current;
        reconnectAttemptsRef.current += 1;
        const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
        const jitter = baseDelay * 0.2 * Math.random();
        reconnectTimeoutRef.current = window.setTimeout(() => {
          connect();
        }, baseDelay + jitter);
      }
    };

    wsRef.current = ws;
  }, [url, token, reconnect, maxReconnectAttempts]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttemptsRef.current = maxReconnectAttempts;
    wsRef.current?.close();
    wsRef.current = null;
    setStatus('disconnected');
  }, [maxReconnectAttempts]);

  const send = useCallback((message: WebSocketMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(message);
      if (payload.length > 30_000_000) {
        console.warn(`[ws] payload very large: ${(payload.length / 1_000_000).toFixed(1)} MB`);
      }
      try {
        wsRef.current.send(payload);
      } catch (err) {
        console.error('[ws] send failed:', err);
      }
    }
  }, []);

  useEffect(() => {
    // Reset reconnect counter whenever the connection target changes so that
    // a prior session's exhausted retries don't prevent reconnection to a new
    // session.  disconnect() intentionally sets the counter to maxReconnectAttempts
    // to suppress retries during teardown, but we need a fresh budget here.
    reconnectAttemptsRef.current = 0;

    if (url && token) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [url, token, connect, disconnect]);

  return {
    status,
    send,
    connect,
    disconnect,
    isConnected: status === 'connected',
  };
}
