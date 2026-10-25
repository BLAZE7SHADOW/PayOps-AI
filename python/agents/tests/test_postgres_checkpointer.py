"""Pause and resume across a restart, with the real Postgres checkpointer.

Skipped unless CHECKPOINT_TEST_URL points at a Postgres (PGlite served by `scripts/local-db.ts --memory` works):
    CHECKPOINT_TEST_URL=postgres://postgres:postgres@127.0.0.1:54332/postgres uv run pytest tests/test_postgres_checkpointer.py
"""

from __future__ import annotations

import os
from contextlib import AsyncExitStack

import pytest

from payops_agents.checkpointer import create_checkpointer
from payops_agents.run import AgentRunner
from payops_agents.settings import Settings
from tests.fakes import FakeNodeApi

URL = os.environ.get("CHECKPOINT_TEST_URL")
pytestmark = pytest.mark.skipif(not URL, reason="CHECKPOINT_TEST_URL is not set")


async def test_a_paused_run_resumes_on_a_new_runner_with_the_same_database() -> None:
    assert URL
    settings = Settings(database_url=URL, checkpointer="postgres", checkpoint_pool_max=1)
    api = FakeNodeApi(tier="MANAGER")
    async with AsyncExitStack() as first:
        paused = await AgentRunner(api, await create_checkpointer(first, settings)).investigate(  # type: ignore[arg-type]
            "run_pg", api.data["caseId"], "captured_order_failed", "REPLAY"
        )
    assert paused.interrupted
    # A fresh checkpointer and runner stand in for the service restarting.
    async with AsyncExitStack() as second:
        done = await AgentRunner(api, await create_checkpointer(second, settings)).resume(  # type: ignore[arg-type]
            "run_pg", api.data["caseId"], "captured_order_failed", "REPLAY", {"approvalId": "apr_fake", "decision": "APPROVE"}
        )
    assert done.status == "RESOLVED" and "execute" in api.calls
