import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { ROOMS, type RunEventName } from '@payops/shared';
import type { EventPublisherPort, Logger } from '@payops/core';

/** In-process Socket.IO. Everyone joins the "ops" room; clients join case rooms on demand. */
export function createRealtime(http: HttpServer, opts: { origin: string; log: Logger }) {
  const io = new Server(http, { cors: { origin: opts.origin, credentials: true }, path: '/socket.io' });

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
