"""The concrete proposal for a diagnosis, fast or full path alike: the actions come from the same recommendations a
person sees in the manual form, so a proposed action always carries valid ids and params for this case. `UNKNOWN` always
escalates. (packages/agents proposal.ts, templates.ts)"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..domain.actions.options import AttemptHistory, action_options, recommended_types
from ..domain.actions.registry import postconditions_of
from ..domain.actions.types import CaseState
from ..dto.actions import CatalogAction


def _escalate_action(state: CaseState, history: Sequence[AttemptHistory]) -> CatalogAction:
    option = next((o for o in action_options(state, history) if o.type == "ESCALATE_TO_HUMAN"), None)
    if option is not None:
        return option.action
    from pydantic import TypeAdapter

    return TypeAdapter(CatalogAction).validate_python(
        {"type": "ESCALATE_TO_HUMAN", "params": {"reason": "Needs a person to review", "to": "MANAGER"}}
    )


def template_actions(root_cause: str, state: CaseState, history: Sequence[AttemptHistory] = ()) -> list[CatalogAction]:
    """The concrete actions for a diagnosed root cause, given this case's actual shape."""
    if root_cause == "UNKNOWN":
        return [_escalate_action(state, history)]
    by_type = {o.type: o for o in action_options(state, history)}
    recommended = [t for t in recommended_types(state, history) if by_type[t].available]
    if not recommended:
        return [_escalate_action(state, history)]
    return [by_type[t].action for t in recommended]


def build_proposal(
    diagnosis: dict[str, Any], state: CaseState, history: Sequence[AttemptHistory] = ()
) -> dict[str, Any]:
    actions = template_actions(diagnosis["rootCause"], state, history)
    expected = [c.description for i, a in enumerate(actions) for c in postconditions_of(a, state, i)]
    return {
        "actions": [a.to_json() for a in actions],
        "rationale": diagnosis["narrative"],
        "expectedPostconditions": expected,
    }


def to_attempt_history(history: Sequence[dict[str, Any]]) -> list[AttemptHistory]:
    """The agent's attempt summaries as the recommendations expect them. Every entry comes from `replan`, which only
    runs after a validated attempt (D047)."""
    return [AttemptHistory([a["type"] for a in h["actions"]], "VALIDATED", h["verdict"]) for h in history]
