"""`python -m payops.evals`: runs the golden scenarios in REPLAY against a throwaway Postgres (pgserver, no Docker) and
exits 1 if a gate or limit fails."""

from __future__ import annotations

import asyncio
import sys
import tempfile
from datetime import datetime

from pgserver.postgres_server import get_server

from ..container import build_services
from ..db.engine import create_engine, session_factory
from ..db.migrate import upgrade
from ..ports import FixedClock
from ..settings import Settings
from .report import check_thresholds, render, summarize
from .runner import run_eval_suite

NOW = datetime.fromisoformat("2026-09-28T12:00:00+00:00")


async def main() -> int:
    with tempfile.TemporaryDirectory(prefix="payops-eval-") as data_dir:
        server = get_server(data_dir)
        url = server.get_uri()
        upgrade(url)
        engine = create_engine(url=url, pool_size=5)
        try:
            services = build_services(session_factory(engine), clock=FixedClock(NOW), cassette_dir=Settings().cassettes)
            outcomes = await run_eval_suite(services)
        finally:
            await engine.dispose()
            server.cleanup()
    summary = summarize(outcomes)
    print(render(outcomes, summary))
    return 0 if summary.failed == 0 and not check_thresholds(summary) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
