"""What the API does once when it starts: bring the database schema up to date, make sure the demo accounts exist, and give a hash to audit rows written before
the chain existed. Each step is safe to repeat. (apps/server main.ts)"""

from __future__ import annotations

import asyncio
import logging

from ..auth.demo_users import seed_demo_users
from ..db.engine import create_engine, session_factory, transaction
from ..db.migrate import upgrade
from ..infra.audit_store import seal_legacy_audit_rows
from ..settings import Settings

log = logging.getLogger("payops.startup")


async def prepare_database(settings: Settings) -> None:
    await asyncio.to_thread(upgrade, settings.database_url)
    log.info("migrations applied")
    engine = create_engine(settings)
    try:
        async with transaction(session_factory(engine)) as s:
            created = await seed_demo_users(s)
            sealed = await seal_legacy_audit_rows(s)
        if created:
            log.info("demo users created", extra={"count": created})
        if sealed:
            log.info("legacy audit rows sealed", extra={"count": sealed})
    finally:
        await engine.dispose()
