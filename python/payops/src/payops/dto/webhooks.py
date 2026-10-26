from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field, StringConstraints

from ..domain.enums import WEBHOOK_EVENT_TYPES
from .base import CamelModel

WEBHOOK_LOG_STATUS = ("PROCESSED", "FAILED", "DEAD")


class WebhookLogListQuery(CamelModel):
    cursor: Annotated[str, Field(max_length=512)] | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 25
    status: Literal[WEBHOOK_LOG_STATUS] | None = None  # type: ignore[valid-type]
    event: Literal[WEBHOOK_EVENT_TYPES] | None = None  # type: ignore[valid-type]
    gw_payment_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)] | None = None


class WebhookLogItem(CamelModel):
    id: str
    event: str
    gw_payment_id: str
    gw_refund_id: str | None
    status: str
    attempt_count: int
    last_http_status: int | None
    last_message: str
    next_retry_at: str | None
    first_received_at: str
    updated_at: str


class WebhookLogDetail(WebhookLogItem):
    #: The event exactly as it reached our consumer.
    payload: dict[str, Any]
    attempts: list[dict[str, Any]]


class WebhookLogCounts(CamelModel):
    processed: int
    failed: int
    dead: int
