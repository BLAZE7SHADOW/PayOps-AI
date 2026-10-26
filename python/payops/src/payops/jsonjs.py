"""JSON text that matches JavaScript's `JSON.stringify` byte for byte.

Cassette keys (cassette.py) are hashes of prompt text and of Jev requests. The recordings were made by
the TypeScript service, so Python has to produce the same bytes, or REPLAY would miss every call.
Python's own `json.dumps` differs from JavaScript in how it prints whole-number floats (`2.0` against
`2`) and in where it switches to exponent notation, so this module serializes by hand.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal
from typing import Any


def js_number(x: int | float) -> str:
    if isinstance(x, bool):  # pragma: no cover - callers handle bools first
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if math.isnan(x) or math.isinf(x):
        return "null"
    if x == 0:
        return "0"
    if x == int(x) and abs(x) < 2**53:
        return str(int(x))
    sign = "-" if x < 0 else ""
    digits_tuple = Decimal(repr(abs(x))).as_tuple()
    digits = "".join(str(d) for d in digits_tuple.digits).rstrip("0") or "0"
    # Position of the decimal point relative to the start of `digits` (JavaScript's `n`).
    point = len("".join(str(d) for d in digits_tuple.digits)) + int(digits_tuple.exponent)
    k = len(digits)
    if k <= point <= 21:
        return sign + digits + "0" * (point - k)
    if 0 < point <= 21:
        return sign + digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return sign + "0." + "0" * (-point) + digits
    exp = point - 1
    exp_text = f"{'+' if exp >= 0 else '-'}{abs(exp)}"
    mantissa = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{sign}{mantissa}e{exp_text}"


def js_dumps(value: Any) -> str:
    """Compact JSON, keys in insertion order, numbers printed the way JavaScript prints them."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(js_dumps(v) for v in value) + "]"
    if isinstance(value, dict):
        return (
            "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + js_dumps(v) for k, v in value.items()) + "}"
        )
    raise TypeError(f"cannot serialize {type(value).__name__}")


def _normalize(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return [_normalize(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalize(value[k]) for k in sorted(value)}
    return value


def utf16_length(text: str) -> int:
    """JavaScript's `string.length`: UTF-16 code units, not code points."""
    return len(text.encode("utf-16-le")) // 2
