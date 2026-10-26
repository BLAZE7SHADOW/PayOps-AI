"""Sign-in shapes (packages/shared dto/security.ts and the auth part of dto/api.ts)."""

from __future__ import annotations

import re
from typing import Annotated, Any

from pydantic import AfterValidator, Field, StringConstraints

from .base import CamelModel

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _email(value: str) -> str:
    if not _EMAIL.match(value):
        raise ValueError("Invalid email address")
    return value.lower()


Email = Annotated[str, AfterValidator(_email)]
#: A 6-digit code as typed from an authenticator app; a space in the middle is allowed ("123 456").
OneTimeCode = Annotated[str, StringConstraints(strip_whitespace=True, min_length=6, max_length=8, pattern=r"^\d{3}\s?\d{3}$")]


class LoginBody(CamelModel):
    email: Email
    password: Annotated[str, Field(min_length=1, max_length=200)]


class DemoLoginBody(CamelModel):
    email: Email


class MfaLoginBody(CamelModel):
    #: Short-lived token returned by /auth/login when a code is required.
    challenge: Annotated[str, Field(min_length=1, max_length=2000)]
    code: OneTimeCode


class MfaCodeBody(CamelModel):
    code: OneTimeCode


class MfaChallengeResponse(CamelModel):
    mfa_required: bool
    challenge: str


class MfaSetupResponse(CamelModel):
    #: Base32 seed to type into an authenticator app. Shown once, until the setup is confirmed.
    secret: str
    otpauth_url: str


class SecurityOverview(CamelModel):
    mfa_enabled: bool
    #: MANAGER and ADMIN accounts are expected to turn MFA on; the UI shows a notice until they do.
    mfa_recommended: bool
    sessions: list[dict[str, Any]]


def mfa_recommended_for(role: str) -> bool:
    return role in ("MANAGER", "ADMIN")
