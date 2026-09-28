import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { ROOMS, type RunEventName } from '@payops/shared';
import type { EventPublisherPort, Logger } from '@payops/core';
import { SESSION_COOKIE, readCookie, verifySession, type SessionConfig } from '../auth/session';

/** In-process Socket.IO. Everyone joins the "ops" room; clients join case rooms on demand. */
export function createRealtime(http: HttpServer, opts: { origin: string; log: Logger; session: SessionConfig }) {
  const io = new Server(http, { cors: { origin: opts.origin, credentials: true }, path: '/socket.io' });

  // Only signed-in users get realtime events: the handshake must carry a valid session cookie.
  io.use((socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    void verifySession(token, opts.session).then((user) => {
      if (!user) return next(new Error('UNAUTHENTICATED'));
      socket.data.user = user;
      next();
    });
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
