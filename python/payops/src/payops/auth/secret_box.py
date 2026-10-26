"""Encrypts small secrets (the TOTP seed) before they go into the database, so a copy of the table alone does not let
anyone generate codes. AES-256-GCM: the auth tag makes any change to the stored text fail to open. The key is derived
from the server's signing secret."""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _key_from(secret: str) -> bytes:
    return hashlib.sha256(f"payops-secret-box|{secret}".encode()).digest()


def seal_secret(plain: str, secret: str) -> str:
    iv = os.urandom(12)
    sealed = AESGCM(_key_from(secret)).encrypt(iv, plain.encode("utf-8"), None)
    data, tag = sealed[:-16], sealed[-16:]
    return "$".join(
        ["v1", base64.b64encode(iv).decode(), base64.b64encode(data).decode(), base64.b64encode(tag).decode()]
    )


def open_secret(sealed: str, secret: str) -> str | None:
    """The original text, or None when the key is wrong, the value was changed, or it is not ours."""
    parts = sealed.split("$")
    if len(parts) != 4 or parts[0] != "v1" or not all(parts[1:]):
        return None
    try:
        iv, data, tag = (base64.b64decode(p) for p in parts[1:])
        return AESGCM(_key_from(secret)).decrypt(iv, data + tag, None).decode("utf-8")
    except (InvalidTag, ValueError):
        return None
