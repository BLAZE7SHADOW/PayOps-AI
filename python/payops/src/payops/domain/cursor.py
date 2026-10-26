"""Opaque keyset cursors: base64url JSON of the last row's sort key."""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from typing import Any, TypeVar

from ..errors import AppError
from ..jsonjs import js_dumps

T = TypeVar("T")


def encode_cursor(value: Any) -> str:
    return base64.urlsafe_b64encode(js_dumps(value).encode("utf-8")).rstrip(b"=").decode("ascii")


def decode_cursor(cursor: str | None, is_valid: Callable[[Any], bool]) -> Any | None:
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        parsed = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        if is_valid(parsed):
            return parsed
    except (ValueError, UnicodeError):
        pass
    raise AppError("BAD_REQUEST", "Invalid cursor")


def is_record(value: Any) -> bool:
    return isinstance(value, dict)
