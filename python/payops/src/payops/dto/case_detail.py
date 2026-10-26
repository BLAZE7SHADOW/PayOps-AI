"""Shapes that combine the list items with the resolution view: the case page, the approval page, and the source records tab."""

from __future__ import annotations

from typing import Literal

from .api import CaseListItem
from .base import CamelModel
from .matrix import LifecycleEvent, StateMatrix
from .resolution import ApprovalItem, CaseResolutionView, ResolutionItem


class CaseNote(CamelModel):
    id: str
    author_type: str
    text: str
    quarantined: bool
    at: str


class CaseEntityRefs(CamelModel):
    omit_when_none = frozenset({"payment_id", "gw_payment_id", "order_id", "customer_id", "merchant_id", "refund_id", "batch_id"})

    payment_id: str | None = None
    gw_payment_id: str | None = None
    order_id: str | None = None
    customer_id: str | None = None
    merchant_id: str | None = None
    refund_id: str | None = None
    batch_id: str | None = None


class CaseCustomer(CamelModel):
    id: str
    name: str
    email_masked: str


class CaseMerchant(CamelModel):
    id: str
    name: str


class CaseResolutionSummary(CamelModel):
    by: str
    summary: str


class CaseDetail(CaseListItem):
    matrix: StateMatrix
    entity_refs: CaseEntityRefs
    customer: CaseCustomer | None
    merchant: CaseMerchant | None
    notes: list[CaseNote]
    lifecycle: list[LifecycleEvent]
    resolved_at: str | None
    resolution: CaseResolutionSummary | None
    #: Manual resolution context and history.
    resolution_view: CaseResolutionView


class ApprovalDetail(ApprovalItem):
    resolution: ResolutionItem
    case_item: CaseListItem


class CaseSourceDetail(CamelModel):
    label: str
    value: str


class CaseSourceRecord(CamelModel):
    system: Literal["GATEWAY", "ORDER", "LEDGER", "WEBHOOK", "SETTLEMENT", "REFUND", "DISPUTE"]
    kind: str
    id: str
    status: str
    amount_minor: int | None
    at: str | None
    details: list[CaseSourceDetail]


class CaseSourceRecords(CamelModel):
    """Fresh, read-only projections of the records behind a case, independent of agent findings."""

    case_id: str
    read_at: str
    records: list[CaseSourceRecord]
