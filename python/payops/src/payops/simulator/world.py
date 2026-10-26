"""Base data every scenario draws from: merchants with fee contracts, customers and their devices. Ids come from a fixed seed, and inserts use ON CONFLICT
DO NOTHING, so seeding is idempotent."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Customer, Device, Merchant
from ..domain.ids import seeded_ids
from ..domain.mask import mask_email, mask_phone
from ..domain.timeutil import DAY_MS


@dataclass(frozen=True)
class WorldMerchant:
    key: str
    id: str
    name: str
    fee_bps: int
    tax_bps: int
    fee_fixed_minor: int


@dataclass(frozen=True)
class WorldCustomer:
    id: str
    name: str
    device_id: str
    home_country: str


@dataclass(frozen=True)
class World:
    merchants: dict[str, WorldMerchant]
    customers: list[WorldCustomer]


@dataclass(frozen=True)
class _CustomerRow:
    id: str
    name: str
    email: str
    phone: str
    age_days: int
    device_id: str
    fingerprint: str


_MERCHANTS = (("kavya", "Kavya Electronics", 200), ("northwind", "Northwind Grocers", 180), ("tandem", "Tandem Travel", 220))
_CUSTOMER_NAMES = (
    "Aarav Sharma", "Priya Iyer", "Rohan Mehta", "Ananya Reddy", "Vikram Nair", "Sneha Kulkarni", "Arjun Patel", "Kavya Menon", "Ishaan Gupta", "Meera Pillai",
    "Aditya Joshi", "Diya Banerjee", "Karthik Subramanian", "Neha Deshpande", "Rahul Verma", "Pooja Chatterjee", "Siddharth Rao", "Tanvi Shetty", "Nikhil Agarwal",
    "Riya Kapoor", "Varun Hegde", "Aisha Khan", "Manish Tiwari", "Lakshmi Krishnan",
)  # fmt: skip
_EMAIL_DOMAINS = ("gmail.com", "outlook.com", "yahoo.co.in", "rediffmail.com")


def _build_world() -> tuple[World, list[_CustomerRow]]:
    """The world's ids and names are a pure function of the fixed seed. The order of every call on the generator matters: it is the TypeScript order."""
    gen = seeded_ids("world")
    merchants = {key: WorldMerchant(key, gen.next("merchant"), name, fee_bps, 1800, 0) for key, name, fee_bps in _MERCHANTS}
    rows: list[_CustomerRow] = []
    for name in _CUSTOMER_NAMES:
        first, last = name.lower().split(" ")
        customer_id = gen.next("customer")
        email = f"{first}.{last}{gen.int(1, 99)}@{gen.pick(_EMAIL_DOMAINS)}"
        phone = f"+91 9{gen.int(100_000_000, 999_999_999)}"
        age_days = gen.int(30, 900)
        device_id = gen.next("device")
        fingerprint = f"fp_{gen.int(1_000_000, 9_999_999):x}"
        rows.append(_CustomerRow(customer_id, name, email, phone, age_days, device_id, fingerprint))
    return World(merchants, [WorldCustomer(r.id, r.name, r.device_id, "IN") for r in rows]), rows


WORLD, _ROWS = _build_world()


async def seed_world(session: AsyncSession, now: datetime) -> World:
    """Inserts merchants, customers and devices if missing. Safe to call on every generate."""

    def at(days: int) -> datetime:
        return now - timedelta(milliseconds=days * DAY_MS)

    await session.execute(
        pg_insert(Merchant)
        .values(
            [
                {
                    "id": m.id, "name": m.name, "fee_bps": m.fee_bps, "fee_fixed_minor": m.fee_fixed_minor, "tax_bps": m.tax_bps, "settlement_cycle_days": 1,
                    "created_at": at(1200), "updated_at": at(1200),
                }
                for m in WORLD.merchants.values()
            ]
        )
        .on_conflict_do_nothing()
    )
    await session.execute(
        pg_insert(Customer)
        .values(
            [
                {
                    "id": c.id, "name": c.name, "email_masked": mask_email(c.email), "phone_masked": mask_phone(c.phone), "risk_flags": [],
                    "created_at": at(c.age_days), "updated_at": at(c.age_days),
                }
                for c in _ROWS
            ]
        )
        .on_conflict_do_nothing()
    )
    await session.execute(
        pg_insert(Device)
        .values([{"id": c.device_id, "customer_id": c.id, "fingerprint": c.fingerprint, "ip_country": "IN", "first_seen_at": at(c.age_days)} for c in _ROWS])
        .on_conflict_do_nothing()
    )
    return WORLD
