"""Rules-only risk tier. Used for every proposal and as the deterministic fallback when Jev J3 is unavailable. It never returns CRITICAL:
that needs more than rules."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from ...dto.policy import RiskTier
from ..money import AMOUNT_BAND_THRESHOLDS_MINOR
from ..reconciliation.facts import is_captured
from ..reconciliation.rules import RULE_THRESHOLDS
from ..snapshot import OrderSnapshot


@dataclass(frozen=True)
class _RiskRules:
    high_min_failed_attempts: int = 5
    high_min_capture_minor: int = AMOUNT_BAND_THRESHOLDS_MINOR["HIGH"]  # ₹10,000
    medium_min_failed_attempts: int = 3


RISK_RULES: Final = _RiskRules()


def failed_attempts_before_capture(s: OrderSnapshot) -> int:
    """Failed attempts by the customer in the 24 hours before the capture (or before now)."""
    end = (s.primary_gw.captured_at if s.primary_gw and s.primary_gw.captured_at else s.now).timestamp() * 1000
    start = end - RULE_THRESHOLDS.risk_window_ms
    return sum(1 for a in s.recent_attempts if a.result == "FAILED" and start <= a.at.timestamp() * 1000 < end)


def risk_tier_from_rules(s: OrderSnapshot | None) -> RiskTier:
    if s is None:
        return "LOW"
    failed = failed_attempts_before_capture(s)
    captured = (s.primary_gw.amount_minor if s.primary_gw else 0) if is_captured(s.primary_gw) else 0
    if failed >= RISK_RULES.high_min_failed_attempts and captured >= RISK_RULES.high_min_capture_minor:
        return "HIGH"
    if failed >= RISK_RULES.medium_min_failed_attempts:
        return "MEDIUM"
    return "LOW"
