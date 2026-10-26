"""Sign-in and account security: password and demo sign-in, one-time codes, enrolment, session revocation. The routes only set and clear the cookie; every
rule lives here. (apps/server routes/auth.ts)"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..auth.demo_users import DEMO_ACCOUNTS, is_demo_email
from ..auth.password import verify_password
from ..auth.rate_limit import RateLimiter
from ..auth.secret_box import open_secret, seal_secret
from ..auth.sessions import SessionStore
from ..auth.tokens import SessionConfig, sign_mfa_challenge, sign_session, verify_mfa_challenge
from ..auth.totp import generate_totp_secret, otpauth_url, verify_totp
from ..db.engine import transaction
from ..db.models import User
from ..dto.security import MfaSetupResponse, SecurityOverview, mfa_recommended_for
from ..errors import AppError
from ..ports import Clock
from .audit import AuditInput, AuditService

BAD_CREDENTIALS = "Email or password is incorrect"
BAD_CODE = "That code is not correct or has already been used"
TOO_MANY_LOGINS = "Too many sign-in attempts. Try again in a minute."
TOO_MANY_CODES = "Too many incorrect codes. Try again in a few minutes."
ISSUER = "PayOps AI"
#: A hash of the right shape that never matches, so an unknown email costs the same as a wrong password.
_DECOY_HASH = "scrypt$AAAA$AAAA"


@dataclass(frozen=True)
class SignedIn:
    """A new session: the cookie value and the user it is for."""

    token: str
    user: dict[str, str]


@dataclass(frozen=True)
class MfaRequired:
    challenge: str


class AuthService:
    def __init__(
        self, sessions: async_sessionmaker[AsyncSession], clock: Clock, audit: AuditService, store: SessionStore, limiter: RateLimiter, config: SessionConfig,
        demo_mode: bool,
    ) -> None:
        self._sessions = sessions
        self._clock = clock
        self._audit = audit
        self._store = store
        self._limiter = limiter
        self._config = config
        self._demo_mode = demo_mode

    # ── Sign in ──────────────────────────────────────────────────────────────
    @staticmethod
    def _session_user(u: User) -> dict[str, str]:
        return {"id": u.id, "email": u.email, "name": u.name, "role": u.role}

    async def _start_session(self, s: AsyncSession, user: User, ip: str, user_agent: str, mfa_verified: bool) -> SignedIn:
        session_id = await self._store.create(s, user_id=user.id, ip=ip, user_agent=user_agent, mfa_verified=mfa_verified)
        token = sign_session(user.id, user.role, user.name, user.email, session_id, self._config, self._clock.now())
        return SignedIn(token, self._session_user(user))

    async def _after_password(self, s: AsyncSession, user: User, ip: str, user_agent: str) -> SignedIn | MfaRequired:
        """Sign in, or ask for a one-time code if the user turned MFA on."""
        if user.totp_enabled_at and user.totp_secret_sealed:
            return MfaRequired(sign_mfa_challenge(user.id, self._config, self._clock.now()))
        return await self._start_session(s, user, ip, user_agent, False)

    async def login(self, email: str, password: str, ip: str, user_agent: str) -> SignedIn | MfaRequired:
        await self._limiter.hit(f"login:{ip}|{email}", 10, 60_000, TOO_MANY_LOGINS)
        async with transaction(self._sessions) as s:
            user = (await s.scalars(select(User).where(User.email == email))).one_or_none()
            # Same message and a real hash check either way, so the response does not reveal which emails exist.
            ok = verify_password(password, user.password_hash if user else _DECOY_HASH)
            if user is None or not ok:
                raise AppError("UNAUTHENTICATED", BAD_CREDENTIALS)
            return await self._after_password(s, user, ip, user_agent)

    async def login_mfa(self, challenge: str, code: str, ip: str, user_agent: str) -> SignedIn:
        user_id = verify_mfa_challenge(challenge, self._config, self._clock.now())
        if user_id is None:
            raise AppError("UNAUTHENTICATED", "Sign in again: the code step expired")
        await self._limiter.hit(f"mfa:{user_id}", 5, 5 * 60_000, TOO_MANY_CODES)
        async with transaction(self._sessions) as s:
            user = await s.get(User, user_id)
            if user is None or not await self._check_code(s, user, code):
                raise AppError("UNAUTHENTICATED", BAD_CODE)
            signed_in = await self._start_session(s, user, ip, user_agent, True)
        await self._limiter.clear(f"mfa:{user_id}")
        return signed_in

    async def demo_login(self, email: str, ip: str, user_agent: str) -> SignedIn | MfaRequired:
        if not self._demo_mode:
            raise AppError("NOT_FOUND", "Demo sign-in is disabled")
        async with transaction(self._sessions) as s:
            user = (await s.scalars(select(User).where(User.email == email))).one_or_none() if is_demo_email(email) else None
            if user is None:
                raise AppError("UNAUTHENTICATED", "Not a demo account")
            # A demo account that turned MFA on is asked for its code like any other account.
            return await self._after_password(s, user, ip, user_agent)

    def demo_accounts(self) -> list[dict[str, str]]:
        return [{"email": a.email, "name": a.name, "role": a.role, "label": a.label} for a in DEMO_ACCOUNTS] if self._demo_mode else []

    async def logout(self, session_id: str | None) -> None:
        if session_id:
            async with transaction(self._sessions) as s:
                await self._store.revoke(s, session_id)

    # ── One-time codes ───────────────────────────────────────────────────────
    async def _check_code(self, s: AsyncSession, user: User, code: str, *, pending: bool = False) -> bool:
        """Checks a code against the user's seed. A code is accepted once: the step it matched is stored with a conditional update, so two requests racing with
        the same code cannot both succeed. `pending` allows checking the seed of a setup that is not switched on yet."""
        if not user.totp_secret_sealed or (not pending and not user.totp_enabled_at):
            return False
        secret = open_secret(user.totp_secret_sealed, self._config.seal_key)
        if secret is None:
            return False
        step = verify_totp(secret, code, self._clock.now().timestamp() * 1000, user.totp_last_step)
        if step is None:
            return False
        claimed = (
            await s.execute(
                update(User)
                .where(User.id == user.id, or_(User.totp_last_step.is_(None), User.totp_last_step < step))
                .values(totp_last_step=step)
                .returning(User.id)
            )
        ).all()
        return bool(claimed)

    # ── Enrolment ────────────────────────────────────────────────────────────
    async def security_overview(self, s: AsyncSession, user_id: str, role: str, current_session: str | None) -> SecurityOverview:
        user = await s.get(User, user_id)
        return SecurityOverview(
            mfa_enabled=bool(user and user.totp_enabled_at), mfa_recommended=mfa_recommended_for(role),
            sessions=await self._store.list_active(s, user_id, current_session),
        )

    async def mfa_setup(self, user_id: str) -> MfaSetupResponse:
        async with transaction(self._sessions) as s:
            user = await s.get(User, user_id)
            if user is None:
                raise AppError("UNAUTHENTICATED", "Not signed in")
            if user.totp_enabled_at:
                raise AppError("CONFLICT", "MFA is already on. Turn it off first to enrol a new device.")
            # Calling setup again replaces an unconfirmed seed, so a lost QR code is not a dead end.
            secret = generate_totp_secret()
            user.totp_secret_sealed, user.totp_last_step = seal_secret(secret, self._config.seal_key), None
            return MfaSetupResponse(secret=secret, otpauth_url=otpauth_url(secret, user.email, ISSUER))

    async def mfa_enable(self, user_id: str, name: str, code: str, keep_session: str | None) -> dict[str, object]:
        await self._limiter.hit(f"mfa:{user_id}", 5, 5 * 60_000, TOO_MANY_CODES)
        async with transaction(self._sessions) as s:
            user = await s.get(User, user_id)
            if user is None or not user.totp_secret_sealed:
                raise AppError("CONFLICT", "Start MFA setup first")
            if user.totp_enabled_at:
                raise AppError("CONFLICT", "MFA is already on")
            if not await self._check_code(s, user, code, pending=True):
                raise AppError("VALIDATION_FAILED", BAD_CODE)
            user.totp_enabled_at = self._clock.now()
            # Other browsers signed in without a code are signed out now that a code is required.
            revoked = await self._store.revoke_all_for(s, user_id, keep_session)
            await self._audit.record(
                s, AuditInput("USER", user_id, name, "auth.mfa_enabled", "user", user_id, f"{name} turned on MFA ({revoked} other sessions signed out)")
            )
        return {"mfaEnabled": True, "otherSessionsRevoked": revoked}

    async def mfa_disable(self, user_id: str, name: str, code: str) -> dict[str, object]:
        await self._limiter.hit(f"mfa:{user_id}", 5, 5 * 60_000, TOO_MANY_CODES)
        async with transaction(self._sessions) as s:
            user = await s.get(User, user_id)
            if user is None or not user.totp_enabled_at:
                raise AppError("CONFLICT", "MFA is not on")
            if not await self._check_code(s, user, code):
                raise AppError("VALIDATION_FAILED", BAD_CODE)
            user.totp_secret_sealed = user.totp_enabled_at = user.totp_last_step = None
            await self._audit.record(s, AuditInput("USER", user_id, name, "auth.mfa_disabled", "user", user_id, f"{name} turned off MFA"))
        return {"mfaEnabled": False}

    async def mfa_reset(self, admin_id: str, admin_name: str, target_id: str) -> dict[str, object]:
        """Lost phone: an admin switches MFA off for that user and signs them out everywhere."""
        async with transaction(self._sessions) as s:
            target = await s.get(User, target_id)
            if target is None:
                raise AppError("NOT_FOUND", "User not found")
            target.totp_secret_sealed = target.totp_enabled_at = target.totp_last_step = None
            revoked = await self._store.revoke_all_for(s, target_id)
            await self._audit.record(
                s,
                AuditInput(
                    "USER", admin_id, admin_name, "auth.mfa_reset", "user", target_id, f"{admin_name} reset MFA for {target.name} ({revoked} sessions signed out)"
                ),
            )
        return {"mfaEnabled": False, "sessionsRevoked": revoked}

    # ── Sessions ─────────────────────────────────────────────────────────────
    async def revoke_others(self, user_id: str, name: str, current: str | None) -> dict[str, int]:
        async with transaction(self._sessions) as s:
            revoked = await self._store.revoke_all_for(s, user_id, current)
            if revoked > 0:
                await self._audit.record(
                    s, AuditInput("USER", user_id, name, "auth.sessions_revoked", "user", user_id, f"{name} signed out {revoked} other sessions")
                )
        return {"revoked": revoked}

    async def revoke_session(self, user_id: str, name: str, role: str, session_id: str) -> bool:
        async with transaction(self._sessions) as s:
            owner = await self._store.owner_of(s, session_id)
            # Someone else's session looks like a missing one, so ids cannot be probed.
            if owner is None or (owner != user_id and role != "ADMIN"):
                raise AppError("NOT_FOUND", "Session not found")
            revoked = await self._store.revoke(s, session_id)
            if revoked:
                summary = f"{name} signed out a session" if owner == user_id else f"{name} signed out a session of another user"
                await self._audit.record(s, AuditInput("USER", user_id, name, "auth.session_revoked", "user", owner, summary))
        return revoked

    async def revoke_all_of_user(self, admin_id: str, admin_name: str, target_id: str) -> dict[str, int]:
        async with transaction(self._sessions) as s:
            target = await s.get(User, target_id)
            if target is None:
                raise AppError("NOT_FOUND", "User not found")
            revoked = await self._store.revoke_all_for(s, target_id)
            await self._audit.record(
                s, AuditInput("USER", admin_id, admin_name, "auth.sessions_revoked", "user", target_id, f"{admin_name} signed out {revoked} sessions of {target.name}")
            )
        return {"revoked": revoked}
