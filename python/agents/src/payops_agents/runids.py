"""Run-scoped ids: "ev_03", "fd_02". Derived from what already exists so a resume gives the same ids."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any


def next_evidence_id(existing: Sequence[Any]) -> str:
    return f"ev_{len(existing) + 1:02d}"


def next_finding_id(existing: Sequence[Any]) -> str:
    return f"fd_{len(existing) + 1:02d}"
