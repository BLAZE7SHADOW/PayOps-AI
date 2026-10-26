"""Ports: what the domain and services need from the outside world, so tests can replace them (docs/02 §3)."""

from __future__ import annotations

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
