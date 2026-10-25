"""Checks that the database you point it at delivers LISTEN/NOTIFY, which the job queue uses to wake workers.

Run it against the hosted database before deploying the Python backend (D086). It creates no tables.

    ! DATABASE_URL='postgres://...' uv run python scripts/check_listen_notify.py

Use the Supabase Session pooler (port 5432). The Transaction pooler (6543) does not support LISTEN.
"""

import asyncio
import os
import sys
import time

import psycopg


async def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("Set DATABASE_URL first.")
        return 2
    async with (
        await psycopg.AsyncConnection.connect(url, autocommit=True) as listener,
        await psycopg.AsyncConnection.connect(url, autocommit=True) as sender,
    ):
        await listener.execute("LISTEN payops_check")
        started = time.perf_counter()
        await sender.execute("SELECT pg_notify('payops_check', 'hello')")

        async def first() -> psycopg.Notify:
            async for notification in listener.notifies():
                return notification
            raise RuntimeError("the connection closed before a notification arrived")

        try:
            notification = await asyncio.wait_for(first(), timeout=10)
        except TimeoutError:
            print("FAIL: no notification within 10 seconds. This connection does not deliver LISTEN/NOTIFY.")
            return 1
        print(f"OK: got '{notification.payload}' in {(time.perf_counter() - started) * 1000:.0f} ms")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
