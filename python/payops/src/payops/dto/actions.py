"""The closed action catalog (docs/03-agent-system.md §10; packages/shared actions.ts).

Every resolution, whether proposed by a person or the agent, is a list of these actions. Nothing outside this list can
be executed. Parameters are validated here; preconditions, execution and postconditions live in `domain/actions`."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated, Final, Literal

from pydantic import Field, StringConstraints

from .base import CamelModel

ACTION_TYPES: Final = (
    "REPLAY_WEBHOOK_EVENT",
    "MARK_ORDER_PAID",
    "POST_LEDGER_ENTRY",
    "REVERSE_LEDGER_ENTRY",
    "INITIATE_REFUND",
    "SYNC_REFUND_STATUS",
    "RAISE_SETTLEMENT_DISPUTE",
    "HOLD_PAYMENT_FOR_REVIEW",
    "ESCALATE_TO_HUMAN",
)

Id = Annotated[str, Field(min_length=3, max_length=64)]
Minor = Annotated[int, Field(gt=0, le=1_00_00_000_00)]  # at most 1 crore rupees per action


def _text(min_length: int, max_length: int) -> object:
    return StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length)


class ReplayWebhookParams(CamelModel):
    event_id: Id


class MarkOrderPaidParams(CamelModel):
    order_id: Id
    payment_id: Id


class PostLedgerEntryParams(CamelModel):
    payment_id: Id
    amount_minor: Minor


class ReverseLedgerEntryParams(CamelModel):
    omit_when_none = frozenset({"undo_of"})

    journal_id: Id
    #: Id of the resolution this reversal undoes. Set only by the Undo flow (D070); it changes the validator's
    #: expectation
    #: from "net capture equals the gateway capture" to "no capture credit remains".
    undo_of: Id | None = None


class InitiateRefundParams(CamelModel):
    gw_payment_id: Id
    amount_minor: Minor
    reason: Annotated[str, _text(3, 200)]


class SyncRefundStatusParams(CamelModel):
    refund_id: Id


class RaiseSettlementDisputeParams(CamelModel):
    omit_when_none = frozenset({"gw_payment_id"})

    batch_id: Id
    gw_payment_id: Id | None = None
    amount_minor: Minor


class HoldPaymentParams(CamelModel):
    payment_id: Id


class EscalateParams(CamelModel):
    reason: Annotated[str, _text(3, 300)]
    to: Literal["OPS", "MANAGER"] = "MANAGER"


class ReplayWebhookAction(CamelModel):
    type: Literal["REPLAY_WEBHOOK_EVENT"]
    params: ReplayWebhookParams


class MarkOrderPaidAction(CamelModel):
    type: Literal["MARK_ORDER_PAID"]
    params: MarkOrderPaidParams


class PostLedgerEntryAction(CamelModel):
    type: Literal["POST_LEDGER_ENTRY"]
    params: PostLedgerEntryParams


class ReverseLedgerEntryAction(CamelModel):
    type: Literal["REVERSE_LEDGER_ENTRY"]
    params: ReverseLedgerEntryParams


class InitiateRefundAction(CamelModel):
    type: Literal["INITIATE_REFUND"]
    params: InitiateRefundParams


class SyncRefundStatusAction(CamelModel):
    type: Literal["SYNC_REFUND_STATUS"]
    params: SyncRefundStatusParams


class RaiseSettlementDisputeAction(CamelModel):
    type: Literal["RAISE_SETTLEMENT_DISPUTE"]
    params: RaiseSettlementDisputeParams


class HoldPaymentAction(CamelModel):
    type: Literal["HOLD_PAYMENT_FOR_REVIEW"]
    params: HoldPaymentParams


class EscalateAction(CamelModel):
    type: Literal["ESCALATE_TO_HUMAN"]
    params: EscalateParams


CatalogAction = Annotated[
    ReplayWebhookAction
    | MarkOrderPaidAction
    | PostLedgerEntryAction
    | ReverseLedgerEntryAction
    | InitiateRefundAction
    | SyncRefundStatusAction
    | RaiseSettlementDisputeAction
    | HoldPaymentAction
    | EscalateAction,
    Field(discriminator="type"),
]


@dataclass(frozen=True)
class ActionMeta:
    label: str
    description: str
    #: STATE_CORRECTION makes our records match what the gateway did (no money moves); MONEY_MOVEMENT moves customer or
    #: merchant
    #: money; CLAIM raises a claim against a third party; CONTROL freezes or routes work to people.
    action_class: str
    money_moving: bool
    reversible: bool


ACTION_META: Final[dict[str, ActionMeta]] = {
    "REPLAY_WEBHOOK_EVENT": ActionMeta(
        "Replay webhook event",
        "Ask the gateway to deliver the event again so our consumer processes it.",
        "STATE_CORRECTION",
        False,
        False,
    ),
    "MARK_ORDER_PAID": ActionMeta(
        "Mark order paid", "Move the order to PAID and link the captured payment.", "STATE_CORRECTION", False, True
    ),
    "POST_LEDGER_ENTRY": ActionMeta(
        "Post capture to ledger",
        "Post the missing capture journal for a payment the gateway captured.",
        "STATE_CORRECTION",
        False,
        True,
    ),
    "REVERSE_LEDGER_ENTRY": ActionMeta(
        "Reverse ledger journal",
        "Post an equal and opposite journal. The original entry stays.",
        "STATE_CORRECTION",
        False,
        False,
    ),
    "INITIATE_REFUND": ActionMeta(
        "Refund customer", "Create a refund at the gateway for a captured payment.", "MONEY_MOVEMENT", True, False
    ),
    "SYNC_REFUND_STATUS": ActionMeta(
        "Sync refund status",
        "Copy the gateway refund status to our refund record and post it to the ledger.",
        "STATE_CORRECTION",
        False,
        False,
    ),
    "RAISE_SETTLEMENT_DISPUTE": ActionMeta(
        "Raise settlement dispute",
        "Open a dispute with the acquirer for the settlement shortfall.",
        "CLAIM",
        False,
        False,
    ),
    "HOLD_PAYMENT_FOR_REVIEW": ActionMeta(
        "Hold payment", "Freeze the payment so it is excluded from payouts until reviewed.", "CONTROL", False, True
    ),
    "ESCALATE_TO_HUMAN": ActionMeta(
        "Escalate", "Route the case to a person with the reason attached.", "CONTROL", False, True
    ),
}

#: Actions allowed when risk is CRITICAL (policy rule P1).
CRITICAL_RISK_ALLOWED: Final = ("HOLD_PAYMENT_FOR_REVIEW", "ESCALATE_TO_HUMAN")


def is_undo_proposal(actions: Sequence[CatalogAction]) -> bool:
    """True when a proposal is the Undo flow's reversal (D070). Such a proposal is judged on its own postconditions."""
    return any(a.type == "REVERSE_LEDGER_ENTRY" and a.params.undo_of is not None for a in actions)


def money_moving_minor(actions: Sequence[CatalogAction]) -> int:
    """Total money moved by a proposal, in paise."""
    return sum(a.params.amount_minor for a in actions if a.type == "INITIATE_REFUND")
