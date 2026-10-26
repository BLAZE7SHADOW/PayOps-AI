"""Bulk approve (D069). One rule decides which pending approvals may be approved in a batch, so the server and the
Exceptions page agree. Bulk approve is only a shortcut for clicking Approve on each item: every item still goes through
the normal decision path (role, four-eyes, executor, validator). Anything that needs a closer look is left out."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated, Final, Literal

from pydantic import Field, StringConstraints

from ..dto.base import CamelModel

#: Money-moving amount at or below which an OPS-tier proposal may be bulk approved (INR 5,000, in paise).
BULK_APPROVE_MAX_MINOR: Final = 5_000_00
BULK_APPROVE_MAX_ITEMS: Final = 25


@dataclass(frozen=True)
class BulkApproveInput:
    tier: str
    risk_tier: str
    money_moving_minor: int
    rule_ids: Sequence[str]
    action_types: Sequence[str]
    #: The case's customer or merchant notes were quarantined by J1 screening.
    quarantined: bool


def bulk_approve_block_reason(a: BulkApproveInput) -> str | None:
    """Why this approval cannot be part of a bulk approve, or None when it can."""
    if a.tier != "OPS":
        return "Only OPS tier approvals can be approved in bulk."
    if a.risk_tier != "LOW":
        return f"Risk is {a.risk_tier.lower()}, not low. Open the case."
    if a.quarantined:
        return "The case has quarantined notes. Open the case."
    if a.money_moving_minor > BULK_APPROVE_MAX_MINOR:
        return "Amount is over the bulk approve limit. Open the case."
    if "P7" in a.rule_ids:
        return "This is a repeat attempt. Open the case."
    if "P8" in a.rule_ids:
        return "The diagnosis has low confidence. Open the case."
    return None


class BulkApprovalBody(CamelModel):
    ids: Annotated[list[Annotated[str, Field(min_length=1)]], Field(min_length=1, max_length=BULK_APPROVE_MAX_ITEMS)]
    comment: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] = ""


class BulkApprovalResultItem(CamelModel):
    approval_id: str
    display_id: str | None
    outcome: Literal["APPROVED", "SKIPPED", "FAILED"]
    message: str


class BulkApprovalResult(CamelModel):
    approved: int
    skipped: int
    failed: int
    items: list[BulkApprovalResultItem]
