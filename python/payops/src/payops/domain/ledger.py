"""Pure helpers over ledger rows (packages/core ledger.service.ts): journals and which ones are still in force."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from ..db.models import LedgerEntry


@dataclass(frozen=True)
class JournalSummary:
    journal_id: str
    kind: str  # CAPTURE | REFUND | REVERSAL
    amount_minor: int
    posted_at: datetime
    source: str
    memo: str
    legs: list[LedgerEntry]
    #: Journal that reversed this one, if any.
    reversed_by: str | None


def summarize_journals(entries: Sequence[LedgerEntry]) -> list[JournalSummary]:
    """Groups ledger rows into journals (oldest first) and marks which ones were reversed."""
    by_journal: dict[str, list[LedgerEntry]] = {}
    for e in sorted(entries, key=lambda e: (e.posted_at, e.id)):
        by_journal.setdefault(e.journal_id, []).append(e)
    reversed_by = {e.reversal_of: e.journal_id for e in entries if e.reversal_of}
    out: list[JournalSummary] = []
    for journal_id, legs in by_journal.items():
        first = legs[0]
        kind = "REVERSAL" if first.reversal_of else "REFUND" if first.refund_id else "CAPTURE"
        reverser = next((reversed_by[leg.id] for leg in legs if leg.id in reversed_by), None)
        out.append(JournalSummary(journal_id, kind, first.amount_minor, first.posted_at, first.source, first.memo, legs, reverser))
    return out


def live_capture_journals(entries: Sequence[LedgerEntry]) -> list[JournalSummary]:
    """Capture journals for a payment that are still in force (posted and not reversed)."""
    return [j for j in summarize_journals(entries) if j.kind == "CAPTURE" and j.reversed_by is None]
