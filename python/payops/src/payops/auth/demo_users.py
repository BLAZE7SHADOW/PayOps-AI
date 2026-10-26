"""Seeded demo accounts. Idempotent: existing emails are left alone. All use DEMO_PASSWORD."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..domain.ids import seeded_ids
from .password import hash_password

DEMO_PASSWORD = "payops-demo"


@dataclass(frozen=True)
class DemoAccount:
    email: str
    name: str
    role: str
    label: str


DEMO_ACCOUNTS = (
    DemoAccount("ops@payops.dev", "Ananya Rao", "OPS", "Ops analyst"),
    DemoAccount("ops2@payops.dev", "Rahul Menon", "OPS", "Second ops analyst"),
    DemoAccount("manager@payops.dev", "Meera Iyer", "MANAGER", "Ops manager"),
    DemoAccount("viewer@payops.dev", "Kabir Shah", "VIEWER", "Viewer"),
    DemoAccount("admin@payops.dev", "Admin", "ADMIN", "Admin"),
)

# The ids come from a fixed seed, so they are the same on every run and match the ones already in the database.
_ids = seeded_ids("demo-users")
DEMO_IDS = {a.email: _ids.next("user") for a in DEMO_ACCOUNTS}


def is_demo_email(email: str) -> bool:
    return email in DEMO_IDS


async def seed_demo_users(session: AsyncSession) -> int:
    """Inserts missing demo users. Returns how many were created."""
    have = set(
        (await session.scalars(select(User.email).where(User.email.in_([a.email for a in DEMO_ACCOUNTS])))).all()
    )
    created = 0
    now = datetime.now(UTC)
    for account in DEMO_ACCOUNTS:
        if account.email in have:
            continue
        session.add(
            User(
                id=DEMO_IDS[account.email],
                email=account.email,
                name=account.name,
                role=account.role,
                password_hash=hash_password(DEMO_PASSWORD),
                totp_secret_sealed=None,
                totp_enabled_at=None,
                totp_last_step=None,
                created_at=now,
                updated_at=now,
            )
        )
        created += 1
    await session.flush()
    return created
