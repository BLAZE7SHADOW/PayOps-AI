# pyright: reportArgumentType=false, reportInvalidTypeForm=false, reportCallIssue=false
"""LLM output schemas (packages/agents schemas.ts). The Zod rules become Pydantic constraints.

Field names stay camelCase because they are the JSON the model returns and the cassettes hold.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, create_model

from .constants import FINDING_CODES, ROOT_CAUSES
from .tools_catalog import ToolDef

FindingCode = Literal[FINDING_CODES]  # type: ignore[valid-type]
RootCauseName = Literal[ROOT_CAUSES]  # type: ignore[valid-type]


def _trimmed(min_length: int, max_length: int) -> object:
    return StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length)


class FindingAnswer(BaseModel):
    code: FindingCode
    statement: Annotated[str, _trimmed(3, 300)]
    evidenceIds: Annotated[list[Annotated[str, Field(min_length=1)]], Field(min_length=1)]
    confidence: Annotated[float, Field(ge=0, le=1)]


class FindingsSchema(BaseModel):
    findings: Annotated[list[FindingAnswer], Field(min_length=1, max_length=8)]


class DiagnosisSchema(BaseModel):
    rootCause: RootCauseName
    narrative: Annotated[str, _trimmed(3, 400)]
    confidence: Annotated[float, Field(ge=0, le=1)]
    supportingFindingIds: list[str]


def build_follow_up_choice_schema(tools: list[ToolDef]) -> type[BaseModel] | None:
    """A follow-up schema whose `tool` may only name this specialist's own follow-up tools."""
    if not tools:
        return None
    tool_name = Literal[tuple(t.name for t in tools)]  # type: ignore[valid-type]
    follow_up = create_model(
        "FollowUp",
        tool=(tool_name, ...),
        reason=(Annotated[str, _trimmed(3, 200)], ...),
    )
    return create_model(
        "FollowUpChoice",
        followUps=(Annotated[list[follow_up], Field(max_length=6)], ...),  # type: ignore[valid-type]
    )
