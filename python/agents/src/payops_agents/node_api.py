"""The only way the graph reaches data or authority: loading the case, running tools, the policy gate, execute, validate, close, and recording steps.

The graph depends on this interface and never on the backend, so it never opens a connection to the application tables. The backend implements it
in process (`payops.agent_tools.node_api.InProcessNodeApi`).
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol


class NodeApiPort(Protocol):
    async def case_brief(self, case_id: str) -> dict[str, Any]: ...
    async def run_tools(self, case_id: str, tools: list[str]) -> list[dict[str, Any]]: ...
    async def proposal(self, case_id: str, diagnosis: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any]: ...
    async def policy_gate(
        self, case_id: str, run_id: str, proposal: dict[str, Any], diagnosis_confidence: float
    ) -> dict[str, Any]: ...
    async def execute(self, case_id: str, run_id: str, resolution_id: str) -> dict[str, Any]: ...
    async def validate(self, resolution_id: str) -> dict[str, Any]: ...
    async def close_validated(self, case_id: str, run_id: str, resolution_id: str, verdict: str) -> None: ...
    async def escalate_without_proposal(self, case_id: str, run_id: str, reason: str) -> None: ...
    async def record_step(self, run_id: str, case_id: str, node: str, kind: str, payload: dict[str, Any]) -> None: ...
    async def sync(self, run_id: str, case_id: str, state: dict[str, Any], interrupted: bool) -> None: ...
    async def fail(self, run_id: str, error: str) -> None: ...


EventSink = Any  # async (node: str, kind: str, payload: dict) -> None


def make_event_sink(api: NodeApiPort, run_id: str, case_id: str) -> EventSink:
    """Persists each agent step through the API. The specialists run in parallel, and the API numbers steps
    by counting rows, so posts are serialized here to keep `seq` unique and in order."""
    lock = asyncio.Lock()

    async def sink(node: str, kind: str, payload: dict[str, Any]) -> None:
        async with lock:
            await api.record_step(run_id, case_id, node, kind, payload)

    return sink
