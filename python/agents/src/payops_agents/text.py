"""Money formatting and PII scrubbing, ported from packages/shared (money.ts, mask.ts)."""

from __future__ import annotations

import re

# `re.ASCII` keeps `\w` and `\d` as narrow as in JavaScript.
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.ASCII)
_PHONE = re.compile(r"(?<![\w.])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)", re.ASCII)
_LONG_DIGITS = re.compile(r"(?<![\w.])\d(?:[\s-]?\d){11,18}(?!\d)", re.ASCII)


def scrub_pii_text(text: str) -> str:
    text = _EMAIL.sub("[email removed]", text)
    text = _PHONE.sub("[phone removed]", text)
    return _LONG_DIGITS.sub("[number removed]", text)


def _indian_group(whole: int) -> str:
    digits = str(whole)
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return ",".join([*groups, tail])


def format_money(minor: int | float) -> str:
    """`"₹12,499.00"` with Indian digit grouping (shared/money.ts `formatMoney`)."""
    if isinstance(minor, bool) or int(minor) != minor or abs(minor) > 2**53 - 1:
        raise TypeError(f"amount must be an integer number of paise, got {minor}")
    minor = int(minor)
    sign = "-" if minor < 0 else ""
    rupees, paise = divmod(abs(minor), 100)
    return f"{sign}₹{_indian_group(rupees)}.{paise:02d}"
