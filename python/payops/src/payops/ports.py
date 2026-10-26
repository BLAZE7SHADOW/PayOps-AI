"""Ports: what the domain and services need from the outside world, so tests can replace them (docs/02 §3)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from .domain.timeutil import now_utc


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return now_utc()


class FixedClock:
    """A clock that always answers the same instant. Contract and unit tests use it."""

    def __init__(self, moment: datetime) -> None:
        self._moment = moment

    def now(self) -> datetime:
        return self._moment


class EventPublisher(Protocol):
    """Pushes realtime events to the web app's rooms (`ops`, `case:<id>`)."""

    def publish(self, room: str, event: str, payload: Any) -> None: ...


class NoopPublisher:
    def publish(self, room: str, event: str, payload: Any) -> None:
        return None


@dataclass(frozen=True)
class Choice:
    """A question with one answer out of named options, and what each option means."""

    question: str
    criteria: dict[str, str]


@dataclass(frozen=True)
class Noul:
    """A yes-or-no question answered as a probability (0 to 1)."""

    question: str


class DecisionPort(Protocol):
    """Jev (TypeSafe System One), docs/03 §4. Every decision point asks a narrow, typed question set; the caller always has a deterministic fallback for when
    this raises (timeout, error, or a REPLAY miss). `ask` returns the answer for each question name: `.choice` for a Choice, `.noul` for a Noul."""

    async def ask(self, tag: str, state: Any, questions: dict[str, Choice | Noul]) -> dict[str, Any]: ...
