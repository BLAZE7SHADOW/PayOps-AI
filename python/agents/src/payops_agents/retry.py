"""A bounded retry for transient provider outages (packages/core provider-retry.ts). REPLAY never uses it."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

import httpx

T = TypeVar("T")
Reason = Literal["rate_limited", "unavailable", "timeout", "network"]


@dataclass
class RetryNotice:
    provider: str
    attempt: int
    max_attempts: int
    delay_ms: int
    reason: Reason
    step: str | None = None


RetrySink = Callable[[RetryNotice], Awaitable[None]]


class ProviderHttpError(Exception):
    def __init__(self, status: int, body: str = "", retry_after_ms: int | None = None) -> None:
        super().__init__(f"provider answered {status}: {body[:200]}")
        self.status = status
        self.retry_after_ms = retry_after_ms


def transient_provider_reason(error: BaseException) -> Reason | None:
    status: Any = getattr(error, "status", None) or getattr(error, "status_code", None) or getattr(error, "code", None)
    if isinstance(error, httpx.TimeoutException) or isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError, ConnectionError)):
        return "network"
    if isinstance(status, int):
        if status == 429:
            return "rate_limited"
        if status in (408, 504):
            return "timeout"
        if 500 <= status < 600:
            return "unavailable"
    return None


async def with_provider_retry(
    provider: str,
    call: Callable[[], Awaitable[T]],
    on_retry: RetrySink | None = None,
    step: str | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    max_attempts = 3
    attempt = 1
    while True:
        try:
            return await call()
        except Exception as error:  # noqa: BLE001 - classified below, anything else is re-raised
            reason = transient_provider_reason(error)
            if reason is None or attempt >= max_attempts:
                raise
            retry_after = getattr(error, "retry_after_ms", None)
            if reason == "rate_limited" and retry_after is not None:
                delay_ms = min(5000, max(0, int(retry_after)))
            else:
                delay_ms = 250 * 2 ** (attempt - 1)
            if on_retry:
                await on_retry(RetryNotice(provider, attempt, max_attempts, delay_ms, reason, step))
            await sleep(delay_ms / 1000)
            attempt += 1
