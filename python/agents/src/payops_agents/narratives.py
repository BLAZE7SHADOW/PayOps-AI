"""Evidence-citing narrative templates for the fast path and for code corrections (packages/agents templates.ts).

The action templates in templates.ts (`templateActions`) run in the TypeScript API, through `/internal/agent/proposal`,
because they use the core's action options for the concrete case. Only the narrative text is built here.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .shapes import Evidence
from .text import format_money


def _find(evidence: Sequence[Evidence], predicate: Any) -> Evidence | None:
    return next((e for e in evidence if predicate(e)), None)


def _js_number(value: Any) -> float:
    """`Number(value)` for facts that are numbers, numeric strings or missing."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _text(value: Any) -> str:
    """Template-literal interpolation of a fact value."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value)


def narrative_for(root_cause: str, evidence: Sequence[Evidence]) -> dict[str, Any]:
    if root_cause == "WEBHOOK_PROCESSING_FAILURE":
        w = _find(evidence, lambda e: e["system"] == "WEBHOOK" and _js_number(e["facts"].get("lastHttpStatus")) >= 500)
        if w:
            text = f"The captured webhook failed with HTTP {_text(w['facts']['lastHttpStatus'])} after {_text(w['facts']['attempts'])} attempt(s) [{w['id']}]."
            return {"text": text, "citedIds": [w["id"]]}
        return {"text": "The webhook delivery for this capture did not process cleanly.", "citedIds": []}
    if root_cause == "WEBHOOK_NOT_DELIVERED":
        w = _find(evidence, lambda e: e["system"] == "WEBHOOK" and e["facts"].get("finalStatus") != "DELIVERED")
        if w:
            return {
                "text": f"The webhook for this payment was never delivered (status {_text(w['facts']['finalStatus'])}) [{w['id']}].",
                "citedIds": [w["id"]],
            }
        return {"text": "A webhook event for this payment was not delivered.", "citedIds": []}
    if root_cause == "ORDER_STATE_DIVERGED":
        g = _find(evidence, lambda e: e["system"] == "GATEWAY")
        o = _find(evidence, lambda e: e["system"] == "ORDER")
        ids = [x["id"] for x in (g, o) if x]
        gs = _text(g["facts"]["status"]) if g and g["facts"].get("status") is not None else "captured"
        os_ = _text(o["facts"]["status"]) if o and o["facts"].get("status") is not None else "not paid"
        return {
            "text": f"The gateway shows this payment as {gs} but the order is {os_} [{', '.join(ids)}].",
            "citedIds": ids,
        }
    if root_cause == "LEDGER_POSTING_MISSING":
        g = _find(evidence, lambda e: e["system"] == "GATEWAY")
        ids = [g["id"]] if g else []
        amount = _js_number(g["facts"].get("amountMinor", 0)) if g else 0
        suffix = f" [{ids[0]}]" if ids else ""
        return {
            "text": f"The gateway captured {format_money(amount)} but no ledger credit was posted for it{suffix}.",
            "citedIds": ids,
        }
    if root_cause == "DUPLICATE_CAPTURE":
        gw = [e for e in evidence if e["system"] == "GATEWAY" and e["facts"].get("status") == "CAPTURED"]
        ids = [g["id"] for g in gw]
        return {
            "text": f"More than one capture exists for this order [{', '.join(ids)}]; the extra capture needs a refund.",
            "citedIds": ids,
        }
    if root_cause == "REFUND_STATUS_NOT_SYNCED":
        r = _find(evidence, lambda e: e["system"] == "REFUND" and e["source"] == "getRefundGatewayStatus")
        ids = [r["id"]] if r else []
        status = _text(r["facts"]["status"]) if r and r["facts"].get("status") is not None else "processed"
        suffix = f" [{ids[0]}]" if ids else ""
        return {
            "text": f"The gateway refund is {status} but our record has not been updated to match{suffix}.",
            "citedIds": ids,
        }
    if root_cause == "REFUND_NOT_INITIATED":
        o = _find(evidence, lambda e: e["system"] == "ORDER" and e["facts"].get("status") == "CANCELLED")
        ids = [o["id"]] if o else []
        suffix = f" [{ids[0]}]" if ids else ""
        return {
            "text": f"The order was cancelled after capture but no refund has been initiated{suffix}.",
            "citedIds": ids,
        }
    if root_cause == "REFUND_FAILED_AT_GATEWAY":
        r = _find(evidence, lambda e: e["system"] == "REFUND" and e["facts"].get("status") == "FAILED")
        ids = [r["id"]] if r else []
        suffix = f" [{ids[0]}]" if ids else ""
        return {"text": f"The refund failed at the gateway{suffix} and needs a person to review it.", "citedIds": ids}
    if root_cause in ("SETTLEMENT_FEE_MISMATCH", "SETTLEMENT_LINE_MISSING"):
        s = _find(evidence, lambda e: e["system"] == "SETTLEMENT" and e["source"] == "getFeeBreakdown")
        ids = [s["id"]] if s else []
        suffix = f" [{ids[0]}]" if ids else ""
        return {
            "text": f"The settlement batch's reported net differs from what the ledger expects{suffix}.",
            "citedIds": ids,
        }
    if root_cause == "SUSPECTED_FRAUD":
        return {
            "text": "The velocity and capture pattern on this payment looks unusual and needs a risk review.",
            "citedIds": [],
        }
    return {
        "text": "The evidence gathered does not point to one clear cause; this needs a person to review.",
        "citedIds": [],
    }
