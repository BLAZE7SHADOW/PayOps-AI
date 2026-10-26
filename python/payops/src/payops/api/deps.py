from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..container import Services
from ..errors import AppError


def get_services(request: Request) -> Services:
    return request.app.state.services  # type: ignore[no-any-return]


async def get_session(services: Annotated[Services, Depends(get_services)]) -> AsyncIterator[AsyncSession]:
    """One session per request. Read routes never commit; write routes commit through `transaction`."""
    async with services.sessions() as session:
        yield session


ServicesDep = Annotated[Services, Depends(get_services)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]


_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def ident(value: str, name: str = "id") -> str:
    """A path id like `case_abc123`. Anything else is a 400 and never reaches the database."""
    if not _ID.match(value):
        raise AppError("BAD_REQUEST", f"Invalid {name}")
    return value
