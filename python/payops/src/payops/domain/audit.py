"""Tamper-evident audit chain (D077) and the CSV export of the log.

Every audit row stores `hash = sha256(its own fields + the previous row's hash)`. Editing or removing any row breaks its
own hash or the next row's `prev_hash`, and `verify_audit_chain` reports the first place it breaks. This proves the log
was changed; it cannot prevent a database owner from rewriting the whole tail and recomputing every hash. The database
triggers stop ordinary writes, and an exported head (seq + hash) kept elsewhere closes the rest.

The hash input has to be byte-identical to the TypeScript API's, or every existing row would fail verification.
`canonical_json` therefore sorts keys the way JavaScript does and prints numbers the way `JSON.stringify` does."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Final

from ..jsonjs import js_number
from .timeutil import to_iso

#: `prev_hash` of the very first chained row.
GENESIS_HASH: Final = "0" * 64


@dataclass(frozen=True)
class ChainFields:
    """The fields that are hashed, in one fixed order. Adding a field later means a new chain version."""

    seq: int
    id: str
    at: datetime
    actor_type: str
    actor_id: str
    actor_name: str
    action: str
    entity_type: str
    entity_id: str
    summary: str
    before: Any
    after: Any
    run_id: str | None
    case_id: str | None
    prev_hash: str


@dataclass(frozen=True)
class ChainRow(ChainFields):
    hash: str = ""


def canonical_json(value: Any) -> str:
    """JSON with object keys sorted at every depth. Postgres jsonb does not keep key order, so plain `json.dumps` would
    not round-trip."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        # JavaScript sorts keys by UTF-16 code unit, which differs from code point order only for characters outside the
        # BMP.
        keys = sorted(value, key=lambda k: str(k).encode("utf-16-be"))
        return (
            "{" + ",".join(f"{json.dumps(str(k), ensure_ascii=False)}:{canonical_json(value[k])}" for k in keys) + "}"
        )
    raise TypeError(f"cannot hash {type(value).__name__}")


def compute_audit_hash(f: ChainFields) -> str:
    payload = canonical_json(
        [
            f.seq,
            f.id,
            to_iso(f.at),
            f.actor_type,
            f.actor_id,
            f.actor_name,
            f.action,
            f.entity_type,
            f.entity_id,
            f.summary,
            f.before,
            f.after,
            f.run_id,
            f.case_id,
            f.prev_hash,
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ChainVerdict:
    ok: bool
    checked: int
    #: Where the chain broke, when it did.
    seq: int | None = None
    id: str | None = None
    reason: str | None = None  # HASH_MISMATCH | PREV_MISMATCH | SEQ_GAP | TRUNCATED


def verify_audit_chain(
    rows: Sequence[ChainRow],
    *,
    start_after: tuple[int, str] | None = None,
    expected_head: tuple[int, str] | None = None,
) -> ChainVerdict:
    """Rows must be ordered by ascending seq. Stops at the first broken row. `start_after` is (seq, hash) of the link
    before the first row; `expected_head` is a (seq, hash) recorded earlier, and the chain fails if it now ends before
    it."""
    prev_seq, prev_hash = start_after if start_after else (0, GENESIS_HASH)
    checked = 0
    for row in rows:
        if row.seq != prev_seq + 1:
            return ChainVerdict(False, checked, row.seq, row.id, "SEQ_GAP")
        if row.prev_hash != prev_hash:
            return ChainVerdict(False, checked, row.seq, row.id, "PREV_MISMATCH")
        if compute_audit_hash(row) != row.hash:
            return ChainVerdict(False, checked, row.seq, row.id, "HASH_MISMATCH")
        prev_seq, prev_hash = row.seq, row.hash
        checked += 1
    if expected_head is not None:
        head_seq, head_hash = expected_head
        if prev_seq < head_seq or (prev_seq == head_seq and prev_hash != head_hash):
            return ChainVerdict(False, checked, None, None, "TRUNCATED")
    return ChainVerdict(True, checked)


def sealed(fields: ChainFields) -> ChainRow:
    """A row with its hash computed."""
    return ChainRow(**{**fields.__dict__, "hash": compute_audit_hash(fields)})


def reseal(row: ChainRow, **changes: Any) -> ChainRow:
    """A copy with changes and a freshly computed hash (tests use it to forge a self-consistent rewrite)."""
    return sealed(replace(row, **changes))


# ── CSV ──────────────────────────────────────────────────────────────────────
_FORMULA_START: Final = ("=", "+", "-", "@", "\t", "\r")


def csv_cell(value: Any) -> str:
    """Quotes every cell that needs it and defuses spreadsheet formulas: a cell that starts with = + - @ tab or CR would
    run as a formula when opened in Excel, so it gets a leading apostrophe. Audit summaries contain user-typed names and
    notes, so this matters."""
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    elif isinstance(value, bool):
        text = "true" if value else "false"
    elif isinstance(value, (int, float)):
        text = js_number(value)
    else:
        text = canonical_json_plain(value)
    if text.startswith(_FORMULA_START):
        text = f"'{text}"
    if any(c in text for c in ('"', ",", "\n", "\r")):
        return '"' + text.replace('"', '""') + '"'
    return text


def canonical_json_plain(value: Any) -> str:
    """`JSON.stringify` of an object or array, keys in insertion order."""
    from ..jsonjs import js_dumps

    return js_dumps(value)


def csv_line(cells: Sequence[Any]) -> str:
    return ",".join(csv_cell(c) for c in cells) + "\r\n"
