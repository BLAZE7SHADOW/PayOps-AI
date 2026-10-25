"""Typed application errors. The API's error handler maps them to the JSON the web app expects."""

from __future__ import annotations

from typing import Any, Literal

ErrorCode = Literal[
    "BAD_REQUEST",
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "INVALID_TRANSITION",
    "VERSION_CONFLICT",
    "RATE_LIMITED",
    "UNSUPPORTED_MEDIA_TYPE",
    "INTERNAL",
]

STATUS: dict[str, int] = {
    "BAD_REQUEST": 400,
    "VALIDATION_FAILED": 422,
    "UNAUTHENTICATED": 401,
    "FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "CONFLICT": 409,
    "INVALID_TRANSITION": 409,
    "VERSION_CONFLICT": 409,
    "RATE_LIMITED": 429,
    "UNSUPPORTED_MEDIA_TYPE": 415,
    "INTERNAL": 500,
}


class AppError(Exception):
    def __init__(self, code: ErrorCode, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details
        self.status = STATUS[code]


def not_found(what: str, id_: str) -> AppError:
    return AppError("NOT_FOUND", f"{what} {id_} not found")
