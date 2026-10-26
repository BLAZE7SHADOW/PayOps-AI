"""A local Postgres for development, with no install and no Docker (the `pgserver` package). It keeps its data in
`~/.payops-devdb` (a path without spaces, which pgserver needs) and runs until you stop it.

    uv run python scripts/dev_db.py        # prints DATABASE_URL, then waits

Point the API at the printed URL: `DATABASE_URL='...' uv run uvicorn payops.api.app:app_factory --factory --port 4000`.
"""

import os
import pathlib
import signal
import sys
import time

from pgserver.postgres_server import get_server

DATA_DIR = pathlib.Path(os.environ.get("PAYOPS_DEVDB", pathlib.Path.home() / ".payops-devdb"))


def main() -> int:
    server = get_server(str(DATA_DIR))
    print(server.get_uri(), flush=True)
    stop = False

    def on_signal(*_: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    while not stop:
        time.sleep(0.5)
    server.cleanup()
    return 0


if __name__ == "__main__":
    sys.exit(main())
