"""The operator's switch for the agent (D066). PAUSED stops new investigations and keeps any in-flight fix for a person;
PROPOSE_ONLY lets the agent investigate and propose but every fix waits for a person. Policy rule P12 enforces it; this
service only stores the setting."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AgentControl
from ..domain.timeutil import to_iso
from ..dto.api import AgentControlItem

ROW_ID = "global"


async def read_agent_control_mode(session: AsyncSession) -> str:
    """The current mode. NORMAL when nobody has ever changed it."""
    row = await session.get(AgentControl, ROW_ID)
    return row.mode if row else "NORMAL"


class AgentControlService:
    async def get(self, session: AsyncSession) -> AgentControlItem:
        row = await session.get(AgentControl, ROW_ID)
        if row is None:
            return AgentControlItem(mode="NORMAL", reason="", changed_by_name=None, changed_at=None)
        return AgentControlItem(
            mode=row.mode, reason=row.reason, changed_by_name=row.changed_by_name, changed_at=to_iso(row.updated_at)
        )
