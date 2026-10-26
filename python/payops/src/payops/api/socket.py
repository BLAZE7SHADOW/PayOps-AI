"""Realtime over Socket.IO, in the same process as the API. Everyone joins the "ops" room; clients join case rooms on
demand. Only signed-in users connect: the handshake must carry a valid session cookie. A session revoked later loses its
sockets at once. (apps/server realtime/socket.ts)"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from http.cookies import SimpleCookie
from typing import TYPE_CHECKING, Any

import socketio
from socketio.exceptions import ConnectionRefusedError as SocketRefused

from ..auth.tokens import SESSION_COOKIE, SessionConfig, verify_session
from ..realtime import ROOM_OPS, room_case

if TYPE_CHECKING:
    from ..container import Services

log = logging.getLogger("payops.realtime")


def read_cookie(header: str | None, name: str) -> str | None:
    """One cookie out of a raw Cookie header (the Socket.IO handshake carries it in the WSGI-style environ)."""
    if not header:
        return None
    jar: SimpleCookie = SimpleCookie()
    try:
        jar.load(header)
    except Exception:  # noqa: BLE001 - a malformed header is the same as no cookie
        return None
    morsel = jar.get(name)
    return morsel.value if morsel else None


class Realtime:
    def __init__(self, origin: str, session_config: SessionConfig, services: Callable[[], Services]) -> None:
        self.sio = socketio.AsyncServer(
            async_mode="asgi", cors_allowed_origins=[origin], logger=False, engineio_logger=False
        )
        #: Mounted by the app at /socket.io.
        self.asgi = socketio.ASGIApp(self.sio, socketio_path="")
        self._config = session_config
        self._services = services
        self._session_of: dict[str, str] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        self._wire()

    def _wire(self) -> None:
        sio = self.sio

        @sio.event
        async def connect(sid: str, environ: dict[str, Any], auth: Any = None) -> None:
            services = self._services()
            cookie = read_cookie(environ.get("HTTP_COOKIE"), SESSION_COOKIE)
            claims = verify_session(cookie, self._config, services.clock.now())
            active = None
            if claims is not None:
                async with services.sessions() as s:
                    active = await services.session_store.resolve(s, claims.session_id, claims.user_id)
                    await s.commit()
            if active is None:
                raise SocketRefused("UNAUTHENTICATED")
            self._session_of[sid] = active.id
            await sio.enter_room(sid, ROOM_OPS)

        @sio.event
        async def disconnect(sid: str) -> None:
            self._session_of.pop(sid, None)

        @sio.on("case:join")  # type: ignore[misc]
        async def case_join(sid: str, case_id: Any) -> None:
            if isinstance(case_id, str) and len(case_id) <= 64:
                await sio.enter_room(sid, room_case(case_id))

        @sio.on("case:leave")  # type: ignore[misc]
        async def case_leave(sid: str, case_id: Any) -> None:
            if isinstance(case_id, str):
                await sio.leave_room(sid, room_case(case_id))

    def attach_revocations(self) -> None:
        """A revoked session must not keep receiving events over a socket opened before it was revoked."""

        def on_revoked(session_ids: list[str]) -> None:
            for sid, session_id in list(self._session_of.items()):
                if session_id in session_ids:
                    self._spawn(self.sio.disconnect(sid))

        self._services().session_store.on_revoked(on_revoked)

    def _spawn(self, work: Any) -> None:
        task = asyncio.get_running_loop().create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # The EventPublisher the services use.
    def publish(self, room: str, event: str, payload: Any) -> None:
        self._spawn(self.sio.emit(event, payload, room=room))

    async def drain(self) -> None:
        """Waits for events handed to the server. Tests call this."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
