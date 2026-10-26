"""Money helpers. All money is integer paise in fields named `*_minor`; floats never enter money paths and formatting happens only here."""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Final

PAISE_PER_RUPEE: Final = 100
_MAX_SAFE: Final = 2**53 - 1

# Bands from docs/04-data-model.md: LOW < 1,000 <= MEDIUM < 10,000 <= HIGH < 50,000 <= CRITICAL (rupees).
AMOUNT_BAND_THRESHOLDS_MINOR: Final = {"MEDIUM": 1_000_00, "HIGH": 10_000_00, "CRITICAL": 50_000_00}
AMOUNT_BANDS: Final = ("LOW", "MEDIUM", "HIGH", "CRITICAL")

_RUPEES = re.compile(r"^(-)?(\d+)(?:\.(\d{1,2}))?$", re.ASCII)


def assert_minor(value: float, label: str = "amount") -> None:
    if isinstance(value, bool) or int(value) != value or abs(value) > _MAX_SAFE:
        raise TypeError(f"{label} must be an integer number of paise, got {value}")


def to_minor(rupees: str | float) -> int:
    """Parses a rupee amount ("12499", "12,499.5", "₹78,000.00") into paise without float maths.

    A float is first rounded to two places the way JavaScript's `toFixed(2)` does (half up on the exact value).
    """
    if isinstance(rupees, str):
        raw = re.sub(r"[,\s₹]", "", rupees)
    else:
        raw = str(Decimal(rupees).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    match = _RUPEES.match(raw)
    if not match:
        raise TypeError(f"Invalid rupee amount: {rupees}")
    sign, whole, frac = match.groups()
    minor = int(whole) * PAISE_PER_RUPEE + int((frac or "").ljust(2, "0"))
    assert_minor(minor)
    return -minor if sign else minor


def group_indian(whole: int) -> str:
    digits = str(whole)
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    groups: list[str] = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return ",".join([*groups, tail])


def format_money(minor: float, *, symbol: bool = True) -> str:
    """`"₹12,499.00"` with Indian digit grouping."""
    assert_minor(minor)
    minor = int(minor)
    sign = "-" if minor < 0 else ""
    rupees, paise = divmod(abs(minor), PAISE_PER_RUPEE)
    return f"{sign}{'₹' if symbol else ''}{group_indian(rupees)}.{paise:02d}"


def _trim_decimal(n: float) -> str:
    rounded = int(n * 10 + 0.5) / 10  # Math.round: halves go up
    return f"{rounded:.1f}".removesuffix(".0")


def format_money_compact(minor: float) -> str:
    """Compact form for dense UI: ₹4.2 Cr, ₹12.5 L, ₹12,499."""
    assert_minor(minor)
    rupees = int(int(minor) / PAISE_PER_RUPEE)  # truncates toward zero
    sign = "-" if rupees < 0 else ""
    magnitude = abs(rupees)
    if magnitude >= 1_00_00_000:
        return f"{sign}₹{_trim_decimal(magnitude / 1_00_00_000)} Cr"
    if magnitude >= 1_00_000:
        return f"{sign}₹{_trim_decimal(magnitude / 1_00_000)} L"
    return f"{sign}₹{group_indian(magnitude)}"


def amount_band(minor: float) -> str:
    assert_minor(minor)
    magnitude = abs(minor)
    if magnitude >= AMOUNT_BAND_THRESHOLDS_MINOR["CRITICAL"]:
        return "CRITICAL"
    if magnitude >= AMOUNT_BAND_THRESHOLDS_MINOR["HIGH"]:
        return "HIGH"
    if magnitude >= AMOUNT_BAND_THRESHOLDS_MINOR["MEDIUM"]:
        return "MEDIUM"
    return "LOW"


def bps_of(minor: int, bps: int) -> int:
    """Basis-point fee on an amount, rounded half up to the nearest paisa. Integer-only."""
    assert_minor(minor)
    assert_minor(bps, "bps")
    return (minor * bps + 5_000) // 10_000
