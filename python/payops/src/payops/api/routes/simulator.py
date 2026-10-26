"""The simulator routes: scenarios, reset and undo for the public demo. ADMIN only, or OPS in demo mode so visitors can generate scenarios."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from ...dto.api import GenerateScenarioBody
from ...simulator.scenario_info import SCENARIOS
from ..deps import ServicesDep
from ..security import require_permission


def make_router(demo_mode: bool) -> APIRouter:
    guard = Depends(require_permission("simulator.use", role_override="OPS" if demo_mode else None))
    router = APIRouter(prefix="/simulator", dependencies=[guard])

    @router.get("/scenarios")
    async def scenarios() -> list[dict[str, object]]:
        return [s.to_json() for s in SCENARIOS]

    @router.post("/scenarios", status_code=201)
    async def generate(body: GenerateScenarioBody, services: ServicesDep) -> dict[str, Any]:
        return (await services.simulator.generate_scenario(body.scenario, body.seed, body.noise)).to_json()

    @router.get("/recorded")
    async def recorded(services: ServicesDep) -> list[Any]:
        """Scenario and seed pairs that have recorded model responses, so REPLAY can investigate them."""
        return services.simulator.recorded()

    @router.get("/reset-status")
    async def reset_status(services: ServicesDep) -> dict[str, Any]:
        return await services.simulator.status()

    @router.post("/reset")
    async def reset(request: Request, services: ServicesDep) -> dict[str, Any]:
        try:
            body = await request.json()
        except ValueError:
            body = None
        return await services.simulator.reset(isinstance(body, dict) and body.get("demo") is True)

    @router.post("/undo-reset")
    async def undo_reset(services: ServicesDep) -> dict[str, Any]:
        return await services.simulator.undo()

    return router


