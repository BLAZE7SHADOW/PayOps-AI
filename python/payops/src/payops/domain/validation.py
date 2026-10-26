"""The pure half of the validator. The validator never trusts the executor or stored state: it loads a fresh case
snapshot and checks (1) each action's postconditions and (2) global invariants for the case entities:
  - the state matrix shows no system disagreeing with the gateway, except SETTLEMENT on a settlement case whose
    difference is covered by an open dispute;
  - detection, re-run now, has no hit for the case's fingerprint. Verdict: FAIL if any postcondition fails, PARTIAL if
    only an invariant fails, else PASS. Loading the state and storing the result live in the services layer."""

from __future__ import annotations

from collections.abc import Sequence

from ..dto.validation import ValidationCheck
from .actions.types import CaseState
from .enums import SYSTEMS
from .reconciliation.candidates import fingerprint_of
from .reconciliation.matrix import build_matrix
from .reconciliation.rules import run_order_rules


def _invariant(
    key: str, *, subject: str, description: str, expected: str, actual: str, passed: bool
) -> ValidationCheck:
    return ValidationCheck.model_validate(
        {
            "id": f"inv.{key}",
            "kind": "INVARIANT",
            "actionIndex": None,
            "subject": subject,
            "description": description,
            "expected": expected,
            "actual": actual,
            "pass": passed,
        }
    )


def case_invariants(state: CaseState) -> list[ValidationCheck]:
    """Global invariants for a case, from fresh state."""
    checks: list[ValidationCheck] = []
    is_settlement_case = state.case.type == "SETTLEMENT_MISMATCH"
    disputed = is_settlement_case and state.batch is not None and state.batch.check.dispute_id is not None

    if state.order is not None:
        matrix = build_matrix(state.order)
        allowed = {"SETTLEMENT"} if disputed else set()
        wrong = [k for k in matrix.mismatched if k not in allowed]
        if not wrong:
            actual = (
                "only SETTLEMENT differs, covered by an open dispute"
                if disputed and "SETTLEMENT" in matrix.mismatched
                else "no mismatched systems"
            )
            checks.append(
                _invariant(
                    "matrix",
                    subject="state matrix",
                    description="Every system agrees with the gateway",
                    expected="no mismatched systems",
                    actual=actual,
                    passed=True,
                )
            )
        for k in (s for s in SYSTEMS if s in wrong):
            cell = matrix.cells[k]  # type: ignore[index]
            actual = ": ".join(part for part in (cell.status, cell.detail) if part) or "mismatch"
            checks.append(
                _invariant(
                    f"matrix.{k}",
                    subject=f"{k.lower()} cell",
                    description=f"{k} agrees with the gateway",
                    expected="agrees with gateway",
                    actual=actual,
                    passed=False,
                )
            )

    hits = [
        *(run_order_rules(state.order) if state.order else []),
        *([state.batch.check.hit] if is_settlement_case and state.batch and state.batch.check.hit else []),
    ]
    hits = [h for h in hits if fingerprint_of(h) == state.case.fingerprint]
    checks.append(
        _invariant(
            "detection",
            subject="detection rules",
            description="Re-running detection finds nothing for this case",
            expected="no rule fires",
            actual=" ".join(f"{h.rule_id}: {h.reason}" for h in hits) if hits else "no rule fires",
            passed=not hits,
        )
    )
    return checks


def verdict_of(checks: Sequence[ValidationCheck]) -> str:
    if any(c.kind == "POSTCONDITION" and not c.passed for c in checks):
        return "FAIL"
    if any(not c.passed for c in checks):
        return "PARTIAL"
    return "PASS"
