"""Background traffic: healthy payments spread over the last three days so tables look real. Noise must never open a
case; the scenario tests assert that."""

from __future__ import annotations

from datetime import timedelta

from ..domain.ids import IdGenerator
from .checkout import CardDetails, CheckoutOptions, checkout
from .context import ScenarioContext

PAYMENT_METHODS = ("CARD", "UPI", "NETBANKING", "WALLET")
CARD_NETWORKS = ("VISA", "MASTERCARD", "RUPAY", "AMEX")
_MERCHANT_KEYS = ("kavya", "northwind", "tandem")
_MIN_AGE_MS = 15 * 60 * 1000
_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

#: Rupee amounts typical for each merchant, in whole rupees.
_AMOUNT_RANGE_RUPEES = {"kavya": (499, 45_000), "northwind": (149, 4_500), "tandem": (1_800, 38_000)}


def _amount_for(ids: IdGenerator, key: str) -> int:
    low, high = _AMOUNT_RANGE_RUPEES[key]
    rupees = ids.int(low, high)
    # Most prices end in 9 or 0; keep paise at 00 so amounts read like real prices.
    return (rupees - (rupees % 10) + ids.pick([0, 9, 9, 9])) * 100


async def write_noise(ctx: ScenarioContext, count: int) -> None:
    ids = ctx.ids
    for _ in range(count):
        key = ids.pick(_MERCHANT_KEYS)
        at = ctx.now - timedelta(milliseconds=ids.int(_MIN_AGE_MS, _MAX_AGE_MS))
        method = ids.pick(PAYMENT_METHODS)
        amount = _amount_for(ids, key)
        customer = ids.pick(ctx.world.customers)
        card = CardDetails(ids.pick(CARD_NETWORKS), "IN", str(ids.int(1000, 9999))) if method == "CARD" else None
        # One batch per merchant per capture day, like a real T+1 settlement file.
        await checkout(
            ctx,
            CheckoutOptions(
                amount_minor=amount,
                at=at,
                customer=customer,
                merchant=ctx.world.merchants[key],
                method=method,
                card=card,
                batch_group=f"noise:{at.date().isoformat()}",
            ),
        )
