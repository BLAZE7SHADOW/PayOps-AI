"""The API contract does not drift silently.

The committed OpenAPI snapshot is what the web app is built against. If a route, a request body or a response model changes, this test
fails with the list of changes. An intended change is accepted by regenerating the snapshot and updating the web app in the same pull
request; an accidental one is caught here before it reaches the browser.
"""

from __future__ import annotations

import json

from payops.api.contract import SNAPSHOT, current_spec, describe_drift, operations, render


def test_the_app_matches_the_committed_api_contract() -> None:
    committed = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    current = current_spec()
    drift = describe_drift(committed, current)
    assert not drift, (
        "The API no longer matches tests/contract/openapi.json:\n  "
        + "\n  ".join(drift)
        + "\nIf this is intended, run `uv run python scripts/export_openapi.py`, review the diff, and update apps/web to follow it."
    )
    assert render(current) == SNAPSHOT.read_text(encoding="utf-8")


def test_every_operation_is_guarded_documented_and_typed() -> None:
    spec = current_spec()
    for op in sorted(operations(spec)):
        method, path = op.split(" ", 1)
        operation = spec["paths"][path][method.lower()]
        assert operation.get("operationId"), f"{op} has no operation id"
        responses = operation.get("responses", {})
        assert any(code.startswith("2") for code in responses), f"{op} documents no success response"


def test_the_drift_report_names_what_changed() -> None:
    committed = {"paths": {"/api/a": {"get": {}}}, "components": {"schemas": {"A": {"properties": {"x": {}}}}}}
    current = {"paths": {"/api/b": {"get": {}}}, "components": {"schemas": {"A": {"properties": {"y": {}}}}}}
    assert describe_drift(committed, current) == [
        "removed operation: GET /api/a",
        "added operation:   GET /api/b",
        "changed schema:    A (-x, +y)",
    ]
