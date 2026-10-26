"""Read-only routes: policy, overview, payments, the case queue and the agent switch."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ...domain.money import format_money
from ...dto.api import AgentControlItem, CaseListItem, CaseListQuery, OverviewMetrics, Page, PaymentDetail, PaymentListItem, PaymentListQuery
from ...dto.policy import APPROVER_ROLE, POLICY_RULES, POLICY_THRESHOLDS, POLICY_VERSION
from ..deps import ServicesDep, SessionDep
from ..security import require_permission

router = APIRouter()


@router.get("/policy", dependencies=[Depends(require_permission("policy.view"))])
async def policy() -> dict[str, object]:
    t = POLICY_THRESHOLDS
    return {
        "version": POLICY_VERSION,
        "rules": [{"id": r.id, "condition": r.condition, "tier": r.tier, "appliesTo": r.applies_to} for r in POLICY_RULES],
        "thresholds": [
            {"label": "Refunds approved automatically up to", "value": format_money(t.auto_refund_max_minor)},
            {"label": "Refunds an OPS user can approve up to", "value": format_money(t.ops_refund_max_minor)},
            {"label": "Agent confidence for automatic refunds", "value": f"{t.auto_refund_min_confidence:.2f}"},
            {"label": "Agent confidence for automatic state corrections", "value": f"{t.auto_correction_min_confidence:.2f}"},
            {"label": "Agent confidence below which a person reviews", "value": f"{t.low_confidence:.2f}"},
        ],
        "approverRoles": [
            {"tier": "AUTO", "approver": "No approval needed"},
            {"tier": "OPS", "approver": f"Another {APPROVER_ROLE['OPS']} user, a manager or an admin"},
            {"tier": "MANAGER", "approver": "A manager or an admin"},
            {"tier": "BLOCKED", "approver": "Cannot be approved"},
        ],
    }


@router.get("/overview", dependencies=[Depends(require_permission("overview.view"))])
async def overview(services: ServicesDep, session: SessionDep) -> OverviewMetrics:
    return await services.overview.metrics(session)


@router.get("/payments", dependencies=[Depends(require_permission("payment.view"))])
async def list_payments(query: Annotated[PaymentListQuery, Query()], services: ServicesDep, session: SessionDep) -> Page[PaymentListItem]:
    return await services.payments.list(session, query)


@router.get("/payments/{payment_id}", dependencies=[Depends(require_permission("payment.view"))])
async def get_payment(payment_id: str, services: ServicesDep, session: SessionDep) -> PaymentDetail:
    return await services.payments.get(session, payment_id)


@router.get("/cases", dependencies=[Depends(require_permission("case.view"))])
async def list_cases(query: Annotated[CaseListQuery, Query()], services: ServicesDep, session: SessionDep) -> Page[CaseListItem]:
    return await services.cases.list(session, query)


@router.get("/agent-control", dependencies=[Depends(require_permission("agent.view"))])
async def agent_control(services: ServicesDep, session: SessionDep) -> AgentControlItem:
    return await services.agent_control.get(session)
