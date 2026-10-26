"""Shapes produced by the action handlers and the validator."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from .actions import CatalogAction
from .base import CamelModel

ValidationVerdict = Literal["PASS", "PARTIAL", "FAIL"]


class ValidationCheck(CamelModel):
    id: str
    #: For example "order.status".
    subject: str
    description: str
    expected: str
    actual: str
    #: The wire name is `pass`, which is a Python keyword.
    passed: bool = Field(alias="pass")
    #: A postcondition of a specific action, or a global invariant of the case.
    kind: Literal["POSTCONDITION", "INVARIANT"]
    action_index: int | None = None


class PreconditionFailure(CamelModel):
    action_index: int
    type: str
    message: str


class ActionOption(CamelModel):
    type: str
    #: Prefilled, valid parameters for this case.
    action: CatalogAction
    #: One line, specific to the case, for example "Replay payment.captured (evt_...) to our webhook consumer".
    summary: str
    recommended: bool
    available: bool
    unavailable_reason: str | None = None
    editable: list[Literal["amountMinor", "reason"]]
    #: Upper bound for editable amounts, for example the refundable balance.
    max_amount_minor: int | None = None
