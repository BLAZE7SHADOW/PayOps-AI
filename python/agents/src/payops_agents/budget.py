"""Run budget arithmetic and the budget guard (packages/shared agents.ts, packages/agents budget-guard.ts)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .constants import MAX_COST_USD, MAX_TOOL_CALLS
from .shapes import Budget

_KEYS = ("llmCalls", "jevCalls", "toolCalls", "tokensIn", "tokensOut", "costUsd")


def zero_budget() -> Budget:
    return {"llmCalls": 0, "jevCalls": 0, "toolCalls": 0, "tokensIn": 0, "tokensOut": 0, "costUsd": 0}


def add_budgets(a: Mapping[str, Any] | None, b: Mapping[str, Any] | None) -> Budget:
    """State reducer. Tolerates a missing side so the channel can start empty."""
    a = a or {}
    b = b or {}
    return Budget(**{k: a.get(k, 0) + b.get(k, 0) for k in _KEYS})  # type: ignore[typeddict-item]


@dataclass(frozen=True)
class BudgetGuardResult:
    exceeded: bool
    reason: str | None


def check_budget_guard(budget: Budget) -> BudgetGuardResult:
    if budget["toolCalls"] > MAX_TOOL_CALLS:
        return BudgetGuardResult(
            True, f"Budget guard: this run made {budget['toolCalls']} tool calls, over the {MAX_TOOL_CALLS} limit."
        )
    if budget["costUsd"] > MAX_COST_USD:
        return BudgetGuardResult(
            True,
            f"Budget guard: this run cost an estimated ${budget['costUsd']:.4f}, over the ${MAX_COST_USD:.2f} limit.",
        )
    return BudgetGuardResult(False, None)
