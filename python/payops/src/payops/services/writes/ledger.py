"""Double-entry ledger writes. The ledger is append-only: corrections are new journals whose legs point at the originals through `reversal_of`.

    Capture:  DEBIT SETTLEMENT_CLEARING / CREDIT MERCHANT_PAYABLE
    Refund:   DEBIT MERCHANT_PAYABLE    / CREDIT SETTLEMENT_CLEARING

(packages/core ledger.service.ts)"""

from __future__ import annotations

from sqlalchemy import asc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...db.models import LedgerEntry, Payment
from ...domain.ids import new_id
from ...domain.ledger import summarize_journals
from ...domain.money import format_money
from ...domain.reconciliation.facts import capture_credit_minor
from ...errors import AppError, not_found
from ...ports import Clock
from ..audit import AuditService, WriteContext, audit_from


class _Entries:
    """Adapts a list of ledger rows to what `capture_credit_minor` reads."""

    def __init__(self, ledger: list[LedgerEntry]) -> None:
        self.ledger = ledger


class LedgerWriteService:
    def __init__(self, clock: Clock, audit: AuditService) -> None:
        self._clock = clock
        self._audit = audit

    async def entries_for_payment(self, session: AsyncSession, payment_id: str) -> list[LedgerEntry]:
        """Every ledger row of a payment (capture and refund journals), oldest first."""
        return list((await session.scalars(select(LedgerEntry).where(LedgerEntry.payment_id == payment_id).order_by(asc(LedgerEntry.posted_at), asc(LedgerEntry.id)))).all())

    async def post_capture(self, session: AsyncSession, *, payment_id: str, merchant_id: str, amount_minor: int, source: str, ctx: WriteContext, memo: str | None = None) -> str:
        """Posts the capture journal. Refuses if a capture credit is already in force, so a retried call can never double-post. Locks the payment row."""
        payment = (await session.scalars(select(Payment).where(Payment.id == payment_id).with_for_update())).one_or_none()
        if payment is None:
            raise not_found("Payment", payment_id)
        existing = capture_credit_minor(_Entries(await self.entries_for_payment(session, payment_id)))
        if existing > 0:
            raise AppError("CONFLICT", f"Payment {payment_id} already has a capture credit of {format_money(existing)}")
        journal_id = await self._insert_journal(
            session, payment_id=payment_id, refund_id=None, merchant_id=merchant_id, amount_minor=amount_minor, debit="SETTLEMENT_CLEARING",
            credit="MERCHANT_PAYABLE", source=source, memo=memo or f"Capture {payment.gw_payment_id}",
        )
        await self._audit.record(
            session,
            audit_from(
                ctx, action="ledger.posted", entity_type="payment", entity_id=payment_id,
                summary=f"Posted capture journal {journal_id} for {format_money(amount_minor)}: debit settlement clearing, credit merchant payable",
                after={"journalId": journal_id, "amountMinor": amount_minor, "source": source},
            ),
        )
        return journal_id

    async def post_refund(
        self, session: AsyncSession, *, refund_id: str, payment_id: str | None, gw_payment_id: str, merchant_id: str, amount_minor: int, source: str, ctx: WriteContext
    ) -> str:
        """Posts the refund journal. Refuses if one is already in force for that refund."""
        if await self.has_live_refund_journal(session, refund_id):
            raise AppError("CONFLICT", f"Refund {refund_id} is already posted to the ledger")
        journal_id = await self._insert_journal(
            session, payment_id=payment_id, refund_id=refund_id, merchant_id=merchant_id, amount_minor=amount_minor, debit="MERCHANT_PAYABLE",
            credit="SETTLEMENT_CLEARING", source=source, memo=f"Refund {refund_id} on {gw_payment_id}",
        )
        await self._audit.record(
            session,
            audit_from(
                ctx, action="ledger.posted", entity_type="refund", entity_id=refund_id,
                summary=f"Posted refund journal {journal_id} for {format_money(amount_minor)} on {gw_payment_id}",
                after={"journalId": journal_id, "amountMinor": amount_minor, "paymentId": payment_id, "gwPaymentId": gw_payment_id},
            ),
        )
        return journal_id

    async def has_live_refund_journal(self, session: AsyncSession, refund_id: str) -> bool:
        rows = (await session.scalars(select(LedgerEntry).where(LedgerEntry.refund_id == refund_id))).all()
        return any(j.kind == "REFUND" and j.reversed_by is None for j in summarize_journals(rows))

    async def reverse_journal(self, session: AsyncSession, journal_id: str, source: str, ctx: WriteContext) -> str:
        """Posts equal and opposite legs. The original stays; a journal can be reversed only once."""
        legs = list((await session.scalars(select(LedgerEntry).where(LedgerEntry.journal_id == journal_id).with_for_update())).all())
        if not legs:
            raise not_found("Journal", journal_id)
        if any(leg.reversal_of is not None for leg in legs):
            raise AppError("CONFLICT", f"Journal {journal_id} is itself a reversal and cannot be reversed")
        already = (await session.scalars(select(LedgerEntry.id).where(LedgerEntry.reversal_of.in_([leg.id for leg in legs])).limit(1))).first()
        if already is not None:
            raise AppError("CONFLICT", f"Journal {journal_id} was already reversed")
        reversal_id = new_id("journal")
        posted_at = self._clock.now()
        session.add_all(
            LedgerEntry(
                id=new_id("ledgerEntry"), journal_id=reversal_id, payment_id=leg.payment_id, refund_id=leg.refund_id, batch_id=leg.batch_id,
                merchant_id=leg.merchant_id, account=leg.account, direction="CREDIT" if leg.direction == "DEBIT" else "DEBIT",
                amount_minor=leg.amount_minor, posted_at=posted_at, source=source, memo=f"Reversal of {journal_id}", reversal_of=leg.id,
            )
            for leg in legs
        )
        await session.flush()
        first = legs[0]
        await self._audit.record(
            session,
            audit_from(
                ctx, action="ledger.reversed", entity_type="payment" if first.payment_id else "refund", entity_id=first.payment_id or first.refund_id or journal_id,
                summary=f"Reversed journal {journal_id} ({format_money(first.amount_minor)}) with {reversal_id}",
                after={"journalId": reversal_id, "reversalOf": journal_id},
            ),
        )
        return reversal_id

    async def _insert_journal(
        self, session: AsyncSession, *, payment_id: str | None, refund_id: str | None, merchant_id: str, amount_minor: int, debit: str, credit: str, source: str, memo: str
    ) -> str:
        if amount_minor <= 0:
            raise AppError("BAD_REQUEST", f"Ledger amount must be a positive number of paise, got {amount_minor}")
        journal_id = new_id("journal")
        posted_at = self._clock.now()
        for account, direction in ((debit, "DEBIT"), (credit, "CREDIT")):
            session.add(
                LedgerEntry(
                    id=new_id("ledgerEntry"), journal_id=journal_id, payment_id=payment_id, refund_id=refund_id, merchant_id=merchant_id, account=account,
                    direction=direction, amount_minor=amount_minor, posted_at=posted_at, source=source, memo=memo, batch_id=None, reversal_of=None,
                )
            )
        await session.flush()
        return journal_id
