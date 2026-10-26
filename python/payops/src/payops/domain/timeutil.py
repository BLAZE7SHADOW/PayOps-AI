"""Time constants, coarse labels for dense UIs, and the case SLA clock (packages/shared time.ts and sla.ts).

Code computes due times and overdue flags; models never do date maths.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Final

MINUTE_MS: Final = 60_000
HOUR_MS: Final = 60 * MINUTE_MS
DAY_MS: Final = 24 * HOUR_MS

#: Time an operator has to act on a case, by severity (D067). Wall-clock hours, not business hours.
SLA_HOURS: Final = {"CRITICAL": 4, "HIGH": 8, "MEDIUM": 24, "LOW": 72}


def now_utc() -> datetime:
    return datetime.now(UTC)


def to_iso(moment: datetime) -> str:
    """`Date.prototype.toISOString`: UTC, millisecond precision, a trailing Z."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(text: str) -> datetime:
    return datetime.fromisoformat(text)


def ms_between(later: datetime, earlier: datetime) -> float:
    return (later - earlier).total_seconds() * 1000


def age_label(from_time: datetime, now: datetime) -> str:
    """Coarse age for dense UIs: "now", "4m", "3h", "9d"."""
    ms = ms_between(now, from_time)
    if ms < MINUTE_MS:
        return "now"
    if ms < HOUR_MS:
        return f"{int(ms // MINUTE_MS)}m"
    if ms < DAY_MS:
        return f"{int(ms // HOUR_MS)}h"
    return f"{int(ms // DAY_MS)}d"


def due_label(due: datetime, now: datetime) -> str:
    """ "in 3h" while time remains, "2h late" once past, "due now" inside a minute either way."""
    ms = ms_between(due, now)
    magnitude = abs(ms)
    if magnitude < MINUTE_MS:
        return "due now"
    span = age_label(now - timedelta(milliseconds=magnitude), now)
    return f"in {span}" if ms > 0 else f"{span} late"


def due_at_for(severity: str, opened_at: datetime) -> datetime:
    return opened_at + timedelta(hours=SLA_HOURS[severity])


def is_overdue(due_at: datetime | None, is_open: bool, now: datetime) -> bool:
    """A case is overdue only while it is still open and its due time has passed."""
    return is_open and due_at is not None and due_at < now
