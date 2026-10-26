from datetime import UTC, datetime, timedelta

import pytest

from payops.domain.ids import case_display_id, hash_seed, mulberry32, new_id, seeded_ids
from payops.domain.money import amount_band, bps_of, format_money, format_money_compact, to_minor
from payops.domain.timeutil import SLA_HOURS, age_label, due_at_for, due_label, is_overdue


# ── money (cases from packages/shared money.test.ts) ──
def test_parses_rupees_into_paise_without_float_drift() -> None:
    assert to_minor("12499") == 1_249_900
    assert to_minor("12,499.5") == 1_249_950
    assert to_minor("0.1") == 10
    assert to_minor("₹78,000.00") == 7_800_000
    assert to_minor(0.29) == 29


def test_floats_round_like_javascript_to_fixed() -> None:
    # Reference values from the TypeScript implementation.
    assert to_minor(0.125) == 13  # an exact tie goes up
    assert to_minor(1.005) == 100  # 1.005 is just below the tie in binary
    assert to_minor("-5.5") == -550


def test_rejects_malformed_input() -> None:
    for bad in ("12.345", "abc"):
        with pytest.raises(TypeError):
            to_minor(bad)


def test_formats_with_indian_grouping() -> None:
    assert format_money(1_249_900) == "₹12,499.00"
    assert format_money(1_00_00_000_00) == "₹1,00,00,000.00"
    assert format_money(1_249_900, symbol=False) == "12,499.00"
    assert format_money(5) == "₹0.05" and format_money(0) == "₹0.00"
    assert format_money(-123456789) == "-₹12,34,567.89"


def test_formats_compact_amounts() -> None:
    assert format_money_compact(4_20_00_000_00) == "₹4.2 Cr"
    assert format_money_compact(12_50_000_00) == "₹12.5 L"
    assert format_money_compact(12_499_00) == "₹12,499"
    assert format_money_compact(99_999_00) == "₹99,999"
    assert format_money_compact(1_00_000_00) == "₹1 L"
    assert format_money_compact(12_34_567_89) == "₹12.3 L"


def test_bands_amounts_at_the_documented_thresholds() -> None:
    assert [amount_band(x) for x in (999_99, 1_000_00, 10_000_00, 50_000_00)] == ["LOW", "MEDIUM", "HIGH", "CRITICAL"]


def test_basis_point_fees_stay_in_integers() -> None:
    assert bps_of(1_249_900, 200) == 24_998
    assert bps_of(101, 50) == 1


def test_refuses_non_integer_minor_amounts() -> None:
    with pytest.raises(TypeError):
        format_money(10.5)


# ── ids ──
def test_ids_are_prefixed() -> None:
    import re

    assert re.fullmatch(r"pay_[0-9a-z]{14}", new_id("payment"))


def test_seeded_ids_are_deterministic() -> None:
    a, b = seeded_ids("scenario-1"), seeded_ids("scenario-1")
    assert [a.next("order"), a.int(1, 100)] == [b.next("order"), b.int(1, 100)]


def test_seeded_output_matches_the_typescript_generator_exactly() -> None:
    # Reference values computed with packages/shared ids.ts.
    assert [hash_seed("scenario-1"), hash_seed("héllo 😀"), hash_seed("")] == [4087793461, 1308241232, 2166136261]
    rng = mulberry32(42)
    assert [rng(), rng(), rng()] == [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]
    g = seeded_ids("scenario-1")
    assert [g.next("order"), g.next("payment"), g.int(1, 100), g.pick(["a", "b", "c", "d"]), g.float(), g.next("case")] == [
        "ord_1c9ephp3ahv76f", "pay_mf0yrd9dvgw4ht", 17, "c", 0.22284113359637558, "case_pfva3faf34hdhd",
    ]
    n = seeded_ids(1234)
    assert [n.next("refund"), n.int(5, 9), n.float()] == ["rfd_2pwz135sc4hazh", 6, 0.41534881736151874]


def test_case_display_ids() -> None:
    assert case_display_id("PAY", 42) == "PAY-0042"


# ── SLA and time ──
OPENED = datetime(2026, 9, 29, 10, 0, tzinfo=UTC)


def test_due_at_adds_the_severity_window() -> None:
    assert due_at_for("CRITICAL", OPENED).isoformat() == "2026-09-29T14:00:00+00:00"
    assert due_at_for("HIGH", OPENED).isoformat() == "2026-09-29T18:00:00+00:00"
    assert due_at_for("MEDIUM", OPENED).isoformat() == "2026-09-30T10:00:00+00:00"
    assert due_at_for("LOW", OPENED).isoformat() == "2026-10-02T10:00:00+00:00"
    assert SLA_HOURS["CRITICAL"] < SLA_HOURS["HIGH"] < SLA_HOURS["MEDIUM"] < SLA_HOURS["LOW"]


def test_overdue_only_while_open_and_past_due() -> None:
    due = datetime(2026, 9, 29, 14, 0, tzinfo=UTC)
    assert not is_overdue(due, True, datetime(2026, 9, 29, 13, 59, 59, tzinfo=UTC))
    assert not is_overdue(due, True, due)
    assert is_overdue(due, True, datetime(2026, 9, 29, 14, 0, 1, tzinfo=UTC))
    assert not is_overdue(due, False, datetime(2026, 9, 30, tzinfo=UTC))
    assert not is_overdue(None, True, datetime(2026, 9, 30, tzinfo=UTC))


NOW = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)


def at(**delta: float) -> datetime:
    return NOW + timedelta(**delta)


def test_due_label_counts_down_up_and_says_due_now() -> None:
    assert due_label(at(hours=3, minutes=20), NOW) == "in 3h"
    assert due_label(at(minutes=45), NOW) == "in 45m"
    assert due_label(at(hours=30), NOW) == "in 1d"
    assert due_label(at(hours=-2, minutes=-5), NOW) == "2h late"
    assert due_label(at(minutes=-10), NOW) == "10m late"
    assert due_label(at(hours=-49), NOW) == "2d late"
    assert due_label(at(seconds=30), NOW) == "due now" and due_label(at(seconds=-30), NOW) == "due now"


def test_age_label() -> None:
    assert age_label(at(seconds=-20), NOW) == "now" and age_label(at(hours=-3), NOW) == "3h" and age_label(at(days=-9), NOW) == "9d"
