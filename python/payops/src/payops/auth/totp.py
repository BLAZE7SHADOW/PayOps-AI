"""Time-based one-time passwords (RFC 6238) on the standard library. An authenticator app and this server share a secret; both compute HMAC-SHA1 over
"the number of 30-second steps since 1970" and show the last 6 digits."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import struct
from urllib.parse import quote, urlencode

STEP_SECONDS = 30


def base32_encode(data: bytes) -> str:
    return base64.b32encode(data).decode().rstrip("=")


def base32_decode(text: str) -> bytes:
    clean = re.sub(r"[\s=]", "", text).upper()
    try:
        return base64.b32decode(clean + "=" * (-len(clean) % 8))
    except ValueError as err:
        raise ValueError("Not a base32 string") from err


def generate_totp_secret() -> str:
    """160 random bits, the size RFC 4226 recommends for an HMAC-SHA1 key."""
    return base32_encode(os.urandom(20))


def _step_at(now_ms: float) -> int:
    return int(now_ms // 1000 // STEP_SECONDS)


def _hotp(key: bytes, counter: int, digits: int) -> str:
    """RFC 4226: HMAC-SHA1 of the counter, then dynamic truncation to a few decimal digits."""
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    binary = ((mac[offset] & 0x7F) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
    return str(binary % 10**digits).zfill(digits)


def totp_code(secret: str, now_ms: float, digits: int = 6) -> str:
    """The code an authenticator app shows for `secret` at `now_ms`."""
    return _hotp(base32_decode(secret), _step_at(now_ms), digits)


def verify_totp(secret: str, code: str, now_ms: float, last_used_step: int | None = None, window: int = 1) -> int | None:
    """The matching step number (store it as last_used_step), or None when the code is wrong. A step at or before the last used one is refused."""
    digits = re.sub(r"\s", "", code)
    if not re.fullmatch(r"\d{6}", digits):
        return None
    key = base32_decode(secret)
    current = _step_at(now_ms)
    for step in range(current - window, current + window + 1):
        if last_used_step is not None and step <= last_used_step:
            continue
        if hmac.compare_digest(_hotp(key, step, 6), digits):
            return step
    return None


def otpauth_url(secret: str, account: str, issuer: str) -> str:
    label = quote(f"{issuer}:{account}", safe="")
    query = urlencode({"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": "6", "period": str(STEP_SECONDS)})
    return f"otpauth://totp/{label}?{query}"
