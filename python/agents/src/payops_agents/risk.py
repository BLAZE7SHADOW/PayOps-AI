"""J3 risk composite: signals, buckets, weights and the rules-only fallback (packages/agents risk.ts,
risk.weights.ts)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .constants import RISK_TIERS_AGENT

RISK_WEIGHTS = {"velocity_abuse": 0.3, "identity_mismatch": 0.25, "chargeback_pattern": 0.25, "merchant_exposure": 0.2}

_TIER_THRESHOLDS = [(0.75, "LOW"), (1.5, "MEDIUM"), (2.25, "HIGH"), (float("inf"), "CRITICAL")]


def tier_for_composite(composite: float) -> str:
    return next(tier for max_value, tier in _TIER_THRESHOLDS if composite <= max_value)


def raise_tier_by_one(tier: str) -> str:
    i = RISK_TIERS_AGENT.index(tier)
    return RISK_TIERS_AGENT[min(i + 1, len(RISK_TIERS_AGENT) - 1)]


def combine_risk_scores(scores: Mapping[str, float], mean_confidence: float) -> dict[str, Any]:
    composite = sum(RISK_WEIGHTS[name] * scores[name] for name in RISK_WEIGHTS)
    tier = tier_for_composite(composite)
    if mean_confidence < 0.5:
        tier = raise_tier_by_one(tier)
    return {"tier": tier, "scores": scores, "meanConfidence": mean_confidence}


def _facts_of(evidence: list[dict[str, Any]], source: str) -> dict[str, Any]:
    return next((e["facts"] for e in evidence if e["source"] == source), {})


def _number(value: Any, default: float) -> float:
    """JavaScript's `Number(x ?? default)` for the values these facts hold."""
    if value is None:
        return default
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def extract_risk_signals(evidence: list[dict[str, Any]]) -> dict[str, Any]:
    history = _facts_of(evidence, "getCustomerHistory")
    device = _facts_of(evidence, "getDeviceSignals")
    attempts = _facts_of(evidence, "getFailedAttempts")
    chargebacks = _facts_of(evidence, "getChargebackHistory")
    return {
        "accountAgeDays": _number(history.get("accountAgeDays"), 3650),
        "riskFlagsCount": _number(history.get("riskFlagsCount"), 0),
        "failed24h": _number(attempts.get("failed24h"), 0),
        "total24h": _number(attempts.get("total24h"), 0),
        "cardCountriesDistinct": _number(device.get("cardCountriesDistinct"), 0),
        "deviceCount": _number(device.get("deviceCount"), 0),
        "ipCardCountryMismatch": bool(device.get("ipCardCountryMismatch", False)),
        "merchantDisputeCount": _number(chargebacks.get("merchantDisputeCount"), 0),
    }


def _count_bucket(n: float, edges: list[tuple[int, str]], over_label: str) -> str:
    for max_value, label in edges:
        if n <= max_value:
            return label
    return over_label


def _js_round(x: float) -> int:
    """`Math.round`: halves go up."""
    import math

    return math.floor(x + 0.5)


def bucket_risk_signals(s: dict[str, Any]) -> dict[str, Any]:
    age_hours = s["accountAgeDays"] * 24
    if age_hours < 24:
        account_age = f"created {max(1, _js_round(age_hours))} hours ago"
    elif s["accountAgeDays"] < 7:
        account_age = "1 to 7 days old"
    elif s["accountAgeDays"] < 30:
        account_age = "7 to 30 days old"
    else:
        account_age = "over 30 days old"
    flags = s["riskFlagsCount"]
    flag_count = int(flags)
    return {
        "account_age": account_age,
        "failed_attempts_24h_bucket": _count_bucket(
            s["failed24h"], [(0, "0"), (2, "1-2"), (5, "3-5"), (10, "6-10")], "10+"
        ),
        "card_countries": f"{int(s['cardCountriesDistinct'])} distinct",
        "device_count": f"{int(s['deviceCount'])} distinct",
        "ip_card_country_mismatch": s["ipCardCountryMismatch"],
        "risk_flags": "none" if flags == 0 else "1 flag" if flags == 1 else f"{flag_count} flags",
        "merchant_dispute_exposure": _count_bucket(s["merchantDisputeCount"], [(0, "0"), (2, "1-2")], "3+"),
    }


RISK_SCORE_CRITERIA: dict[str, list[str]] = {
    "velocity_abuse": [
        "Few or no failed attempts, on the usual device.",
        "A handful of failed attempts or a second device, within normal variation.",
        "Several failed attempts across more than one device or card in a short window.",
        "Many failed attempts across several devices and cards in a short window — looks automated.",
    ],
    "identity_mismatch": [
        "Established account, one card country, device IP matches the card country.",
        "A newer account, or one minor mismatch, nothing else unusual.",
        "A very new account combined with a device/card country mismatch.",
        "A brand-new account, multiple card countries and a device/card country mismatch together.",
    ],
    "chargeback_pattern": [
        "No risk flags recorded for this customer.",
        "One risk flag recorded, no other signal reinforcing it.",
        "One risk flag recorded alongside other risk signals on this payment.",
        "Multiple risk flags recorded for this customer.",
    ],
    "merchant_exposure": [
        "No settlement disputes recorded for this merchant recently.",
        "One or two settlement disputes recorded for this merchant recently.",
        "Several settlement disputes recorded for this merchant recently.",
        "A high number of settlement disputes recorded for this merchant recently.",
    ],
}


def rules_only_risk_tier(s: dict[str, Any]) -> dict[str, Any]:
    """J3 fallback when Jev fails: fixed conservative rules over the raw signals, no model."""
    f, d = s["failed24h"], s["deviceCount"]
    age, mism = s["accountAgeDays"], s["ipCardCountryMismatch"]
    countries, flags, disputes = s["cardCountriesDistinct"], s["riskFlagsCount"], s["merchantDisputeCount"]
    velocity = 3 if f >= 6 or d >= 3 else 2 if f >= 3 or d >= 2 else 1 if f >= 1 else 0
    identity = 3 if age < 1 and (countries >= 2 or mism) else 2 if age < 1 else 1 if mism else 0
    chargeback = 3 if flags >= 2 else 2 if flags == 1 else 0
    exposure = 2 if disputes >= 3 else 1 if disputes >= 1 else 0
    worst = tier_for_composite(max(velocity, identity, chargeback, exposure))
    return {
        "tier": worst,
        "scores": {
            "velocity_abuse": 3 if f >= 6 else 2 if f >= 3 else 1 if f >= 1 else 0,
            "identity_mismatch": (3 if mism else 2) if age < 1 else 1 if mism else 0,
            "chargeback_pattern": 3 if flags >= 2 else 2 if flags == 1 else 0,
            "merchant_exposure": 2 if disputes >= 3 else 1 if disputes >= 1 else 0,
        },
        "meanConfidence": 0,
    }
