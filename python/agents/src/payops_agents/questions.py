"""Jev question builders (the `choice`, `noul` and `score` helpers of @typesafe-ai/sdk 0.6.0).

They return plain dicts with the same keys as the SDK, because the request body is hashed for REPLAY and
sent to the API as is. `criteria` is left out when absent, as `JSON.stringify` leaves out `undefined`.
"""

from __future__ import annotations

from typing import Any

Question = dict[str, Any]


def choice(instructions: str | None, criteria: dict[str, str | None]) -> Question:
    return {"type": "choice", "instructions": instructions, "criteria": criteria}


def noul(instructions: str | None = None) -> Question:
    return {"type": "noul", "instructions": instructions}


def score(instructions: str | None, criteria: list[str | None]) -> Question:
    if len(criteria) < 2:
        raise ValueError("a score question needs at least two criteria")
    return {"type": "score", "instructions": instructions, "criteria": criteria}
