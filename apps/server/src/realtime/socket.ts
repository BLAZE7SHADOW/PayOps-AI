import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { ROOMS, type RunEventName } from '@payops/shared';
import type { EventPublisherPort, Logger } from '@payops/core';
import { resolveSession } from '../auth/middleware';
import { SESSION_COOKIE, readCookie, type SessionConfig } from '../auth/session';
import type { SessionStore } from '../auth/session-store';

/** In-process Socket.IO. Everyone joins the "ops" room; clients join case rooms on demand. */
export function createRealtime(http: HttpServer, opts: { origin: string; log: Logger; session: SessionConfig; sessions: SessionStore }) {
  const io = new Server(http, { cors: { origin: opts.origin, credentials: true }, path: '/socket.io' });

  // Only signed-in users get realtime events: the handshake must carry a valid session cookie.
  io.use((socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    resolveSession(token, opts.session, opts.sessions).then(
      (active) => {
        if (!active) return next(new Error('UNAUTHENTICATED'));
        socket.data.user = active.user;
        socket.data.sessionId = active.id;
        next();
      },
      () => next(new Error('UNAUTHENTICATED')),
    );
  });

  // A revoked session must not keep receiving events over a socket opened before it was revoked.
  opts.sessions.onRevoked((ids) => {
    for (const socket of io.sockets.sockets.values()) {
      if (ids.includes(socket.data.sessionId as string)) socket.disconnect(true);
    }
  });

  io.on('connection', (socket) => {
    void socket.join(ROOMS.ops);
    socket.on('case:join', (caseId: unknown) => {
      if (typeof caseId === 'string' && caseId.length <= 64) void socket.join(ROOMS.case(caseId));
    });
    socket.on('case:leave', (caseId: unknown) => {
      if (typeof caseId === 'string') void socket.leave(ROOMS.case(caseId));
    });
  });

  const publisher: EventPublisherPort = {
    publish(room, event, payload) {
      io.to(room).emit(event as RunEventName, payload);
    },
  };
  opts.log.info('realtime ready');
  return { io, publisher };
}
