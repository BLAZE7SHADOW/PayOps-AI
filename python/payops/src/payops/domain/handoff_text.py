"""Plain-text version of a shift handoff (D068), for pasting into chat or email. Pure and deterministic: the same summary always gives the same text."""

from __future__ import annotations

from ..dto.workflow import HandoffSummary
from .enums import CASE_TYPE_LABEL
from .money import format_money
from .timeutil import due_label, parse_iso


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def render_handoff_text(h: HandoffSummary) -> str:
    now = parse_iso(h.generated_at)
    lines = [f"Shift handoff, last {_plural(h.since_hours, 'hour')} (generated {h.generated_at})", ""]
    s = h.open.by_severity
    lines.append(
        f"Open: {h.open.total} (critical {s['CRITICAL']}, high {s['HIGH']}, medium {s['MEDIUM']}, low {s['LOW']}). "
        f"{h.open.overdue} overdue, {h.open.awaiting_approval} waiting for approval, {h.open.unassigned} unassigned."
    )
    lines.append(f"Resolved: {h.resolved.total} (agent {h.resolved.by['AGENT']}, people {h.resolved.by['USER']}, system {h.resolved.by['SYSTEM']}).")
    lines.append("")
    if not h.needs_attention:
        lines.append("Needs attention: nothing.")
    else:
        lines.append("Needs attention:")
        for c in h.needs_attention:
            due = f", due {due_label(parse_iso(c.due_at), now)}" if c.due_at else ""
            who = c.assignee_name or "unassigned"
            lines.append(f"- {c.display_id} {CASE_TYPE_LABEL[c.type]}, {format_money(c.amount_minor)}, {', '.join(c.reasons)}{due}, {who}")
            if c.last_note:
                lines.append(f"  Note from {c.last_note.author_name}: {c.last_note.text}")
    if h.recent_notes:
        lines.append("")
        lines.append("Notes this shift:")
        for n in h.recent_notes:
            lines.append(f"- {n.display_id}, {n.author_name}: {n.text}")
    return "\n".join(lines)
