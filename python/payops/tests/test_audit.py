"""Audit chain and CSV (ports of packages/core audit/chain.test.ts and csv.test.ts, plus hashes computed by the TypeScript code)."""

from datetime import UTC, datetime

from payops.domain.audit import (
    GENESIS_HASH,
    ChainFields,
    ChainRow,
    canonical_json,
    compute_audit_hash,
    csv_cell,
    csv_line,
    reseal,
    sealed,
    verify_audit_chain,
)


def link(prev: ChainRow | None, seq: int, **over: object) -> ChainRow:
    fields = dict(
        seq=seq,
        id=f"audit_{seq}",
        at=datetime(2026, 9, 30, 10, 0, seq, tzinfo=UTC),
        actor_type="USER",
        actor_id="u1",
        actor_name="Ananya Rao",
        action="case.note",
        entity_type="case",
        entity_id="case_1",
        summary=f"event {seq}",
        before=None,
        after={"b": 1, "a": 2},
        run_id=None,
        case_id="case_1",
        prev_hash=prev.hash if prev else GENESIS_HASH,
    )
    return sealed(ChainFields(**{**fields, **over}))  # type: ignore[arg-type]


def chain(n: int) -> list[ChainRow]:
    rows: list[ChainRow] = []
    for i in range(1, n + 1):
        rows.append(link(rows[i - 2] if i > 1 else None, i))
    return rows


def test_hashes_match_the_typescript_implementation() -> None:
    # Reference values computed with packages/core audit/chain.ts.
    first = ChainFields(
        seq=1,
        id="aud_1",
        at=datetime(2026, 9, 28, 12, 0, tzinfo=UTC),
        actor_type="USER",
        actor_id="usr_1",
        actor_name="Meera Iyer",
        action="case.opened",
        entity_type="case",
        entity_id="case_1",
        summary='Opened PAY-0001: ₹12,499.00 — "quoted"\nnext',
        before=None,
        after={
            "status": "OPEN",
            "amountMinor": 1249900,
            "tags": ["b", "a"],
            "nested": {"z": 1.5, "a": 0.1, "e": 1e21, "f": -0.0},
        },
        run_id=None,
        case_id="case_1",
        prev_hash="0" * 64,
    )
    second = ChainFields(
        seq=2,
        id="aud_2",
        at=datetime(2026, 9, 28, 12, 0, 1, 123000, tzinfo=UTC),
        actor_type="AGENT",
        actor_id="run_1",
        actor_name="Agent 😀",
        action="resolution.executed",
        entity_type="resolution",
        entity_id="rsl_1",
        summary="x",
        before={"b": []},
        after=[1, 2.5, "é"],
        run_id="run_1",
        case_id=None,
        prev_hash="abc",
    )
    assert compute_audit_hash(first) == "85903c51a7e0fdecf3b8cf158da1c39bf35abe22280c4e6abcb4637c6471530a"
    assert compute_audit_hash(second) == "388483f9b63e43e51b6fef95635cf83b276feff8c63ea1a7d0c6ecd4052958c4"
    assert canonical_json(
        {"b": 1, "a": [True, None, "x"], "😀": 1, "é": 2, "z": 1e-7, "big": 123456789012345680000}
    ) == ('{"a":[true,null,"x"],"b":1,"big":123456789012345680000,"z":1e-7,"é":2,"😀":1}')


def test_canonical_json_sorts_keys_at_every_depth() -> None:
    assert (
        canonical_json({"b": 1, "a": {"d": 1, "c": [2, {"z": 1, "y": 2}]}})
        == '{"a":{"c":[2,{"y":2,"z":1}],"d":1},"b":1}'
    )
    assert canonical_json(None) == "null"


def test_an_untouched_chain_passes_and_an_empty_one_too() -> None:
    assert verify_audit_chain(chain(5)).ok and verify_audit_chain(chain(5)).checked == 5
    assert verify_audit_chain([]).ok


def test_editing_a_field_or_a_nested_value_breaks_the_hash() -> None:
    rows = chain(5)
    from dataclasses import replace

    rows[2] = replace(rows[2], summary="nothing to see here")
    v = verify_audit_chain(rows)
    assert (v.ok, v.seq, v.reason) == (False, 3, "HASH_MISMATCH")
    rows = chain(4)
    rows[1] = replace(rows[1], after={"a": 3, "b": 1})
    v = verify_audit_chain(rows)
    assert (v.seq, v.reason) == (2, "HASH_MISMATCH")


def test_a_deleted_middle_row_is_a_gap_and_a_deleted_tail_needs_a_head() -> None:
    rows = chain(5)
    del rows[2]
    v = verify_audit_chain(rows)
    assert (v.seq, v.reason) == (4, "SEQ_GAP")
    full = chain(5)
    head = (full[4].seq, full[4].hash)
    full.pop()
    assert verify_audit_chain(full).ok
    assert verify_audit_chain(full, expected_head=head).reason == "TRUNCATED"


def test_a_rewritten_row_with_its_own_hash_breaks_the_next_link() -> None:
    rows = chain(4)
    rows[1] = reseal(rows[1], summary="rewritten")
    v = verify_audit_chain(rows)
    assert (v.seq, v.reason) == (3, "PREV_MISMATCH")


def test_the_first_row_must_start_from_genesis_unless_told_otherwise() -> None:
    rows = chain(3)
    rows[0] = link(None, 1, prev_hash="abc")
    v = verify_audit_chain(rows)
    assert (v.seq, v.reason) == (1, "PREV_MISMATCH")
    six = chain(6)
    ok = verify_audit_chain(six[3:], start_after=(3, six[2].hash))
    assert ok.ok and ok.checked == 3


# ── CSV ──
def test_csv_cells() -> None:
    assert csv_cell("Case opened") == "Case opened"
    assert (
        csv_cell("a,b") == '"a,b"'
        and csv_cell('say "hi"') == '"say ""hi"""'
        and csv_cell("two\nlines") == '"two\nlines"'
    )
    assert (
        csv_cell("=SUM(A1:A9)") == "'=SUM(A1:A9)"
        and csv_cell("+91 98000") == "'+91 98000"
        and csv_cell("-1") == "'-1"
        and csv_cell("@cmd") == "'@cmd"
    )
    assert csv_cell({"a": 1}) == '"{""a"":1}"' and csv_cell(None) == "" and csv_cell(7) == "7"
    assert csv_line(["a", "b"]) == "a,b\r\n"
