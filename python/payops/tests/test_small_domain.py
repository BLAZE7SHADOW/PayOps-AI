"""Metrics, webhook retry, cursors, permissions, bulk approve and handoff text (ports of the matching TypeScript tests)."""

import re
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from payops.domain.bulk_approve import (
    BULK_APPROVE_MAX_MINOR,
    BulkApprovalBody,
    BulkApproveInput,
    bulk_approve_block_reason,
)
from payops.domain.cursor import decode_cursor, encode_cursor, is_record
from payops.domain.enums import ROLES
from payops.domain.handoff_text import render_handoff_text
from payops.domain.metrics import (
    DecidedApprovalRow,
    FeedbackRow,
    ResolvedCaseRow,
    RunCostRow,
    compute_performance,
    median,
)
from payops.domain.permissions import PERMISSIONS, has_permission, permission_table_markdown, role_for
from payops.domain.webhook_retry import WEBHOOK_MAX_ATTEMPTS, is_webhook_success, webhook_retry_delay_seconds
from payops.dto.workflow import HandoffSummary
from payops.errors import AppError


def t(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


# ── metrics ──
def test_median() -> None:
    assert median([]) is None and median([5, 1, 3]) == 3
    assert median([1, 2, 3, 4]) == 3  # 2.5 rounds up


def test_nothing_to_measure_gives_nulls_not_zeros() -> None:
    m = compute_performance([], [], [], [])
    assert (
        m.resolution_time_median_ms,
        m.auto_resolution_rate,
        m.agent_accuracy,
        m.approval_turnaround_median_ms,
        m.cost_per_case_usd,
    ) == (None,) * 5


def test_each_metric_from_rows() -> None:
    m = compute_performance(
        [
            ResolvedCaseRow(t("2026-09-30T10:00:00+00:00"), t("2026-09-30T10:10:00+00:00"), "AGENT"),
            ResolvedCaseRow(t("2026-09-30T10:00:00+00:00"), t("2026-09-30T11:00:00+00:00"), "USER"),
            ResolvedCaseRow(t("2026-09-30T10:00:00+00:00"), t("2026-09-30T10:30:00+00:00"), None),
        ],
        [
            DecidedApprovalRow(t("2026-09-30T10:00:00+00:00"), t("2026-09-30T10:05:00+00:00")),
            DecidedApprovalRow(t("2026-09-30T10:00:00+00:00"), t("2026-09-30T10:15:00+00:00")),
            DecidedApprovalRow(t("2026-09-30T10:00:00+00:00"), t("2026-09-30T12:00:00+00:00")),
        ],
        [FeedbackRow("RIGHT"), FeedbackRow("RIGHT"), FeedbackRow("WRONG"), FeedbackRow("RIGHT")],
        [RunCostRow("c1", 0.02), RunCostRow("c1", 0.01), RunCostRow("c2", 0.03)],
    )
    assert m.resolution_time_median_ms == 30 * 60_000 and m.resolved_count == 3
    assert m.auto_resolution_rate == pytest.approx(1 / 3)
    assert (m.agent_accuracy, m.rated_count, m.approval_turnaround_median_ms) == (0.75, 4, 15 * 60_000)
    assert m.cost_per_case_usd == pytest.approx(0.03) and m.cases_with_runs == 2
    assert m.to_json()["resolutionTimeMedianMs"] == 30 * 60_000


# ── webhook retry ──
def test_retry_backs_off_gives_up_and_has_nothing_before_the_first_attempt() -> None:
    assert [webhook_retry_delay_seconds(n) for n in (1, 2, 3, 4)] == [60, 300, 1800, 7200]
    assert (
        webhook_retry_delay_seconds(WEBHOOK_MAX_ATTEMPTS) is None
        and webhook_retry_delay_seconds(WEBHOOK_MAX_ATTEMPTS + 3) is None
    )
    assert webhook_retry_delay_seconds(0) is None


def test_only_2xx_counts_as_processed() -> None:
    assert all(is_webhook_success(s) for s in (200, 204))
    assert not any(is_webhook_success(s) for s in (None, 409, 500, 302))


# ── cursors ──
def test_cursors_round_trip_and_reject_garbage() -> None:
    value = {"priority": 2012499, "id": "case_1", "t": "é"}
    cursor = encode_cursor(value)
    assert "=" not in cursor and "+" not in cursor and "/" not in cursor
    assert decode_cursor(cursor, is_record) == value
    assert decode_cursor(None, is_record) is None and decode_cursor("", is_record) is None
    for bad in ("not base64!!", encode_cursor([1, 2])):
        with pytest.raises(AppError) as err:
            decode_cursor(bad, is_record)
        assert err.value.code == "BAD_REQUEST"


# ── permissions ──
def test_a_higher_role_keeps_everything_a_lower_one_has() -> None:
    for key in PERMISSIONS:
        allowed = [r for r in ROLES if has_permission(r, key)]
        assert allowed[0] == role_for(key)
        assert allowed == list(ROLES[ROLES.index(role_for(key)) :])


def test_signed_out_users_get_nothing_and_roles_keep_their_limits() -> None:
    assert not has_permission(None, "overview.view")
    assert not has_permission("VIEWER", "resolution.propose") and not has_permission("OPS", "agent.control")
    assert (
        has_permission("MANAGER", "agent.control")
        and not has_permission("MANAGER", "user.mfaReset")
        and has_permission("ADMIN", "user.mfaReset")
    )
    assert len(permission_table_markdown().split("\n")) == 2 + len(PERMISSIONS)


def test_the_architecture_doc_matches_the_permission_table() -> None:
    doc = (Path(__file__).resolve().parents[3] / "docs" / "02-architecture.md").read_text(encoding="utf-8")
    match = re.search(r"<!-- permissions:start -->\n([\s\S]*?)\n<!-- permissions:end -->", doc)
    assert match, "permissions markers missing in docs/02-architecture.md"
    assert match.group(1) == permission_table_markdown()


# ── bulk approve ──
OK = BulkApproveInput("OPS", "LOW", 2_000_00, ["P4"], ["INITIATE_REFUND"], False)


def test_bulk_approve_allows_an_ops_tier_low_risk_proposal_under_the_limit() -> None:
    assert bulk_approve_block_reason(OK) is None
    assert bulk_approve_block_reason(BulkApproveInput("OPS", "LOW", BULK_APPROVE_MAX_MINOR, ["P4"], [], False)) is None


def test_bulk_approve_blocks_the_rest() -> None:
    def blocked(**o: object) -> str:
        return bulk_approve_block_reason(BulkApproveInput(**{**OK.__dict__, **o})) or ""  # type: ignore[arg-type]

    assert all("OPS tier" in blocked(tier=x) for x in ("MANAGER", "BLOCKED", "AUTO"))
    assert re.search("risk", blocked(risk_tier="MEDIUM"), re.I) and "limit" in blocked(
        money_moving_minor=BULK_APPROVE_MAX_MINOR + 1
    )
    assert re.search("quarantined", blocked(quarantined=True), re.I)
    assert re.search("repeat", blocked(rule_ids=["P4", "P7"]), re.I) and re.search(
        "confidence", blocked(rule_ids=["P8"]), re.I
    )


def test_bulk_approval_body_needs_one_to_twenty_five_ids() -> None:
    assert BulkApprovalBody.model_validate({"ids": ["apr_1"]}).comment == ""
    with pytest.raises(ValidationError):
        BulkApprovalBody.model_validate({"ids": []})
    with pytest.raises(ValidationError):
        BulkApprovalBody.model_validate({"ids": [f"apr_{i}" for i in range(26)]})


# ── handoff text ──
BASE = {
    "generatedAt": "2026-09-28T12:00:00.000Z",
    "sinceHours": 8,
    "since": "2026-09-28T04:00:00.000Z",
    "open": {
        "total": 3,
        "overdue": 1,
        "awaitingApproval": 1,
        "unassigned": 2,
        "bySeverity": {"CRITICAL": 1, "HIGH": 1, "MEDIUM": 1, "LOW": 0},
    },
    "needsAttention": [],
    "resolved": {"total": 2, "by": {"AGENT": 1, "USER": 1, "SYSTEM": 0}},
    "recentNotes": [],
}


def test_handoff_states_counts_and_says_nothing_needs_attention() -> None:
    text = render_handoff_text(HandoffSummary.model_validate(BASE))
    assert "last 8 hours" in text
    assert "Open: 3 (critical 1, high 1, medium 1, low 0). 1 overdue, 1 waiting for approval, 2 unassigned." in text
    assert "Resolved: 2 (agent 1, people 1, system 0)." in text and "Needs attention: nothing." in text
    assert "Notes this shift" not in text


def test_handoff_lists_cases_with_owner_and_notes() -> None:
    note = {"text": "Bank confirmed.", "authorName": "Ananya Rao", "at": "2026-09-28T11:00:00.000Z"}
    summary = {
        **BASE,
        "sinceHours": 1,
        "needsAttention": [
            {
                "id": "case_1",
                "displayId": "PAY-0001",
                "type": "PAYMENT_MISMATCH",
                "severity": "HIGH",
                "status": "AWAITING_APPROVAL",
                "amountMinor": 1_249_900,
                "dueAt": "2026-09-28T16:00:00.000Z",
                "overdue": False,
                "assigneeName": "Rahul Menon",
                "reasons": ["Waiting for approval"],
                "lastNote": note,
            }
        ],
        "recentNotes": [{"caseId": "case_1", "displayId": "PAY-0001", **note}],
    }
    text = render_handoff_text(HandoffSummary.model_validate(summary))
    assert "last 1 hour " in text
    assert re.search(r"- PAY-0001 Payment mismatch, ₹12,499\.00, Waiting for approval, due in 4h, Rahul Menon", text)
    assert "  Note from Ananya Rao: Bank confirmed." in text and "- PAY-0001, Ananya Rao: Bank confirmed." in text
    assert render_handoff_text(HandoffSummary.model_validate(BASE)) == render_handoff_text(
        HandoffSummary.model_validate(BASE)
    )
    assert UTC is not None
