"""The JSON shapes that move through the graph, defined once.

These are `TypedDict`s: at run time they are the same plain dicts the API sends and the cassettes hash, so nothing changes in the
prompts or the stored state. They exist so the type checker can catch a misspelled key or a wrong value type.
Keys that are not always present are `NotRequired`.
"""

from __future__ import annotations

from typing import Any, NotRequired, TypedDict


class Budget(TypedDict):
    llmCalls: int
    jevCalls: int
    toolCalls: int
    tokensIn: int
    tokensOut: int
    costUsd: float


class Evidence(TypedDict):
    """Facts projected from one tool call. Findings cite these by id."""

    id: str
    stepId: str
    source: str
    system: str
    entityRef: str
    facts: dict[str, Any]
    observedAt: str


class Finding(TypedDict):
    id: str
    agent: str
    code: str
    statement: str
    evidenceIds: list[str]
    confidence: float


class CaseFlags(TypedDict):
    hasRefund: bool
    hasSettlementBatch: bool
    isDuplicate: bool
    quarantinedText: bool


class CaseBrief(TypedDict):
    caseId: str
    displayId: str
    type: str
    detectionRuleIds: list[str]
    amountBand: str
    mismatchedSystems: list[str]
    flags: CaseFlags


class InvestigationPlan(TypedDict):
    primaryHypothesis: str
    specialists: list[str]
    routedBy: str
    confidence: float


class Risk(TypedDict):
    tier: str
    scores: dict[str, float]
    meanConfidence: float


class Grounding(TypedDict):
    checked: int
    violations: list[dict[str, str]]
    sufficient: bool
    needsHumanReview: bool


class Diagnosis(TypedDict):
    rootCause: str
    narrative: str
    confidence: float
    supportingFindingIds: list[str]
    path: str


class ProposedAction(TypedDict):
    type: str
    params: dict[str, Any]


class Proposal(TypedDict):
    actions: list[ProposedAction]
    rationale: str
    expectedPostconditions: list[Any]


class Policy(TypedDict):
    tier: str
    reasons: list[Any]


# `pass` is a Python keyword, so this one needs the functional form. The API sends the key under that name.
ValidationCheck = TypedDict(
    "ValidationCheck",
    {
        "id": str,
        "description": NotRequired[str],
        "expected": NotRequired[Any],
        "actual": NotRequired[Any],
        "pass": bool,
    },
)


class Validation(TypedDict):
    verdict: str
    checks: list[ValidationCheck]
