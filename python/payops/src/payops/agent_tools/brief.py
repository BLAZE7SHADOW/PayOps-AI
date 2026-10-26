"""The code-computed CaseBrief fed to J6 and, on the full path, the LLM (docs/03 §4a, §8)."""

from __future__ import annotations

from typing import Any

from ..domain.actions.types import CaseState
from ..domain.money import amount_band


def build_case_brief(state: CaseState) -> dict[str, Any]:
    c = state.case
    return {
        "caseId": c.id,
        "displayId": c.display_id,
        "type": c.type,
        "detectionRuleIds": c.rule_ids,
        "amountBand": amount_band(c.amount_minor),
        "mismatchedSystems": c.mismatched,
        "flags": {
            "hasRefund": len(state.order.refunds) > 0 if state.order else False,
            "hasSettlementBatch": state.batch is not None,
            "isDuplicate": c.type == "DUPLICATE",
            "quarantinedText": (c.signals or {}).get("quarantined") is True,
        },
    }
