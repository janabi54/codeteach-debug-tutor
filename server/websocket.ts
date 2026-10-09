/**
 * WebSocket server for real-time nudges.
 *
 * Auth: on connect, we read the ct_session cookie from the upgrade
 * request headers, resolve the session to a user, and register the
 * socket under that user's ID. Anonymous sockets are closed.
 *
 * Broadcast: `broadcastToUser(userId, payload)` sends a JSON payload
 * to every open socket for that user. Used by REST routes when a
 * message is created or read.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { resolveSession } from './auth/sessions.js';
import { SESSION_COOKIE_NAME } from './auth/cookies.js';

const connections = new Map<string, Set<WebSocket>>();

/** Parse cookies out of a raw `cookie:` header string. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function attachWebSocketServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];

    if (!token) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    let user;
    try {
      user = await resolveSession(token);
    } catch (err) {
      console.error('[ws] session resolve failed:', err);
      ws.close(1011, 'Server error');
      return;
    }

    if (!user) {
      ws.close(4401, 'Session expired');
      return;
    }

    // Register
    if (!connections.has(user.id)) connections.set(user.id, new Set());
    connections.get(user.id)!.add(ws);
    console.log('[ws] connected user=' + user.email);

    // Optional: send a hello with unread count
    try {
      // Circular import concern: importing db here is fine — db is a singleton.
      // We import dynamically to avoid a top-level cycle with routes that import this module.
      const { db } = await import('./db.js');
      const count = db.nudges.unreadCount(user.id);
      ws.send(JSON.stringify({ type: 'unread-count', count }));
    } catch (err) {
      // Non-fatal — hello is optional
    }

    ws.on('message', (raw) => {
      // We don't expect client → server messages yet. Log for debugging.
      try {
        const msg = JSON.parse(raw.toString());
        if (msg && msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      const set = connections.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) connections.delete(user.id);
      }
      console.log('[ws] disconnected user=' + user.email);
    });

    ws.on('error', (err) => {
      console.error('[ws] socket error for ' + user.email + ':', err?.message ?? err);
    });
  });

  console.log('[ws] WebSocket server attached at /ws');
}

/**
 * Send a payload to every open socket owned by `userId`.
 * Returns the number of sockets that received the message.
 */
export function broadcastToUser(userId: string, payload: unknown): number {
  const set = connections.get(userId);
  if (!set || set.size === 0) return 0;
  const data = JSON.stringify(payload);
  let n = 0;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      n++;
    }
  }
  return n;
}

/**
 * Send the current unread count to a user.
 * Called after any change that might affect the count.
 */
export async function pushUnreadCount(userId: string): Promise<void> {
  try {
    const { db } = await import('./db.js');
    const count = db.nudges.unreadCount(userId);
    broadcastToUser(userId, { type: 'unread-count', count });
  } catch {
    // ignore
  }
}
