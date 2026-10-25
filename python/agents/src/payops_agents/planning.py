"""J2 routing: which specialists the full path runs (packages/agents planning.ts)."""

from __future__ import annotations

from .constants import AGENT_NAMES

NEED_THRESHOLD = 0.35
CONFIDENCE_FLOOR = 0.5


def _mandatory(amount_band: str) -> list[str]:
    mandatory = ["payment"]
    if amount_band in ("HIGH", "CRITICAL"):
        mandatory.append("risk")
    return mandatory


def choose_plan_specialists(amount_band: str, primary_confidence: float, need_scores: dict[str, float]) -> list[str]:
    # A low-confidence hypothesis means Jev is unsure which trail matters, so run everyone.
    if primary_confidence < CONFIDENCE_FLOOR:
        return list(AGENT_NAMES)
    chosen = set(_mandatory(amount_band))
    for name in AGENT_NAMES:
        if need_scores[name] >= NEED_THRESHOLD:
            chosen.add(name)
    return [name for name in AGENT_NAMES if name in chosen]  # stable order: payment, reconciliation, risk
