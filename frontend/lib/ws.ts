"use client";

import { Client, type IMessage } from "@stomp/stompjs";
import SockJS from "sockjs-client";
import { buildAuthHeaders } from "@/lib/auth-store";
import type { StatusEvent } from "@/lib/types";

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || "http://localhost:8080/ws";

/**
 * Put this tab's credential on the CONNECT frame.
 *
 * <p>The SockJS handshake is a plain GET and cannot carry one — a browser will
 * not let a page set headers on it — so the socket authenticates one frame
 * later, on CONNECT, and the server refuses the connection without it. See
 * `StompAuthInterceptor`.
 *
 * <p>Read per connection rather than once at construction, and that is the
 * point of doing it in `beforeConnect`: stompjs reconnects on its own, a Clerk
 * token lasts about a minute, and a header captured when the page loaded would
 * be stale by the first reconnection. `buildAuthHeaders` asks Clerk for a fresh
 * one each time, so a reconnect an hour later carries a valid token instead of
 * an expired one — which is the difference between a socket that recovers and
 * one that retries into a refusal for ever.
 *
 * <p>The same headers the REST client sends, from the same place, so the socket
 * and the API cannot come to disagree about who this is.
 */
async function authenticated(client: Client): Promise<void> {
  try {
    client.connectHeaders = await buildAuthHeaders();
  } catch {
    // Connect without it and be refused, rather than not connecting at all:
    // the refusal is visible in the logs and every caller polls anyway.
    client.connectHeaders = {};
  }
}

export interface StatusHandlers {
  onEvent: (event: StatusEvent) => void;
  onConnect?: () => void;
  onError?: (message: string) => void;
}

export interface MeetingStatusSubscription {
  deactivate: () => void;
}

/**
 * Subscribe to live processing status for one meeting over STOMP/SockJS.
 * Topic: `/topic/meetings/{meetingId}` (api-contracts §7).
 * Returns a handle whose `deactivate()` tears the connection down. Callers
 * should implement a polling fallback (GET /meetings/{id}) if `onError`/
 * `onConnect` indicates the socket is unavailable.
 */
/**
 * Subscribe to the bell.
 *
 * <p>The frame carries an unread count and nothing else — see
 * `NotificationPublisher` on the server for why. This is a nudge to re-read
 * over the authenticated API, not a delivery mechanism, so the handler is given
 * no content to render and cannot accidentally start rendering it.
 *
 * <p>The channel comes from `GET /notifications/unread-count`; the browser is
 * authenticated as a Clerk subject and has never been told its internal user id.
 */
export function subscribeNotifications(
  channel: string,
  onPing: (unread: number) => void
): MeetingStatusSubscription {
  let client: Client | null = null;

  try {
    client = new Client({
      webSocketFactory: () => new SockJS(WS_URL) as unknown as WebSocket,
      reconnectDelay: 8000,
      heartbeatIncoming: 20000,
      heartbeatOutgoing: 20000,
      beforeConnect: authenticated,
      onConnect: () => {
        client?.subscribe(`/topic/users/${channel}/notifications`, (msg: IMessage) => {
          try {
            const body = JSON.parse(msg.body) as { unread?: number };
            onPing(typeof body.unread === "number" ? body.unread : 0);
          } catch {
            // A frame we cannot read still means something changed, and the
            // caller re-fetches either way.
            onPing(-1);
          }
        });
      },
      onStompError: () => {
        /* the caller's poll covers it */
      },
      onWebSocketError: () => {
        /* likewise */
      },
    });
    client.activate();
  } catch {
    // A browser with no WebSocket at all is not a broken bell, only a slower
    // one: the caller polls.
  }

  return {
    deactivate: () => {
      try {
        void client?.deactivate();
      } catch {
        /* ignore */
      }
    },
  };
}

export function subscribeMeetingStatus(
  meetingId: string,
  handlers: StatusHandlers
): MeetingStatusSubscription {
  let client: Client | null = null;

  try {
    client = new Client({
      // SockJS handles the http(s):// -> ws upgrade + fallbacks.
      webSocketFactory: () => new SockJS(WS_URL) as unknown as WebSocket,
      reconnectDelay: 4000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      beforeConnect: authenticated,
      onConnect: () => {
        handlers.onConnect?.();
        client?.subscribe(`/topic/meetings/${meetingId}`, (msg: IMessage) => {
          try {
            handlers.onEvent(JSON.parse(msg.body) as StatusEvent);
          } catch {
            /* ignore malformed frame */
          }
        });
      },
      onStompError: (frame) =>
        handlers.onError?.(frame.headers["message"] || "STOMP error"),
      onWebSocketError: () => handlers.onError?.("WebSocket connection failed"),
      onWebSocketClose: () => {
        /* stompjs auto-reconnects; polling fallback covers the gap */
      },
    });
    client.activate();
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err.message : "WebSocket error");
  }

  return {
    deactivate: () => {
      try {
        void client?.deactivate();
      } catch {
        /* ignore */
      }
    },
  };
}
