"""Prefixed, human-scannable identifiers. Random ids use `secrets`; seeded ids use a deterministic PRNG so simulator
output is reproducible.

`mulberry32` and `hash_seed` reproduce the TypeScript versions bit for bit (32-bit unsigned maths), so a seed gives the
same ids in both."""

from __future__ import annotations

import secrets
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Final, TypeVar

T = TypeVar("T")

ID_PREFIX: Final = {
    "payment": "pay",
    "gwPayment": "gwp",
    "order": "ord",
    "refund": "rfd",
    "gwRefund": "gwr",
    "ledgerEntry": "led",
    "settlementBatch": "stb",
    "merchant": "mer",
    "customer": "cus",
    "device": "dev",
    "webhookEvent": "evt",
    "attempt": "att",
    "case": "case",
    "run": "run",
    "user": "usr",
    "note": "note",
    "dispute": "dsp",
    "execution": "exe",
    "approval": "apr",
    "audit": "aud",
    "journal": "jrn",
    "settlementLine": "sln",
    "resolution": "rsl",
    "validation": "val",
    "agentStep": "ast",
    "agentFinding": "afd",
    "evidenceRow": "evr",
    "diagnosisFeedback": "dfb",
    "savedView": "viw",
}

_ALPHABET: Final = "0123456789abcdefghjkmnpqrstvwxyz"  # Crockford-ish, no i/l/o/u
_MASK: Final = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _MASK


def mulberry32(seed: int) -> Callable[[], float]:
    """Tiny deterministic PRNG. Good enough for fixtures, not for secrets."""
    state = seed & _MASK

    def next_float() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _MASK
        t = state
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _MASK
        return ((t ^ (t >> 14)) & _MASK) / 4294967296

    return next_float


def hash_seed(text: str) -> int:
    """FNV-1a over UTF-16 code units, as JavaScript's `charCodeAt` sees the string."""
    h = 2166136261
    data = text.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = _imul(h, 16777619)
    return h & _MASK


def _random_chars(length: int, next_float: Callable[[], float]) -> str:
    return "".join(_ALPHABET[int(next_float() * len(_ALPHABET))] for _ in range(length))


def _crypto_next() -> float:
    return secrets.randbits(32) / 4294967296


def new_id(kind: str, length: int = 14) -> str:
    return f"{ID_PREFIX[kind]}_{_random_chars(length, _crypto_next)}"


@dataclass
class IdGenerator:
    """Deterministic id and value generator for the simulator and tests."""

    _rng: Callable[[], float]

    def next(self, kind: str) -> str:
        return f"{ID_PREFIX[kind]}_{_random_chars(14, self._rng)}"

    def int(self, min_inclusive: int, max_inclusive: int) -> int:
        return min_inclusive + int(self._rng() * (max_inclusive - min_inclusive + 1))

    def pick(self, items: Sequence[T]) -> T:
        if not items:
            raise ValueError("pick() on empty list")
        return items[int(self._rng() * len(items))]

    def float(self) -> float:
        return self._rng()


def seeded_ids(seed: int | str) -> IdGenerator:
    return IdGenerator(mulberry32(hash_seed(seed) if isinstance(seed, str) else seed))


def case_display_id(prefix: str, seq: int) -> str:
    """Case display ids look like PAY-8291 / RFD-1042 / STL-3310 / RSK-0932 / DUP-5521."""
    return f"{prefix}-{seq:04d}"
