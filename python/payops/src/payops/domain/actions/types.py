"""Action runtime types. Each action type has pure preconditions (plain reasons it cannot run on this data) and pure
postconditions (checks the validator runs on FRESH data afterwards). Execution touches the database and the gateway, so
it lives in the services layer."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ...db.models import Case, Dispute, Merchant, Settlement
from ...dto.validation import ValidationCheck
from ..gateway import GatewaySettlementLine
from ..reconciliation.settlement import BatchCheck
from ..snapshot import OrderSnapshot


@dataclass
class BatchData:
    """A settlement batch with everything D7 and the dispute action need."""

    settlement: Settlement
    lines: Sequence[GatewaySettlementLine]
    merchant: Merchant
    payments_by_gw: dict[str, Any]
    disputes: Sequence[Dispute]


@dataclass
class BatchState:
    data: BatchData
    #: D7 recomputed from the gateway lines and the merchant contract (dispute-aware).
    check: BatchCheck


@dataclass
class CaseState:
    """Everything the handlers may read about a case, loaded fresh in one go."""

    now: datetime
    case: Case
    order: OrderSnapshot | None
    batch: BatchState | None


def postcondition(
    index: int, key: str, *, subject: str, description: str, expected: str, actual: str, passed: bool
) -> ValidationCheck:
    """Builds a postcondition check with a stable id."""
    return ValidationCheck.model_validate(
        {
            "id": f"a{index}.{key}",
            "kind": "POSTCONDITION",
            "actionIndex": index,
            "subject": subject,
            "description": description,
            "expected": expected,
            "actual": actual,
            "pass": passed,
        }
    )
