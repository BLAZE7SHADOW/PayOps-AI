"""Routes that change data. Each names its permission; the service enforces the rule that depends on the data (four-eyes, tier, case status)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from ...agent_tools.store import create_agent_run
from ...db.engine import transaction
from ...db.models import Case
from ...domain.bulk_approve import BulkApprovalBody, BulkApprovalResult
from ...dto.api import AgentControlBody, AgentControlItem, AssignCaseBody, CaseListItem
from ...dto.resolution import ApprovalDecisionBody, ApprovalItem, PolicyPreview, PreviewActionsBody, ProposeActionsBody, ResolutionItem
from ...dto.runs import CreateRunBody, DiagnosisFeedbackBody, DiagnosisFeedbackItem
from ...dto.webhooks import WebhookLogDetail
from ...dto.workflow import OperatorNoteBody, OperatorNoteItem, SavedViewBody, SavedViewItem
from ...errors import not_found
from ..deps import ServicesDep, ident
from ..security import SessionUser, require_permission

router = APIRouter()

@router.put("/cases/{case_id}/assignee")
async def assign_case(
    case_id: str, body: AssignCaseBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("case.assign"))]
) -> CaseListItem:
    async with transaction(services.sessions) as s:
        return await services.case_writes.assign(s, ident(case_id), body.assignee_id, user.id, user.name)  # type: ignore[no-any-return]


@router.post("/cases/{case_id}/notes", status_code=201)
async def add_note(
    case_id: str, body: OperatorNoteBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("case.note"))]
) -> OperatorNoteItem:
    async with transaction(services.sessions) as s:
        return await services.note_writes.add(s, ident(case_id), body, user.id, user.name)


@router.post("/cases/{case_id}/actions/preview")
async def preview_actions(
    case_id: str, body: PreviewActionsBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("resolution.propose"))]
) -> PolicyPreview:
    return await services.resolution_service.preview(ident(case_id), body.actions)


@router.post("/cases/{case_id}/actions", status_code=201)
async def propose_actions(
    case_id: str, body: ProposeActionsBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("resolution.propose"))]
) -> ResolutionItem:
    return await services.resolution_service.propose(ident(case_id), body, user)


@router.post("/cases/{case_id}/resolutions/{resolution_id}/undo", status_code=201)
async def undo_resolution(
    case_id: str, resolution_id: str, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("resolution.undo"))]
) -> ResolutionItem:
    async with services.sessions() as s:
        item = await services.resolutions.item(s, ident(resolution_id, "resolutionId"))
    if item.case_id != ident(case_id):
        raise not_found("Resolution", resolution_id)
    return await services.resolution_service.undo(resolution_id, user)


@router.post("/approvals/bulk-approve")
async def bulk_approve(
    body: BulkApprovalBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("approval.bulk"))]
) -> BulkApprovalResult:
    return await services.approval_service.bulk_approve(body, user)


@router.post("/approvals/{approval_id}/decision")
async def decide_approval(
    approval_id: str, body: ApprovalDecisionBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("approval.decide"))]
) -> ApprovalItem:
    return await services.approval_service.decide(ident(approval_id), body, user)


@router.put("/runs/{run_id}/feedback")
async def submit_feedback(
    run_id: str, body: DiagnosisFeedbackBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("run.feedback"))]
) -> DiagnosisFeedbackItem:
    async with transaction(services.sessions) as s:
        return await services.feedback.submit(s, ident(run_id), body, user.id, user.name)


@router.post("/views", status_code=201)
async def save_view(body: SavedViewBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("view.manage"))]) -> SavedViewItem:
    async with transaction(services.sessions) as s:
        return await services.view_writes.save(s, user.id, body)


@router.delete("/views/{view_id}", status_code=204)
async def delete_view(view_id: str, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("view.manage"))]) -> Response:
    async with transaction(services.sessions) as s:
        await services.view_writes.remove(s, user.id, ident(view_id))
    return Response(status_code=204)


@router.put("/agent-control")
async def set_agent_control(
    body: AgentControlBody, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("agent.control"))]
) -> AgentControlItem:
    async with transaction(services.sessions) as s:
        return await services.agent_control_writes.set(s, body, user.id, user.name)


@router.post("/webhooks/{event_id}/replay")
async def replay_webhook(
    event_id: str, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("webhook.replay"))]
) -> WebhookLogDetail:
    return await services.webhook_events.replay(ident(event_id), user.id, user.name)


@router.post("/cases/{case_id}/runs", status_code=202)
async def start_run(
    case_id: str, request: Request, services: ServicesDep, user: Annotated[SessionUser, Depends(require_permission("run.start"))], body: CreateRunBody | None = None
) -> dict[str, str]:
    """Starts an agent investigation. The job does the work; this answers at once with the run's id."""
    async with services.sessions() as s:
        if await s.get(Case, ident(case_id)) is None:
            raise not_found("Case", case_id)
    scenario_key = body.scenario_key if body else None
    run_id = await create_agent_run(services, request.app.state.agent_store, case_id, scenario_key)
    assert services.jobs is not None
    await services.jobs.enqueue_agent_run(run_id, case_id, scenario_key)
    return {"runId": run_id}
