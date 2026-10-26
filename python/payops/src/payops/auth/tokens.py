"""Sessions are a signed JWT (HS256, 8 hours) in an httpOnly cookie. The token carries a session id; the sessions table
decides whether that session is still live (see `sessions.py`). A short-lived MFA challenge token proves only that the
password step passed."""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt

# Existing deployments sign with a JWT_SECRET of 16 or more characters (the TypeScript API only required that), and
# cookies signed with it must keep
# working. PyJWT would warn that HS256 keys under 32 bytes are short; accepting them is deliberate, and settings.py
# still enforces the 16-character minimum.
warnings.filterwarnings("ignore", category=jwt.InsecureKeyLengthWarning)

SESSION_COOKIE = "payops_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
MFA_CHALLENGE_TTL_SECONDS = 5 * 60
ISSUER = "payops"
ROLES = ("VIEWER", "OPS", "MANAGER", "ADMIN")

#: Only for local development and tests. Production refuses to start without JWT_SECRET (settings.py).
DEV_SECRET = "payops-dev-secret-do-not-use-in-production"


@dataclass(frozen=True)
class SessionConfig:
    secret: str
    secure: bool

    @property
    def key(self) -> bytes:
        return self.secret.encode("utf-8")

    @property
    def seal_key(self) -> str:
        """The TOTP seed is encrypted with a key derived from the same secret that signs cookies (base64 of its bytes,
        as the TypeScript API does)."""
        import base64

        return base64.b64encode(self.key).decode()


def session_config(jwt_secret: str | None, node_env: str) -> SessionConfig:
    return SessionConfig(secret=jwt_secret or DEV_SECRET, secure=node_env == "production")


@dataclass(frozen=True)
class SessionClaims:
    user_id: str
    role: str
    name: str
    email: str
    session_id: str


def _encode(claims: dict[str, Any], subject: str, ttl: int, config: SessionConfig, now: datetime) -> str:
    issued = int(now.timestamp())
    body = {**claims, "sub": subject, "iss": ISSUER, "iat": issued, "exp": issued + ttl}
    return jwt.encode(body, config.key, algorithm="HS256", headers={"typ": None})


def sign_session(
    user_id: str, role: str, name: str, email: str, session_id: str, config: SessionConfig, now: datetime | None = None
) -> str:
    return _encode(
        {"role": role, "name": name, "email": email, "sid": session_id},
        user_id,
        SESSION_TTL_SECONDS,
        config,
        now or datetime.now(UTC),
    )


def verify_session(token: str | None, config: SessionConfig, now: datetime | None = None) -> SessionClaims | None:
    """The claims, or None for a missing, expired, tampered or malformed token."""
    if not token:
        return None
    try:
        payload = _decode(token, config, now)
    except jwt.PyJWTError:
        return None
    sub, role, name, email, sid = (payload.get(k) for k in ("sub", "role", "name", "email", "sid"))
    if (
        not isinstance(sub, str)
        or role not in ROLES
        or not isinstance(name, str)
        or not isinstance(email, str)
        or not isinstance(sid, str)
        or not sid
    ):
        return None
    return SessionClaims(sub, role, name, email, sid)


def _decode(token: str, config: SessionConfig, now: datetime | None) -> dict[str, Any]:
    # `now` lets tests (and the fixed clock) decide what "expired" means; PyJWT reads the wall clock otherwise.
    options: Any = {"verify_exp": now is None, "verify_iat": now is None, "require": ["exp", "iss", "sub"]}
    payload: dict[str, Any] = jwt.decode(token, config.key, algorithms=["HS256"], issuer=ISSUER, options=options)
    if now is not None and payload["exp"] <= now.timestamp():
        raise jwt.ExpiredSignatureError("expired")
    return payload


def sign_mfa_challenge(user_id: str, config: SessionConfig, now: datetime | None = None) -> str:
    return _encode({"purpose": "mfa"}, user_id, MFA_CHALLENGE_TTL_SECONDS, config, now or datetime.now(UTC))


def verify_mfa_challenge(token: str, config: SessionConfig, now: datetime | None = None) -> str | None:
    """The user id the challenge was issued for, or None if it is invalid, expired or not a challenge."""
    try:
        payload = _decode(token, config, now)
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    return sub if payload.get("purpose") == "mfa" and isinstance(sub, str) else None


def session_expiry(now: datetime) -> datetime:
    return now + timedelta(seconds=SESSION_TTL_SECONDS)
