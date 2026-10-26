"""Dispatch from an action to its pure checks."""

from __future__ import annotations

from collections.abc import Sequence

from ...dto.actions import CatalogAction
from ...dto.validation import PreconditionFailure, ValidationCheck
from .handlers import POSTCONDITIONS, PRECONDITIONS
from .types import CaseState


def preconditions_of(action: CatalogAction, state: CaseState) -> list[str]:
    return PRECONDITIONS[action.type](action.params, state)


def postconditions_of(action: CatalogAction, state: CaseState, index: int) -> list[ValidationCheck]:
    return POSTCONDITIONS[action.type](action.params, state, index)


def check_preconditions(actions: Sequence[CatalogAction], state: CaseState) -> list[PreconditionFailure]:
    """Every precondition failure of a proposal, evaluated on the same (current) state."""
    return [
        PreconditionFailure(action_index=i, type=action.type, message=message)
        for i, action in enumerate(actions)
        for message in preconditions_of(action, state)
    ]
