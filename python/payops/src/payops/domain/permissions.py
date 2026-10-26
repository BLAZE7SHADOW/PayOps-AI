"""The one role and permission table. Routes, services and the UI all read it, and docs/02-architecture.md §7 is checked against it in a test, so
the code and the docs cannot drift.

Roles are ranked VIEWER < OPS < MANAGER < ADMIN. A permission names the lowest role that has it; higher roles have it too. Some permissions carry
an extra rule that code enforces on top of the role (four-eyes, tier, ownership). Those are written in `extra` so a reader sees them in one place.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from .enums import role_at_least


@dataclass(frozen=True)
class PermissionDef:
    #: Lowest role that has this permission.
    role: str
    #: Plain description for the docs table.
    what: str
    #: Rule enforced in code beyond the role, or None.
    extra: str | None = None


PERMISSIONS: Final[dict[str, PermissionDef]] = {
    # Reading
    "overview.view": PermissionDef("VIEWER", "See the Overview metrics"),
    "payment.view": PermissionDef("VIEWER", "List payments and open a payment"),
    "case.view": PermissionDef("VIEWER", "List cases, open a case, its notes and source records"),
    "run.view": PermissionDef("VIEWER", "See agent runs, steps and feedback"),
    "approval.view": PermissionDef("VIEWER", "See the approval queue and one approval"),
    "audit.view": PermissionDef("VIEWER", "Read the audit log"),
    "audit.verify": PermissionDef("MANAGER", "Check the audit log for tampering and export it as CSV"),
    "policy.view": PermissionDef("VIEWER", "Read the policy rules"),
    "webhook.view": PermissionDef("VIEWER", "Read the webhook event log"),
    "agent.view": PermissionDef("VIEWER", "See agent controls"),
    "handoff.view": PermissionDef("VIEWER", "Read the shift handoff summary"),
    "view.manage": PermissionDef("VIEWER", "Save and delete your own saved views", "Own views only"),
    "account.security": PermissionDef("VIEWER", "Manage your own MFA and signed-in browsers", "Own account only"),
    # Working cases
    "case.assign": PermissionDef("OPS", "Take a case or hand it back", "The assignee must be OPS or above"),
    "case.note": PermissionDef("OPS", "Write a case note"),
    "run.start": PermissionDef("OPS", "Start an agent investigation on a case"),
    "run.feedback": PermissionDef("OPS", "Mark a diagnosis right or wrong"),
    "resolution.propose": PermissionDef("OPS", "Preview and propose a resolution", "Policy decides the tier"),
    "resolution.undo": PermissionDef("OPS", "Propose an undo of a ledger post", "Goes through the normal approval"),
    "webhook.replay": PermissionDef("OPS", "Replay a webhook event"),
    "approval.decide": PermissionDef(
        "OPS", "Approve or reject a resolution", "MANAGER-tier approvals need MANAGER or ADMIN. Four-eyes: never your own proposal"
    ),
    "approval.bulk": PermissionDef("OPS", "Bulk approve low-risk approvals", "Same tier and four-eyes rules per item"),
    # Control
    "agent.control": PermissionDef("MANAGER", "Pause or limit the agent"),
    "simulator.use": PermissionDef("ADMIN", "Use the simulator: scenarios, reset, undo reset", "OPS when DEMO_MODE is on"),
    # Administration
    "user.mfaReset": PermissionDef("ADMIN", "Reset another user's MFA"),
    "user.sessionsRevoke": PermissionDef("ADMIN", "Sign a user out of every browser"),
}


def role_for(permission: str) -> str:
    return PERMISSIONS[permission].role


def has_permission(role: str | None, permission: str) -> bool:
    return role is not None and role_at_least(role, PERMISSIONS[permission].role)


def permission_table_markdown() -> str:
    """Markdown table for docs/02-architecture.md §7. The docs test compares the doc against this."""
    rows = [f"| `{key}` | {p.role} | {p.what} | {p.extra or '-'} |" for key, p in PERMISSIONS.items()]
    return "\n".join(["| Permission | Lowest role | What it allows | Extra rule |", "|---|---|---|---|", *rows])
