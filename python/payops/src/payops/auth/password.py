"""Password hashing with scrypt from the standard library. Stored format: `scrypt$<salt base64>$<hash base64>`, a random 16-byte salt per user."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os

KEY_LENGTH = 64
_N, _R, _P = 16_384, 8, 1


def _derive(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=KEY_LENGTH, maxmem=64 * 1024 * 1024)


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(_derive(password, salt)).decode()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time comparison; malformed hashes simply fail."""
    parts = stored.split("$")
    if len(parts) < 3 or parts[0] != "scrypt" or not parts[1] or not parts[2]:
        return False
    try:
        expected = base64.b64decode(parts[2], validate=False)
        salt = base64.b64decode(parts[1], validate=False)
    except ValueError:
        return False
    if len(expected) != KEY_LENGTH:
        return False
    return hmac.compare_digest(_derive(password, salt), expected)
