"""Client for the TypeScript API's `/internal/agent/*` routes (apps/server routes/internal-agent.ts).

This is the only way the Python graph reaches data or authority: loading the case, running tools, the
policy gate, execute, validate, close, and recording steps. Python never opens a connection to the
application tables.
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

import httpx


class NodeApiError(Exception):
    def __init__(self, path: str, status: int, body: str) -> None:
        super().__init__(f"internal API {path} answered {status}: {body[:300]}")
        self.status = status


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


class NodeApi:
    def __init__(self, base_url: str, secret: str, client: httpx.AsyncClient | None = None) -> None:
        self._base = base_url.rstrip("/") + "/internal/agent"
        self._headers = {"x-agent-secret": secret}
        self._client = client or httpx.AsyncClient(timeout=60.0)

    async def _post(self, path: str, body: dict[str, Any]) -> Any:
        res = await self._client.post(self._base + path, json=body, headers=self._headers)
        if res.status_code >= 400:
            raise NodeApiError(path, res.status_code, res.text)
        return res.json()

    async def case_brief(self, case_id: str) -> dict[str, Any]:
        return await self._post("/case-brief", {"caseId": case_id})

    async def run_tools(self, case_id: str, tools: list[str]) -> list[dict[str, Any]]:
        return (await self._post("/tools", {"caseId": case_id, "tools": tools}))["results"]

    async def proposal(self, case_id: str, diagnosis: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._post("/proposal", {"caseId": case_id, "diagnosis": diagnosis, "history": history})

    async def policy_gate(
        self, case_id: str, run_id: str, proposal: dict[str, Any], diagnosis_confidence: float
    ) -> dict[str, Any]:
        return await self._post(
            "/policy-gate",
            {"caseId": case_id, "runId": run_id, "proposal": proposal, "diagnosisConfidence": diagnosis_confidence},
        )

    async def execute(self, case_id: str, run_id: str, resolution_id: str) -> dict[str, Any]:
        return await self._post("/execute", {"caseId": case_id, "runId": run_id, "resolutionId": resolution_id})

    async def validate(self, resolution_id: str) -> dict[str, Any]:
        return await self._post("/validate", {"resolutionId": resolution_id})

    async def close_validated(self, case_id: str, run_id: str, resolution_id: str, verdict: str) -> None:
        await self._post(
            "/close-validated", {"caseId": case_id, "runId": run_id, "resolutionId": resolution_id, "verdict": verdict}
        )

    async def escalate_without_proposal(self, case_id: str, run_id: str, reason: str) -> None:
        await self._post("/escalate-without-proposal", {"caseId": case_id, "runId": run_id, "reason": reason})

    async def record_step(self, run_id: str, case_id: str, node: str, kind: str, payload: dict[str, Any]) -> None:
        await self._post("/steps", {"runId": run_id, "caseId": case_id, "node": node, "kind": kind, "payload": payload})

    async def sync(self, run_id: str, case_id: str, state: dict[str, Any], interrupted: bool) -> None:
        await self._post("/sync", {"runId": run_id, "caseId": case_id, "state": state, "interrupted": interrupted})

    async def fail(self, run_id: str, error: str) -> None:
        await self._post("/fail", {"runId": run_id, "error": error})

    async def aclose(self) -> None:
        await self._client.aclose()


EventSink = Any  # async (node: str, kind: str, payload: dict) -> None


def make_event_sink(api: NodeApiPort, run_id: str, case_id: str) -> EventSink:
    """Persists each agent step through the API. The specialists run in parallel, and the API numbers steps
    by counting rows, so posts are serialized here to keep `seq` unique and in order."""
    lock = asyncio.Lock()

    async def sink(node: str, kind: str, payload: dict[str, Any]) -> None:
        async with lock:
            await api.record_step(run_id, case_id, node, kind, payload)

    return sink
