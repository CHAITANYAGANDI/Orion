"use client";

import { Client, type IMessage } from "@stomp/stompjs";
import SockJS from "sockjs-client";
import type { StatusEvent } from "@/lib/types";

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || "http://localhost:8080/ws";

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
