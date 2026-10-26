"""State matrix and lifecycle shapes (packages/shared dto/api.ts)."""

from __future__ import annotations

from typing import Literal

from .base import CamelModel

SystemKey = Literal["GATEWAY", "ORDER", "LEDGER", "WEBHOOK", "SETTLEMENT"]
LifecycleSystem = Literal["GATEWAY", "ORDER", "LEDGER", "WEBHOOK", "SETTLEMENT", "REFUND", "RISK"]
LifecycleTone = Literal["neutral", "ok", "warn", "bad"]


class MatrixCell(CamelModel):
    system: SystemKey
    #: Display code, for example CAPTURED, FAILED, MISSING, "HTTP 500".
    status: str | None = None
    amount_minor: int | None = None
    at: str | None = None
    detail: str | None = None
    mismatch: bool = False
    #: The gateway is the reference system for money movement.
    reference: bool = False


class StateMatrix(CamelModel):
    cells: dict[SystemKey, MatrixCell]
    mismatched: list[SystemKey]


class LifecycleEvent(CamelModel):
    at: str
    system: LifecycleSystem
    title: str
    detail: str | None = None
    tone: LifecycleTone
