"""Writes the backend's OpenAPI description to `tests/contract/openapi.json` (see `payops.api.contract`).

    uv run python scripts/export_openapi.py

Run it after an intentional API change, then read the diff: it is the list of changes the web app has to follow.
"""

from payops.api.contract import SNAPSHOT, current_spec, render

if __name__ == "__main__":
    SNAPSHOT.write_text(render(current_spec()), encoding="utf-8")
    print(f"wrote {SNAPSHOT}")
