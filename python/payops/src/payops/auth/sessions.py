"""Server-side record of every signed-in browser. The cookie holds a signed JWT with a session id; a request is only
accepted while that row exists, is not revoked and has not expired. That is what makes "sign out everywhere" and "revoke
this device" work, which a JWT alone cannot."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Session, User
from ..domain.timeutil import to_iso
from ..ports import Clock
from .tokens import session_expiry

#: last_seen_at is refreshed at most this often, so a busy page does not write on every request.
TOUCH_INTERVAL_SECONDS = 60


@dataclass(frozen=True)
class ActiveSession:
    id: str
    user_id: str
    email: str
    name: str
    role: str
    mfa_verified: bool


class SessionStore:
    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._revoked_listeners: list[Callable[[list[str]], None]] = []

    def on_revoked(self, listener: Callable[[list[str]], None]) -> None:
        """Called with the ids of sessions just revoked, for example to close their live sockets."""
        self._revoked_listeners.append(listener)

    def _notify_revoked(self, ids: list[str]) -> None:
        if ids:
            for listener in self._revoked_listeners:
                listener(ids)

    async def create(self, session: AsyncSession, *, user_id: str, ip: str, user_agent: str, mfa_verified: bool) -> str:
        now = self._clock.now()
        session_id = f"ses_{uuid.uuid4()}"
        session.add(
            Session(
                id=session_id,
                user_id=user_id,
                created_at=now,
                last_seen_at=now,
                expires_at=session_expiry(now),
                ip=ip[:64],
                user_agent=user_agent[:300],
                mfa_verified=mfa_verified,
                revoked_at=None,
            )
        )
        await session.flush()
        return session_id

    async def resolve(self, session: AsyncSession, session_id: str, user_id: str) -> ActiveSession | None:
        """The session and its user as they are now (role and name come from the users table, so a role change applies
        at once), or None if it is unknown, revoked, expired or belongs to someone else."""
        now = self._clock.now()
        row = (
            await session.execute(
                select(Session, User)
                .join(User, User.id == Session.user_id)
                .where(
                    and_(
                        Session.id == session_id,
                        Session.user_id == user_id,
                        Session.revoked_at.is_(None),
                        Session.expires_at > now,
                    )
                )
            )
        ).first()
        if row is None:
            return None
        stored, user = row
        if (now - stored.last_seen_at).total_seconds() > TOUCH_INTERVAL_SECONDS:
            await session.execute(update(Session).where(Session.id == session_id).values(last_seen_at=now))
        return ActiveSession(session_id, user.id, user.email, user.name, user.role, stored.mfa_verified)

    async def list_active(self, session: AsyncSession, user_id: str, current_id: str | None) -> list[dict[str, object]]:
        live = and_(Session.user_id == user_id, Session.revoked_at.is_(None), Session.expires_at > self._clock.now())
        rows = (await session.scalars(select(Session).where(live).order_by(Session.created_at))).all()
        return [
            {
                "id": r.id,
                "createdAt": to_iso(r.created_at),
                "lastSeenAt": to_iso(r.last_seen_at),
                "expiresAt": to_iso(r.expires_at),
                "ip": r.ip,
                "userAgent": r.user_agent,
                "mfaVerified": r.mfa_verified,
                "current": r.id == current_id,
            }
            for r in rows
        ]

    async def owner_of(self, session: AsyncSession, session_id: str) -> str | None:
        """Owner of a session, or None if it does not exist. Used to check who may revoke it."""
        return (await session.scalars(select(Session.user_id).where(Session.id == session_id))).first()

    async def revoke(self, session: AsyncSession, session_id: str) -> bool:
        """True if a live session was revoked."""
        rows = (
            await session.execute(
                update(Session)
                .where(Session.id == session_id, Session.revoked_at.is_(None))
                .values(revoked_at=self._clock.now())
                .returning(Session.id)
            )
        ).all()
        self._notify_revoked([r[0] for r in rows])
        return bool(rows)

    async def revoke_all_for(self, session: AsyncSession, user_id: str, keep_id: str | None = None) -> int:
        """Revokes every live session of a user except `keep_id`. Returns how many were revoked."""
        conditions = [Session.user_id == user_id, Session.revoked_at.is_(None)]
        if keep_id:
            conditions.append(Session.id != keep_id)
        rows = (
            await session.execute(
                update(Session).where(*conditions).values(revoked_at=self._clock.now()).returning(Session.id)
            )
        ).all()
        self._notify_revoked([r[0] for r in rows])
        return len(rows)
