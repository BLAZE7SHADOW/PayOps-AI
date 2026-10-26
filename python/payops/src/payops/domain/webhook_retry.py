"""Retry policy for inbound webhooks that our consumer failed to process (D072). A failed event is retried after 1
minute, 5 minutes, 30 minutes, then 2 hours. After WEBHOOK_MAX_ATTEMPTS total attempts (the first delivery counts) it is
marked DEAD and only a person can replay it."""

from __future__ import annotations

from typing import Final

WEBHOOK_MAX_ATTEMPTS: Final = 5
WEBHOOK_RETRY_DELAYS_SECONDS: Final = (60, 300, 1800, 7200)


def webhook_retry_delay_seconds(attempts_so_far: int) -> int | None:
    """Seconds to wait before the next automatic attempt, or None when the event is out of attempts."""
    if attempts_so_far < 1 or attempts_so_far >= WEBHOOK_MAX_ATTEMPTS:
        return None
    return WEBHOOK_RETRY_DELAYS_SECONDS[attempts_so_far - 1]


def is_webhook_success(http_status: int | None) -> bool:
    """A consumer answer counts as processed only for 2xx. 409 and 5xx are failures worth retrying."""
    return http_status is not None and 200 <= http_status < 300
